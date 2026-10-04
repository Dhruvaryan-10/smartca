// THE ONE PROVIDER DRIVER: the provider-specific wire parts (provider.ts, ProviderDriver) for the OpenAI-compatible Chat Completions
// format. It is a wire FORMAT, not a vendor choice: which service answers is still only the configuration's MODEL_ENDPOINT (the full
// URL of a chat-completions endpoint), MODEL_ID and MODEL_API_KEY, and which provider or router that is remains an open decision
// (SECURITY.md, "Open decisions"). No SDK or package is used; the transport is the platform `fetch`, injectable so that no test needs a
// key or a network.
//
//   ModelRequest + configured model id and output-token cap -> encode -> { model, messages, tools?, <token field>, store: false }
//                                                                          (nothing else: no user, no metadata, no key)
//   `store: false` is sent on EVERY request, whatever the wire format: OpenAI stores Chat Completions by default on new accounts (for its
//   distillation and evals products, docs/decisions/0002 "Provider assessment: OpenAI API"), so SmartCA opts out explicitly rather than
//   relying on an account setting. It is a constant, not configuration: no request, caller, tool or model answer can change it.
//   The cap's wire field is chosen HERE and nowhere else: "max_completion_tokens" (OpenAI's current field; the older "max_tokens" is
//   deprecated there and refused by its reasoning models) or "max_tokens" (what many compatible servers and gateways still require).
//   The driver is built with exactly one of them (the registry picks it from MODEL_WIRE_FORMAT); a request carries that one, never both.
//   transport: POST to the configured endpoint, no redirects, the guard's deadline and abort signal, a bounded response body
//   2xx body -> decode -> exactly one assistant choice, finished normally -> text, or tool calls with parsed arguments; the model the
//   provider names (required; the adapter refuses any but the configured one) and its token counts
//
// What decoding refuses, so that the adapter reports invalid_response: a body that is not JSON; no model named; not exactly one choice;
// a message not from "assistant"; a refusal; an answer cut off (finish_reason "length") or filtered ("content_filter"), or any other
// finish; a tool call that is not a function call or whose name or argument text is not text; text that is not text. The model guard then
// checks the result again against the model contract (tool names, call count, sizes) and the approved recipient.
//
// Usage (readChatCompletionUsage) is read separately and judges nothing: the model the body names and its `usage` counts, so that an
// answer refused above may still be counted (the adapter trusts it only for the configured model).
//
// It imports only the model contract at runtime. It never sees a user id, a session, a database handle or an authorization: the
// ProviderDriver interface gives it the ModelRequest, the configured target, the configured key (for the header only) and the wire.
import { parseToolArguments } from "./model";
import type { ModelMessage, ModelRequest, ModelToolCall, ToolArguments } from "./model";
import type { ProviderDecoded, ProviderDriver, ProviderUsage, ProviderWireRequest, ProviderWireResponse } from "./provider";
import type { Secret } from "./config";

/** The largest response body read from the provider. Anything longer is not read to the end, and the call fails. */
export const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);

/** Decoding failed. Its message is fixed text about the SHAPE, never the provider's content; the adapter drops it anyway. */
class UndecodableResponse extends Error {
  constructor(what: string) {
    super(`The chat completion ${what}.`);
    this.name = "UndecodableResponse";
  }
}
const bad = (what: string): never => {
  throw new UndecodableResponse(what);
};

// ---------------------------------------------------------------------
// encode: fields are picked one by one, so nothing but the listed ones can cross
// ---------------------------------------------------------------------

const argumentsText = (args: ToolArguments): string => (args.kind === "json" ? JSON.stringify(args.value) : args.raw);

const wireCall = (call: ModelToolCall) => ({ id: call.id, type: "function", function: { name: call.name, arguments: argumentsText(call.arguments) } });

function wireMessage(m: ModelMessage): Json {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return m.toolCalls === undefined || m.toolCalls.length === 0
        ? { role: "assistant", content: m.content }
        : { role: "assistant", content: m.content === "" ? null : m.content, tool_calls: m.toolCalls.map(wireCall) };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

/** The request field that carries the output-token cap. Only this file names them. */
export const CHAT_COMPLETIONS_TOKEN_FIELDS = ["max_completion_tokens", "max_tokens"] as const;
export type ChatCompletionsTokenField = (typeof CHAT_COMPLETIONS_TOKEN_FIELDS)[number];

export function encodeChatCompletion(request: ModelRequest, target: { modelId: string; maxOutputTokens: number }, tokenField: ChatCompletionsTokenField = "max_tokens"): string {
  // Never send a request without a usable cap: the adapter turns this into a ModelRequestError and sends nothing.
  if (!Number.isSafeInteger(target.maxOutputTokens) || target.maxOutputTokens < 1) throw new Error("The output-token cap is not a positive whole number.");
  if (!(CHAT_COMPLETIONS_TOKEN_FIELDS as readonly string[]).includes(tokenField)) throw new Error("The output-token field is not a known one.");
  const tools = request.tools ?? [];
  return JSON.stringify({
    model: target.modelId,
    messages: request.messages.map(wireMessage),
    ...(tools.length === 0 ? {} : { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }),
    [tokenField]: target.maxOutputTokens,
    // Never stored by the provider as a stored completion (see the header). Last, so nothing above can override it.
    store: false,
  });
}

// ---------------------------------------------------------------------
// decode: exactly one normally finished assistant choice, or nothing
// ---------------------------------------------------------------------

function decodeCall(value: unknown): ModelToolCall {
  if (!isObject(value) || value.type !== "function" || typeof value.id !== "string" || !isObject(value.function)) return bad("has a tool call that is not a function call");
  const { name, arguments: args } = value.function;
  if (typeof name !== "string" || typeof args !== "string") return bad("has a tool call without a name or argument text");
  return { id: value.id, name, arguments: parseToolArguments(args) };
}

const TOOL_CALL_MARKUP = /<\/?tool_call>/i;

export function decodeChatCompletion(body: string): ProviderDecoded {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return bad("is not JSON");
  }
  if (!isObject(parsed)) return bad("is not an object");
  if (typeof parsed.model !== "string" || parsed.model === "") return bad("names no model");
  if (!Array.isArray(parsed.choices) || parsed.choices.length !== 1) return bad("does not have exactly one choice");
  const choice = parsed.choices[0];
  if (!isObject(choice) || !isObject(choice.message)) return bad("has no message");
  const message = choice.message;
  if (message.role !== "assistant") return bad("is not from the assistant");
  if (message.refusal !== undefined && message.refusal !== null) return bad("is a refusal");

  const calls = message.tool_calls;
  let response: Json;
  if (Array.isArray(calls) && calls.length > 0) {
    // Some compatible services finish a tool-calling turn with "stop"; both mean the turn ended normally.
    if (choice.finish_reason !== "tool_calls" && choice.finish_reason !== "stop") return bad("did not finish normally");
    response = { kind: "tool_calls", calls: calls.map(decodeCall) };
  } else {
    if (calls !== undefined && calls !== null && !Array.isArray(calls)) return bad("has tool calls that are not a list");
    if (choice.finish_reason !== "stop") return bad("did not finish normally");
    if (typeof message.content !== "string") return bad("has no text");
    // A tool call written as text (the <tool_call> markup some open models emit when the server does not parse it) is neither an
    // answer nor a call: refuse it rather than show markup, or a call that never ran, as the answer.
    if (TOOL_CALL_MARKUP.test(message.content)) return bad("wrote a tool call as text");
    response = { kind: "text", text: message.content };
  }

  return { response, model: parsed.model, ...usageOf(parsed) };
}

/** The usage counts a completion states (`usage.prompt_tokens`, `usage.completion_tokens`), each kept only if a whole number >= 0. */
function usageOf(parsed: Json): { inputTokens?: number; outputTokens?: number } {
  const usage = isObject(parsed.usage) ? parsed.usage : {};
  const inputTokens = count(usage.prompt_tokens);
  const outputTokens = count(usage.completion_tokens);
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
}

/**
 * The model and usage a 2xx body states, read WITHOUT judging the answer: a completion cut off ("length"), filtered, refused or
 * otherwise undecodable may still have been billed. Undefined unless the body is a JSON object naming a model and stating at least one
 * valid count. The adapter trusts it only when the model is the configured one.
 */
export function readChatCompletionUsage(body: string): ProviderUsage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || typeof parsed.model !== "string" || parsed.model === "") return undefined;
  const counts = usageOf(parsed);
  return counts.inputTokens === undefined && counts.outputTokens === undefined ? undefined : { model: parsed.model, ...counts };
}

// ---------------------------------------------------------------------
// transport: one POST, no redirect, bounded in time and size
// ---------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The provider answered, but with more than MAX_PROVIDER_RESPONSE_BYTES. The adapter reads only this NAME (as it does TimeoutError) and
 * reports invalid_response: an answer that cannot be used, not a service that is unavailable, so a client is not told to retry it.
 */
const tooLarge = () => Object.assign(new Error("The response is too large."), { name: "ResponseTooLarge" });

async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Sends one request with `fetchImpl`. It follows no redirect (the key must reach only the configured endpoint), stops at the earlier of
 * the caller's signal and `timeoutMs` (a timeout surfaces as a TimeoutError, which the adapter reports as `timeout`), and never reads
 * more than MAX_PROVIDER_RESPONSE_BYTES. A non-2xx answer's body is not read at all: only its status is used.
 */
export async function sendChatCompletion(request: ProviderWireRequest, fetchImpl: FetchLike): Promise<ProviderWireResponse> {
  const signals = [request.signal, request.timeoutMs === undefined ? undefined : AbortSignal.timeout(request.timeoutMs)].filter((s): s is AbortSignal => s !== undefined);
  const response = await fetchImpl(request.url, {
    method: "POST",
    headers: { ...request.headers },
    body: request.body,
    redirect: "error",
    ...(signals.length === 0 ? {} : { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }),
  });
  if (response.status < 200 || response.status > 299) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, body: "" };
  }
  return { status: response.status, body: await readCapped(response, MAX_PROVIDER_RESPONSE_BYTES) };
}

/**
 * The Chat Completions driver. `fetch` defaults to the platform's; tests pass a fake so that nothing leaves the process. `tokenField` is
 * the request field for the output-token cap; production code gets the driver from the registry (provider-registry.ts), which always
 * names it from MODEL_WIRE_FORMAT. The default ("max_tokens") exists for tests that build the driver directly.
 */
export function chatCompletionsDriver(options: { fetch?: FetchLike; tokenField?: ChatCompletionsTokenField } = {}): ProviderDriver {
  const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  const tokenField = options.tokenField ?? "max_tokens";
  if (!(CHAT_COMPLETIONS_TOKEN_FIELDS as readonly string[]).includes(tokenField)) throw new Error("The output-token field is not a known one.");
  return Object.freeze({
    encode: (request: ModelRequest, target: { modelId: string; maxOutputTokens: number }) => encodeChatCompletion(request, { modelId: target.modelId, maxOutputTokens: target.maxOutputTokens }, tokenField),
    decode: decodeChatCompletion,
    readUsage: readChatCompletionUsage,
    authHeaders: (apiKey: Secret) => ({ authorization: `Bearer ${apiKey.reveal()}` }),
    transport: (request: ProviderWireRequest) => sendChatCompletion(request, fetchImpl),
  });
}
