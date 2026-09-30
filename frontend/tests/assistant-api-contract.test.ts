// The application contract (services/assistant/api-contract.ts): every typed assistant error has a stable public code, a category,
// a retryable flag and a fixed message, and nothing of the error itself (its message, a key, a user id, a stack) reaches the public form.
// PURE: no database, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_API_ERROR_CODES, toAssistantApiError, toAssistantApiResponse } from "../services/assistant/api-contract";
import type { AssistantApiErrorCode } from "../services/assistant/api-contract";
import { MODEL_ERROR_CODES, ModelProviderError } from "../services/assistant/model";
import type { ModelErrorCode } from "../services/assistant/model";
import { OrchestratorError } from "../services/assistant/orchestrator";
import type { OrchestratorErrorCode } from "../services/assistant/orchestrator";
import { ASSISTANT_CONFIG_ERROR_CODES, AssistantConfigError } from "../services/assistant/config";
import { AssistantAuthorizationError } from "../lib/assistant/authorization";
import type { AssistantAuthorizationErrorCode } from "../lib/assistant/authorization";
import { AssistantProfileError } from "../lib/assistant/profiles";
import { AssistantFailure } from "../lib/assistant/failure";
import { AnswerInputError } from "../lib/assistant/answer";
import { NotAuthenticatedError } from "../services/errors";
import { AssistantRateLimitError, RUN_LIMIT_CODES } from "../lib/assistant/run-limits";

const SECRET = "test-key-NOT-A-REAL-SECRET-0005 user-8f3a1c0e";
const is = (error: unknown, code: AssistantApiErrorCode, category: string, retryable: boolean) => {
  const e = toAssistantApiError(error);
  assert.deepEqual([e.code, e.category, e.retryable], [code, category, retryable], `${String(error)} -> ${e.code}`);
  assert.ok(Object.isFrozen(e));
};

test("provider failures: timeouts, rate limits and outages are retryable; rejections, bad answers and configuration are not", () => {
  const expected: Record<ModelErrorCode, [AssistantApiErrorCode, string, boolean]> = {
    timeout: ["provider_timeout", "provider", true],
    budget_exceeded: ["provider_timeout", "provider", true],
    rate_limited: ["provider_rate_limited", "provider", true],
    unavailable: ["provider_unavailable", "provider", true],
    refused: ["provider_rejected", "provider", false],
    invalid_response: ["provider_invalid_response", "provider", false],
    authentication_failed: ["provider_configuration", "provider", false],
    output_too_large: ["model_limit_exceeded", "assistant", false],
    recipient_not_approved: ["provider_not_approved", "configuration", false],
    aborted: ["request_cancelled", "assistant", false],
  };
  assert.deepEqual(Object.keys(expected).sort(), [...MODEL_ERROR_CODES].sort(), "every provider code is mapped");
  for (const code of MODEL_ERROR_CODES) is(new ModelProviderError(code), ...expected[code]);
});

test("orchestrator failures: bad input is a validation error; model misbehaviour is not retryable; internal faults are internal", () => {
  const expected: Record<OrchestratorErrorCode, AssistantApiErrorCode> = {
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
  for (const [code, api] of Object.entries(expected) as Array<[OrchestratorErrorCode, AssistantApiErrorCode]>) {
    assert.equal(toAssistantApiError(new OrchestratorError(code, SECRET)).code, api, code);
  }
});

test("consent, authentication and configuration failures map to their own categories", () => {
  const consent: Record<AssistantAuthorizationErrorCode, AssistantApiErrorCode> = {
    consent_not_given: "consent_required",
    authorization_expired: "consent_expired",
    authorization_invalid: "consent_invalid",
    binding_mismatch: "consent_invalid",
    profile_mismatch: "consent_invalid",
    data_class_mismatch: "consent_invalid",
    recipient_not_approved: "provider_not_approved",
    authorization_revoked: "consent_revoked",
    inventory_changed: "consent_outdated",
  };
  for (const [code, api] of Object.entries(consent) as Array<[AssistantAuthorizationErrorCode, AssistantApiErrorCode]>) {
    assert.equal(toAssistantApiError(new AssistantAuthorizationError(code)).code, api, code);
  }
  is(new AssistantAuthorizationError("consent_not_given"), "consent_required", "consent", false);
  is(new NotAuthenticatedError(), "not_authenticated", "authentication", false);
  for (const code of ASSISTANT_CONFIG_ERROR_CODES) is(new AssistantConfigError(code), code === "assistant_disabled" ? "assistant_unavailable" : "assistant_misconfigured", "configuration", false);
  is(new AssistantProfileError("unknown_tool", SECRET), "assistant_misconfigured", "configuration", false);
});

test("anything else is internal_error, and nothing of an error's own content reaches the public form", () => {
  const errors = [
    new AssistantFailure("unexpected_failure", new Error(SECRET)),
    new AnswerInputError(SECRET),
    new Error(SECRET),
    new TypeError(SECRET),
    SECRET,
    null,
    { message: SECRET },
    new OrchestratorError("invalid_input", SECRET),
    new AssistantProfileError("unknown_tool", SECRET),
  ];
  for (const error of errors) {
    const e = toAssistantApiError(error);
    assert.equal(JSON.stringify(e).includes("test-key"), false);
    assert.equal(JSON.stringify(e).includes("user-8f3a"), false);
    assert.deepEqual(Object.keys(e).sort(), ["category", "code", "message", "retryable"]);
  }
  is(new Error(SECRET), "internal_error", "internal", false);
});

test("every public code is reachable and has one distinct, fixed message", () => {
  const seen = [
    new NotAuthenticatedError(), new AssistantAuthorizationError("consent_not_given"), new AssistantAuthorizationError("authorization_expired"),
    new AssistantAuthorizationError("binding_mismatch"), new OrchestratorError("invalid_input", "x"), new AssistantConfigError("assistant_disabled"),
    new AssistantConfigError("invalid_configuration"), new AssistantAuthorizationError("recipient_not_approved"), ...MODEL_ERROR_CODES.map((c) => new ModelProviderError(c)),
    new OrchestratorError("unknown_tool", "x"), new Error("x"), new AssistantAuthorizationError("authorization_revoked"),
    new AssistantAuthorizationError("inventory_changed"), ...RUN_LIMIT_CODES.map((c) => new AssistantRateLimitError(c)),
  ].map(toAssistantApiError);
  assert.deepEqual([...new Set(seen.map((e) => e.code))].sort(), [...ASSISTANT_API_ERROR_CODES].sort(), "every public code is reachable");
  for (const e of seen) assert.ok(e.message.length > 0);
  assert.equal(new Set(seen.map((e) => e.message)).size, ASSISTANT_API_ERROR_CODES.length, "one distinct message per code");
});

test("toAssistantApiResponse wraps an answer or a failure and never throws", async () => {
  const answer = { state: "answered" } as never;
  assert.deepEqual(await toAssistantApiResponse(async () => answer), { ok: true, answer });
  const failed = await toAssistantApiResponse(async () => { throw new ModelProviderError("timeout"); });
  assert.deepEqual(failed, { ok: false, error: toAssistantApiError(new ModelProviderError("timeout")) });
  const unexpected = await toAssistantApiResponse(async () => { throw new Error(SECRET); });
  assert.equal(JSON.stringify(unexpected).includes("test-key"), false);
});

test("rate-limit refusals are their own retryable category", () => {
  is(new AssistantRateLimitError("runs_per_window"), "rate_limited", "rate_limit", true);
  is(new AssistantRateLimitError("concurrent_runs"), "too_many_concurrent_runs", "rate_limit", true);
  is(new AssistantRateLimitError("tokens_per_window"), "usage_budget_exceeded", "rate_limit", true);
  is(new AssistantAuthorizationError("authorization_revoked"), "consent_revoked", "consent", false);
});
