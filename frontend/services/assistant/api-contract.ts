// THE APPLICATION CONTRACT the assistant API (POST /api/assistant, through services/assistant/http.ts) exposes. It is provider-neutral and UI-neutral: types for the request and the
// response, and one mapping from every typed assistant error to a stable public code. PURE (no database, no network, no provider;
// a test pins that). This is the shape the route returns; http.ts adds only the HTTP status (one per category).
//
//   request   { messages }                        what the person typed. The user comes from the server's session and the consent
//                                                 from the server's consent store, never from the request body.
//   success   { ok: true, answer }                the validated Answer (lib/assistant/answer.ts): the model's text, if released,
//                                                 kept apart from the tool facts it rests on. Tool activity is in the answer's facts
//                                                 and citations (tool, call id, round); raw tool results and arguments never are.
//   failure   { ok: false, error: { code, category, retryable, message } }
//
// A failure carries a stable code, a category, whether trying again could help, and a FIXED message for that code. It never carries
// the error's own message, a stack, a provider's text, a key, a header, an endpoint, a user id, or a value from the person's data.
import type { Answer } from "@/lib/assistant/answer";
import { AnswerInputError } from "@/lib/assistant/answer";
import { AssistantAuthorizationError } from "@/lib/assistant/authorization";
import { AssistantFailure } from "@/lib/assistant/failure";
import { AssistantProfileError } from "@/lib/assistant/profiles";
import { AssistantRateLimitError } from "@/lib/assistant/run-limits";
import { AssistantConfigError } from "./config";
import { ModelProviderError } from "./model";
import type { ModelErrorCode } from "./model";
import { OrchestratorError } from "./orchestrator";
import type { OrchestratorErrorCode } from "./orchestrator";
import { NotAuthenticatedError } from "../errors";

/** What a client sends. Nothing else is accepted: not a user, a profile, a tool list, a recipient, a model or a consent. */
export type AssistantApiRequest = { messages: string[] };

export type AssistantApiErrorCategory =
  | "authentication" // nobody is signed in
  | "consent" // the person's explicit authorization is missing, expired, withdrawn or does not fit this request
  | "rate_limit" // a per-user limit on runs, concurrency or usage was reached, or the assistant is at its global capacity
  | "validation" // the request itself is not acceptable
  | "configuration" // the server is not set up to serve this (disabled, misconfigured, recipient not approved)
  | "provider" // the model service failed
  | "assistant" // the model misbehaved or ran past the assistant's bounds
  | "internal"; // anything else

export const ASSISTANT_API_ERROR_CODES = [
  "not_authenticated",
  "consent_required",
  "consent_expired",
  "consent_revoked",
  "consent_invalid",
  "consent_outdated",
  "invalid_request",
  "assistant_unavailable",
  "assistant_misconfigured",
  "provider_not_approved",
  "rate_limited",
  "too_many_concurrent_runs",
  "usage_budget_exceeded",
  "assistant_busy",
  "provider_timeout",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_rejected",
  "provider_invalid_response",
  "provider_configuration",
  "model_limit_exceeded",
  "request_cancelled",
  "assistant_could_not_complete",
  "internal_error",
] as const;
export type AssistantApiErrorCode = (typeof ASSISTANT_API_ERROR_CODES)[number];

export type AssistantApiError = Readonly<{ code: AssistantApiErrorCode; category: AssistantApiErrorCategory; retryable: boolean; message: string }>;
export type AssistantApiResponse = Readonly<{ ok: true; answer: Answer }> | Readonly<{ ok: false; error: AssistantApiError }>;

const PUBLIC: Record<AssistantApiErrorCode, { category: AssistantApiErrorCategory; retryable: boolean; message: string }> = {
  not_authenticated: { category: "authentication", retryable: false, message: "Sign in to use the assistant." },
  consent_required: { category: "consent", retryable: false, message: "The assistant needs your explicit permission before it can use an external model." },
  consent_expired: { category: "consent", retryable: false, message: "Your permission for the assistant has expired. Grant it again to continue." },
  consent_invalid: { category: "consent", retryable: false, message: "Your permission for the assistant does not cover this request." },
  consent_revoked: { category: "consent", retryable: false, message: "You withdrew permission for the assistant. Grant it again to continue." },
  consent_outdated: { category: "consent", retryable: false, message: "What the assistant shares has changed since you gave permission. Review it and grant it again to continue." },
  rate_limited: { category: "rate_limit", retryable: true, message: "Too many assistant requests. Try again later." },
  too_many_concurrent_runs: { category: "rate_limit", retryable: true, message: "Another assistant request is still in progress. Try again when it finishes." },
  usage_budget_exceeded: { category: "rate_limit", retryable: true, message: "The assistant usage budget for now is used up. Try again later." },
  assistant_busy: { category: "rate_limit", retryable: true, message: "The assistant is busy right now. Try again shortly." },
  invalid_request: { category: "validation", retryable: false, message: "The request could not be accepted." },
  assistant_unavailable: { category: "configuration", retryable: false, message: "The assistant is not available." },
  assistant_misconfigured: { category: "configuration", retryable: false, message: "The assistant is not set up correctly." },
  provider_not_approved: { category: "configuration", retryable: false, message: "The model service is not approved for this request." },
  provider_timeout: { category: "provider", retryable: true, message: "The model service took too long to answer." },
  provider_rate_limited: { category: "provider", retryable: true, message: "The model service is busy. Try again shortly." },
  provider_unavailable: { category: "provider", retryable: true, message: "The model service is unavailable." },
  provider_rejected: { category: "provider", retryable: false, message: "The model service refused the request." },
  provider_invalid_response: { category: "provider", retryable: false, message: "The model service returned an answer that could not be used." },
  provider_configuration: { category: "provider", retryable: false, message: "The model service did not accept the assistant's configuration." },
  model_limit_exceeded: { category: "assistant", retryable: false, message: "The model's answer went past the allowed size." },
  request_cancelled: { category: "assistant", retryable: false, message: "The request was cancelled." },
  assistant_could_not_complete: { category: "assistant", retryable: false, message: "The assistant could not complete this request." },
  internal_error: { category: "internal", retryable: false, message: "Something went wrong." },
};

const PROVIDER: Record<ModelErrorCode, AssistantApiErrorCode> = {
  timeout: "provider_timeout",
  budget_exceeded: "provider_timeout",
  aborted: "request_cancelled",
  rate_limited: "provider_rate_limited",
  refused: "provider_rejected",
  unavailable: "provider_unavailable",
  invalid_response: "provider_invalid_response",
  output_too_large: "model_limit_exceeded",
  recipient_not_approved: "provider_not_approved",
  authentication_failed: "provider_configuration",
};

const ORCHESTRATOR: Record<OrchestratorErrorCode, AssistantApiErrorCode> = {
  invalid_input: "invalid_request",
  invalid_model_request: "internal_error",
  invalid_model_response: "provider_invalid_response",
  unknown_tool: "assistant_could_not_complete",
  malformed_tool_arguments: "assistant_could_not_complete",
  invalid_tool_arguments: "assistant_could_not_complete",
  tool_result_too_large: "assistant_could_not_complete",
  tool_result_unclassified: "internal_error",
  round_limit_exceeded: "assistant_could_not_complete",
  tool_call_limit_exceeded: "assistant_could_not_complete",
};

function codeOf(error: unknown): AssistantApiErrorCode {
  if (error instanceof NotAuthenticatedError) return "not_authenticated";
  if (error instanceof AssistantAuthorizationError) {
    if (error.code === "consent_not_given") return "consent_required";
    if (error.code === "authorization_expired") return "consent_expired";
    if (error.code === "recipient_not_approved") return "provider_not_approved";
    if (error.code === "authorization_revoked") return "consent_revoked";
    if (error.code === "inventory_changed") return "consent_outdated";
    return "consent_invalid";
  }
  if (error instanceof AssistantRateLimitError) {
    if (error.code === "concurrent_runs") return "too_many_concurrent_runs";
    if (error.code === "global_concurrent_runs") return "assistant_busy";
    return error.code === "tokens_per_window" ? "usage_budget_exceeded" : "rate_limited";
  }
  if (error instanceof AssistantConfigError) return error.code === "assistant_disabled" ? "assistant_unavailable" : "assistant_misconfigured";
  if (error instanceof AssistantProfileError) return "assistant_misconfigured";
  if (error instanceof ModelProviderError) return PROVIDER[error.code] ?? "provider_unavailable";
  if (error instanceof OrchestratorError) return ORCHESTRATOR[error.code] ?? "internal_error";
  if (error instanceof AnswerInputError || error instanceof AssistantFailure) return "internal_error";
  return "internal_error";
}

/** The public form of any error an assistant entry point throws. Never carries anything from the error but its type and code. */
export function toAssistantApiError(error: unknown): AssistantApiError {
  const code = codeOf(error);
  return Object.freeze({ code, ...PUBLIC[code] });
}

/** Run an assistant entry point and turn its outcome into the public response. It never throws. */
export async function toAssistantApiResponse(run: () => Promise<Answer>): Promise<AssistantApiResponse> {
  try {
    return Object.freeze({ ok: true as const, answer: await run() });
  } catch (error) {
    return Object.freeze({ ok: false as const, error: toAssistantApiError(error) });
  }
}
