// THE APPLICATION SERVICE the assistant route calls, through its HTTP boundary (http.ts), and nothing else calls: one function from (the server session, the request body) to the public
// response (api-contract.ts). It is not a route and renders nothing. It is the only place that composes, in order:
//
//   session -> user          the user id comes from the server session, never from the body
//   body    -> messages      AssistantApiRequest: the person's messages and nothing else
//   config  -> recipient     readProviderTarget: enabled, external, exactly one approved recipient
//   store   -> consent       the person's authorization is READ FROM THE DATABASE (authorization-store.ts), never from the request
//   plan                     planModelAccess: consent, validity, user, profile, recipient, data classes, before anything counts
//   limits  -> run           RunLimiter.acquire (PostgreSQL by default): per-user runs, concurrency and tokens, and the global
//                            concurrency cap, atomically across instances; the slot is the run's audit row (docs/decisions/0003)
//   run                      askExternal -> askAssistant -> runAssistant -> tool gate -> real tools -> egress filter -> model guard
//                            -> the configured provider -> grounded Answer
//   audit                    RunLimiter.release: the outcome, counts, tools called, tokens, timing, as codes
//
// Order matters, and is pinned by tests: the session, the body and the configuration are checked first; then the person's consent;
// only then the limits. So an unauthorized request never takes a slot or learns anything about limits, and a request refused by a
// limit never reaches the model provider. The time used everywhere is `deps.now`.
//
// Every refusal is typed and becomes a stable public code with a fixed message. Every attempt by a signed-in person is recorded
// (refused ones as "rejected"). Nothing here logs: it emits metadata-only events (events.ts) to an optional sink.
// No automatic retries: a retryable failure is returned as retryable, and nothing is sent twice without a new request.
import { randomUUID } from "node:crypto";
import { MAX_USER_MESSAGES } from "./ask";
import { policyFromConfig } from "./config";
import type { AssistantConfig } from "./config";
import { EXTERNAL_PROFILE, askExternal } from "./external";
import { MAX_MESSAGE_CHARS, ModelProviderError } from "./model";
import type { ModelCallInfo } from "./model";
import { OrchestratorError } from "./orchestrator";
import type { ToolActivity } from "./orchestrator";
import { readProviderTarget } from "./provider";
import type { ProviderDriver } from "./provider";
import { providerDriverFor } from "./provider-registry";
import { toAssistantApiError } from "./api-contract";
import type { AssistantApiResponse } from "./api-contract";
import { findAssistantAuthorization } from "./authorization-store";
import { STALE_RUN_GRACE_MS, createPostgresRunLimiter, recordRejectedRun, recordRunPlan } from "./run-store";
import type { AssistantEvent, AssistantEventSink } from "./events";
import { planModelAccess } from "@/lib/assistant/access-plan";
import { AssistantAuthorizationError } from "@/lib/assistant/authorization";
import type { AssistantAuthorization } from "@/lib/assistant/authorization";
import { AssistantRateLimitError } from "@/lib/assistant/run-limits";
import type { RunLimiter } from "@/lib/assistant/run-limits";
import { NotAuthenticatedError } from "../errors";

export type AssistantServiceDeps = {
  /**
   * The server's configuration, or a function that reads it. A function is called at step 3, so a configuration that cannot even be read
   * is refused, and recorded, exactly like one that is read but invalid.
   */
  config: AssistantConfig | (() => AssistantConfig);
  /**
   * The provider's wire parts. Defaults to the driver registry's choice for the configuration's MODEL_WIRE_FORMAT
   * (provider-registry.ts), made at step 3, so an unusable format is refused and recorded before consent is read. Tests may pass
   * another (a recording provider). It never chooses the endpoint, model or recipient.
   */
  driver?: ProviderDriver;
  /** Milliseconds since the epoch; defaults to the server clock. */
  now?: () => number;
  /** Where metadata-only events go. None by default. */
  onEvent?: AssistantEventSink;
  /** The run limiter. Defaults to the PostgreSQL limiter built from the configuration's limits; tests may pass another. */
  limiter?: RunLimiter;
  /**
   * Cancels the run from outside: the HTTP boundary passes the client's connection (request.signal). Once aborted, no further model call
   * is made and an in-flight one is aborted (the model guard), and the run ends as request_cancelled, released like any other.
   */
  signal?: AbortSignal;
};

/** The only fields a request body may have. */
const BODY_FIELDS = ["messages"];

/** The class and code of an error, never its message: e.g. "OrchestratorError:unknown_tool". */
function kindOf(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "Unknown";
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? `${name}:${code}` : name;
}

function readBody(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== BODY_FIELDS.length || !BODY_FIELDS.every((k) => keys.includes(k))) return null;
  const { messages } = body as { messages: unknown };
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_USER_MESSAGES) return null;
  if (!messages.every((m) => typeof m === "string" && m.trim() !== "" && m.length <= MAX_MESSAGE_CHARS)) return null;
  return [...messages];
}

const TOOL_DENIALS = new Set(["unknown_tool", "malformed_tool_arguments", "invalid_tool_arguments"]);

export async function handleAssistantRequest(session: unknown, body: unknown, deps: AssistantServiceDeps): Promise<AssistantApiResponse> {
  const now = deps.now ?? Date.now;
  const requestId = randomUUID();
  const emit = (event: AssistantEvent) => {
    try {
      deps.onEvent?.(event);
    } catch {
      // A broken sink must not change the outcome of a request.
    }
  };
  emit({ type: "assistant_request", requestId, at: now() });

  const fail = (error: unknown, event: "authorization_failure" | "request_rejected" | "rate_limit_rejection"): AssistantApiResponse => {
    const publicError = toAssistantApiError(error);
    emit({ type: event, requestId, code: publicError.code });
    return Object.freeze({ ok: false as const, error: publicError });
  };

  // 1. The user, from the server session only.
  const userId = typeof session === "object" && session !== null ? (session as { userId?: unknown }).userId : undefined;
  if (typeof userId !== "string" || userId.trim() === "") return fail(new NotAuthenticatedError(), "authorization_failure");

  /** Record a refusal before a run starts, and answer it. If even the audit row cannot be written, the answer is still a refusal. */
  const reject = async (error: unknown, event: "authorization_failure" | "request_rejected" | "rate_limit_rejection", authorizationId?: string) => {
    try {
      await recordRejectedRun(userId, { mode: "external", resultCode: toAssistantApiError(error).code, failureKind: kindOf(error), at: new Date(now()), authorizationId: authorizationId ?? null });
    } catch {
      emit({ type: "audit_failure", requestId, runId: null, stage: "reject" });
    }
    return fail(error, event);
  };

  // 2. The body: the person's messages, nothing else.
  const messages = readBody(body);
  if (messages === null) return reject(new OrchestratorError("invalid_input", "The request must be { messages: [the person's words] }."), "request_rejected");

  // 3. The configuration decides the recipient; the configuration's limits decide how much the person may run.
  let target: ReturnType<typeof readProviderTarget>;
  let limiter: RunLimiter;
  let driver: ProviderDriver;
  try {
    target = readProviderTarget(typeof deps.config === "function" ? deps.config() : deps.config);
    driver = deps.driver ?? providerDriverFor(target.config);
    // A limiter without a complete set of limits refuses to exist: the request fails closed here, before consent is even read.
    limiter = deps.limiter ?? createPostgresRunLimiter(target.config.limits, { mode: "external", staleAfterMs: (policyFromConfig(target.config).runBudgetMs ?? 0) + STALE_RUN_GRACE_MS });
  } catch (error) {
    return reject(error, "request_rejected");
  }

  // 4. The person's consent, read from the database, and the plan it permits, before anything counts or runs.
  // The authorization read here is the one the run uses: it is read once, so a revocation cannot race between check and use.
  let plan: ReturnType<typeof planModelAccess>;
  let authorization: AssistantAuthorization;
  let consultedId: string | undefined;
  try {
    const lookup = await findAssistantAuthorization(userId, { profileId: EXTERNAL_PROFILE.id, recipient: target.recipient });
    if (lookup.status === "none") throw new AssistantAuthorizationError("consent_not_given");
    if (lookup.status === "revoked") {
      consultedId = lookup.authorizationId;
      throw new AssistantAuthorizationError("authorization_revoked");
    }
    authorization = lookup.authorization;
    consultedId = authorization.authorizationId;
    plan = planModelAccess(EXTERNAL_PROFILE, authorization, { userId, recipient: target.recipient, now: now() }, target.config.approvedRecipients);
  } catch (error) {
    if (error instanceof AssistantAuthorizationError) return reject(error, "authorization_failure", consultedId);
    return reject(error, "request_rejected");
  }
  const authorizationId = authorization.authorizationId;

  // 5. The per-user limits, atomically; a run that may start is recorded as "running".
  const started = now();
  let runId: string;
  try {
    runId = await limiter.acquire(userId, new Date(started));
  } catch (error) {
    if (error instanceof AssistantRateLimitError) return fail(error, "rate_limit_rejection");
    emit({ type: "audit_failure", requestId, runId: null, stage: "begin" });
    return fail(error, "request_rejected");
  }
  // From here on the slot is held: whatever happens, the `finally` below releases it with the outcome.
  let response: AssistantApiResponse = Object.freeze({ ok: false as const, error: toAssistantApiError(null) });
  let failure: unknown = null;
  let modelCalls = 0;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let toolCalls = 0;
  let toolRefusals = 0;
  const toolsCalled: string[] = [];
  try {
    try {
      await recordRunPlan(runId, userId, {
        authorizationId,
        profileId: plan.audit.profileId,
        recipient: plan.audit.recipient,
        modelId: target.config.modelId,
        allowedTools: plan.allowedTools,
        visibleClasses: plan.audit.visibleClasses,
        inventoryVersion: plan.audit.inventoryVersion,
      });
    } catch {
      emit({ type: "audit_failure", requestId, runId, stage: "plan" });
    }
    emit({ type: "run_started", requestId, runId, profileId: plan.audit.profileId, recipient: plan.audit.recipient, modelId: target.config.modelId, allowedTools: [...plan.allowedTools], visibleClasses: [...plan.audit.visibleClasses] });

    // 6. The run, through the one external path; its metadata is counted for the audit.
    const onModelCall = (info: ModelCallInfo) => {
      modelCalls += 1;
      if (info.inputTokens !== null) inputTokens = (inputTokens ?? 0) + info.inputTokens;
      if (info.outputTokens !== null) outputTokens = (outputTokens ?? 0) + info.outputTokens;
      emit({ type: "model_call", requestId, runId, outcome: info.outcome, durationMs: info.durationMs, inputTokens: info.inputTokens, outputTokens: info.outputTokens });
    };
    const onToolActivity = (activity: ToolActivity) => {
      toolCalls += 1;
      if (activity.outcome === "refused") toolRefusals += 1;
      toolsCalled.push(activity.tool);
      emit({ type: "tool_call", requestId, runId, tool: activity.tool, outcome: activity.outcome, reason: activity.reason });
    };
    try {
      const answer = await askExternal(target.config, { userId, userMessages: messages }, { driver, authorization, now: now(), onModelCall, onToolActivity, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
      response = Object.freeze({ ok: true as const, answer });
    } catch (error) {
      failure = error;
      response = Object.freeze({ ok: false as const, error: toAssistantApiError(error) });
      const code = (error as { code?: unknown }).code;
      if (error instanceof ModelProviderError && (code === "timeout" || code === "budget_exceeded")) emit({ type: "timeout", requestId, runId, code: String(code) });
      else if (error instanceof ModelProviderError) emit({ type: "provider_failure", requestId, runId, code: String(code) });
      else if (error instanceof OrchestratorError && TOOL_DENIALS.has(String(code))) emit({ type: "tool_denial", requestId, runId, code: String(code) });
    }
  } catch (error) {
    // Anything unexpected outside the run itself (a broken clock, say) still ends in a failed, released run.
    failure = error;
    response = Object.freeze({ ok: false as const, error: toAssistantApiError(error) });
  } finally {
    // 7. Release the slot, always, with the audit record of the outcome. If even that fails, the slot stops counting as in progress once
    //    the run's budget has passed (the limiter's staleness rule), so it cannot stay stuck.
    let finished = started;
    try {
      finished = now();
    } catch {
      // keep the start time: the release must still happen
    }
    try {
      await limiter.release(runId, userId, {
        status: response.ok ? "succeeded" : "failed",
        resultCode: response.ok ? null : response.error.code,
        failureKind: failure === null ? null : kindOf(failure),
        answerState: response.ok ? response.answer.state : null,
        modelCalls,
        toolCalls,
        toolRefusals,
        toolsCalled,
        inputTokens,
        outputTokens,
        durationMs: finished - started,
        finishedAt: new Date(finished),
      });
    } catch {
      emit({ type: "audit_failure", requestId, runId, stage: "finish" });
    }
    emit({ type: "run_completed", requestId, runId, status: response.ok ? "succeeded" : "failed", code: response.ok ? null : response.error.code, answerState: response.ok ? response.answer.state : null, durationMs: finished - started });
  }
  return response;
}
