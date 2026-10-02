// THE PROVIDER BOUNDARY: how a real model provider is reached, with everything that decides WHERE a request goes taken from the server's
// configuration and nothing else. No provider is chosen here and none is installed: the provider-specific parts (the wire format, the
// authentication header, the transport) are a ProviderDriver that server code supplies. PURE: it imports only the model contract and
// the configuration types, and makes no network call itself (the driver's transport does); a test pins that.
//
//   server configuration (endpoint, model id, key, the one approved recipient, output-token cap, limits)  +  a ProviderDriver
//     (the one driver that exists: provider-chat-completions.ts, the OpenAI-compatible Chat Completions wire format)
//     -> createProviderAdapter -> a ModelAdapter
//          complete(ModelRequest) -> driver.encode -> driver.transport({ url, headers, body }) -> status -> driver.decode -> ModelResponse
//
// What the adapter receives and what the provider sees: ONLY the ModelRequest the orchestrator built (the system prompt, the
// conversation, the allowed tools' definitions and the already-filtered tool results) plus the configured model id and output-token cap
// (MODEL_MAX_OUTPUT_TOKENS: the most the provider may generate per call, from the configuration only; no caller, request or model
// answer can set or change it, and the driver alone decides which wire field carries it). There is no user
// id, session, database handle, authorization object or SmartCA credential anywhere in reach; the provider's own key is sent only as
// the driver's authentication header, never in the body, a log or an error.
//
// Every failure is a typed ModelProviderError with a fixed message (model.ts) and nothing from the provider in it:
//   the transport times out         -> timeout      (a TimeoutError, e.g. from AbortSignal.timeout; only the error's name is read)
//   the transport's ResponseTooLarge -> invalid_response (the provider answered with more than the driver reads; not retryable)
//   the transport throws otherwise  -> unavailable
//   401 or 403                      -> authentication_failed
//   408 or 504                      -> timeout
//   429                             -> rate_limited
//   any other 4xx                   -> refused
//   5xx, or any other non-2xx       -> unavailable
//   a 2xx body that cannot be decoded, or that names a model other than the configured one -> invalid_response
// Token usage of a 2xx body is read (driver.readUsage) and reported to the guard (options.onUsage) BEFORE the answer is judged, so a
// refused answer the provider billed is still counted; only when the body names the configured model, and only counts that pass the
// usual whole-number check. Nothing is estimated: no body, no usage.
// The model guard (withModelGuard) still enforces the timeout, run budget, abort signal, output limit and approved recipient on top.
import { META_ID, ModelProviderError, ModelRequestError, MAX_MODEL_TIMEOUT_MS } from "./model";
import type { ModelAdapter, ModelCallOptions, ModelRequest } from "./model";
import { AssistantConfigError, MAX_MODEL_OUTPUT_TOKENS } from "./config";
import type { AssistantConfig, ExternalAssistantConfig, Secret } from "./config";

/** What goes over the wire. The body is the encoded request; the only secret is in the driver's authentication headers. */
export type ProviderWireRequest = Readonly<{
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;
export type ProviderWireResponse = Readonly<{ status: number; body: string }>;

/** What a provider's decoded answer carries: the response itself (validated by the model guard), and optional metadata. */
export type ProviderDecoded = { response: unknown; model?: string; inputTokens?: number; outputTokens?: number };

/** The model and token usage a 2xx body states, read without judging the answer. Counts only: no content. */
export type ProviderUsage = { model: string; inputTokens?: number; outputTokens?: number };

/**
 * The provider-specific parts, supplied by server code (a future registry keyed by configuration; tests use a recording fake). It
 * never decides the endpoint, the model, the key or the recipient: those come from the configuration.
 */
export type ProviderDriver = Readonly<{
  /** The provider's wire format for a request. `maxOutputTokens` is the configured per-call generation cap; it must be on the wire. */
  encode(request: ModelRequest, target: { modelId: string; maxOutputTokens: number; maxOutputChars?: number }): string;
  /** The provider's wire format for an answer. Throwing means the body could not be used. */
  decode(body: string): ProviderDecoded;
  /**
   * Optional: the model and usage a 2xx body states, in the provider's own usage shape, WITHOUT judging the answer (an answer that is cut
   * off, filtered or otherwise refused may still have been billed). Undefined when the body does not state them in that shape. A driver
   * without it reports no usage for a refused answer.
   */
  readUsage?(body: string): ProviderUsage | undefined;
  /** The provider's authentication headers for the configured key. */
  authHeaders(apiKey: Secret): Readonly<Record<string, string>>;
  /** Sends one request. The only place a network call can happen. */
  transport(request: ProviderWireRequest): Promise<ProviderWireResponse>;
}>;

type ExternalConfig = ExternalAssistantConfig;

/**
 * The external configuration, checked: enabled, env "external", and EXACTLY ONE approved recipient, which is the recipient every call
 * goes to (fallback recipients are an open decision, so none is allowed). A caller cannot pick another: there is no parameter for it.
 */
export function readProviderTarget(config: AssistantConfig): { config: ExternalConfig; recipient: string } {
  if (!config.enabled) throw new AssistantConfigError("assistant_disabled");
  if (config.env !== "external") throw new AssistantConfigError("invalid_configuration", ["ASSISTANT_ENV"]);
  if (config.approvedRecipients.length !== 1) throw new AssistantConfigError("invalid_configuration", ["MODEL_APPROVED_RECIPIENTS"]);
  // The model id is stated in every response's metadata, which the guard accepts only as a plain identifier (META_ID). MODEL_ID's own
  // shape is wider (it allows "/" and 128 characters), so an id outside META_ID would fail every call: refuse it here, before any call.
  if (!META_ID.test(config.modelId)) throw new AssistantConfigError("invalid_configuration", ["MODEL_ID"]);
  // The output-token cap is checked again here, so a configuration built past the validator cannot send an unbounded request.
  const cap = config.maxOutputTokens;
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_MODEL_OUTPUT_TOKENS) throw new AssistantConfigError("invalid_configuration", ["MODEL_MAX_OUTPUT_TOKENS"]);
  return { config: config as ExternalConfig, recipient: config.approvedRecipients[0] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

function statusError(status: number): ModelProviderError {
  if (status === 401 || status === 403) return new ModelProviderError("authentication_failed");
  if (status === 408 || status === 504) return new ModelProviderError("timeout");
  if (status === 429) return new ModelProviderError("rate_limited");
  if (status >= 400 && status < 500) return new ModelProviderError("refused");
  return new ModelProviderError("unavailable");
}

/** A ModelAdapter for the configured provider. Everything that addresses the request comes from `config`; `driver` only speaks the wire. */
export function createProviderAdapter(config: AssistantConfig, driver: ProviderDriver): ModelAdapter {
  const { config: target, recipient } = readProviderTarget(config);
  const url = target.endpoint;
  const modelId = target.modelId;
  const maxOutputTokens = target.maxOutputTokens;
  const timeoutCap = Math.min(target.timeoutMs, MAX_MODEL_TIMEOUT_MS);

  return {
    async complete(request: ModelRequest, options?: ModelCallOptions) {
      let body: string;
      try {
        body = driver.encode(request, { modelId, maxOutputTokens, ...(options?.maxOutputChars === undefined ? {} : { maxOutputChars: options.maxOutputChars }) });
      } catch {
        throw new ModelRequestError("The request could not be encoded for the model service.");
      }
      if (typeof body !== "string") throw new ModelRequestError("The request could not be encoded for the model service.");
      const headers = { "content-type": "application/json", ...driver.authHeaders(target.apiKey) };

      let wire: ProviderWireResponse;
      try {
        wire = await driver.transport({
          url,
          headers,
          body,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          timeoutMs: Math.min(options?.timeoutMs ?? timeoutCap, timeoutCap),
        });
      } catch (error) {
        // Whatever the transport threw (it may quote the request or the key) is dropped here, never passed on. Only its NAME is read:
        // the platform's own timeout (AbortSignal.timeout) is a TimeoutError, reported as the timeout it is; a driver's ResponseTooLarge
        // means the provider DID answer, with more than the driver will read, so it is an unusable answer (not retryable), not an outage.
        const name = isObject(error) ? error.name : undefined;
        throw new ModelProviderError(name === "TimeoutError" ? "timeout" : name === "ResponseTooLarge" ? "invalid_response" : "unavailable");
      }
      if (!isObject(wire) || typeof wire.status !== "number") throw new ModelProviderError("unavailable");
      if (wire.status < 200 || wire.status > 299) throw statusError(wire.status);
      if (typeof wire.body !== "string") throw new ModelProviderError("invalid_response");

      // Usage first, before the answer is judged, so that an answer refused below (or by the guard) is still counted. Only usage stated by
      // the CONFIGURED model is vouched for: another model's, or a body naming none, is not this recipient's bill. Counts only, through the
      // guard's callback: nothing of the body reaches an error.
      if (options?.onUsage !== undefined && driver.readUsage !== undefined) {
        let usage: unknown;
        try {
          usage = driver.readUsage(wire.body);
        } catch {
          usage = undefined;
        }
        const inputTokens = isObject(usage) && usage.model === modelId ? count(usage.inputTokens) : undefined;
        const outputTokens = isObject(usage) && usage.model === modelId ? count(usage.outputTokens) : undefined;
        if (inputTokens !== undefined || outputTokens !== undefined) {
          try {
            options.onUsage({ ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) });
          } catch {
            // Accounting must never change the outcome of a call.
          }
        }
      }

      let decoded: ProviderDecoded;
      try {
        decoded = driver.decode(wire.body);
      } catch {
        throw new ModelProviderError("invalid_response");
      }
      if (!isObject(decoded) || !isObject(decoded.response)) throw new ModelProviderError("invalid_response");
      // A provider that answers with another model than the one configured is not the recipient that was approved.
      if (decoded.model !== undefined && decoded.model !== modelId) throw new ModelProviderError("invalid_response");
      const inputTokens = count(decoded.inputTokens);
      const outputTokens = count(decoded.outputTokens);
      const { meta: _ignored, ...response } = decoded.response;
      void _ignored;
      return {
        ...response,
        meta: { recipient, model: modelId, ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) },
      } as never;
    },
  };
}
