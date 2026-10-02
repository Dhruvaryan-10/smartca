// The provider boundary (services/assistant/provider.ts), with the recording test provider (helpers-provider.ts). PURE: no database, no
// network, no real provider. What is pinned: where a request goes comes only from the configuration; the wire carries the ModelRequest
// and nothing else, plus the configured output-token cap, which no caller or request can change; every provider failure becomes a typed ModelProviderError with nothing of the provider, the key or the request in it;
// a provider cannot answer as another model or another recipient; and the model guard's limits still apply on top.
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProviderAdapter, readProviderTarget } from "../services/assistant/provider";
import { AssistantConfigError, MAX_MODEL_OUTPUT_TOKENS, readAssistantConfig, validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { ModelProviderError, ModelRequestError, withModelGuard } from "../services/assistant/model";
import type { ModelErrorCode, ModelRequest } from "../services/assistant/model";
import { toAssistantApiError } from "../services/assistant/api-contract";
import { testProvider } from "./helpers-provider";

const FRONTEND = path.resolve(__dirname, "..");
const KEY = "test-key-NOT-A-REAL-SECRET-0004";
const RECIPIENT = "recipient-a";
const ENDPOINT = "https://provider.invalid/v1/complete";
const base: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "synthetic", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: "fixture-model-1",
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "300", MODEL_MAX_OUTPUT_CHARS: "500",
};
const external = (over: Record<string, string> = {}): AssistantConfig => validateExternalEnv({ ...base, ASSISTANT_ENV: "external", ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "100", ASSISTANT_MAX_CONCURRENT_RUNS: "2", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", MODEL_MAX_OUTPUT_TOKENS: "1024", MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RUN_RETENTION_DAYS: "400", ...over });
const REQUEST: ModelRequest = { messages: [{ role: "system", content: "s" }, { role: "user", content: "What is my tax?" }], tools: [] };
const dump = (e: unknown) => [String(e), JSON.stringify(e), inspect(e, { depth: 5, showHidden: true }), (e as Error)?.stack ?? ""].join("\n");

async function providerError(run: () => Promise<unknown>): Promise<ModelProviderError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ModelProviderError, `expected a ModelProviderError, got ${String(error)}`);
    assert.equal(dump(error).includes(KEY), false, "the key is in no part of the error");
    return error;
  }
  throw new assert.AssertionError({ message: "expected a provider failure" });
}

// --- configuration decides where a request goes --------------------------------------------------------------------------------

test("only an enabled, external configuration with exactly one approved recipient can build a provider", () => {
  assert.deepEqual(readProviderTarget(external()).recipient, RECIPIENT);
  const cases: Array<[AssistantConfig, string]> = [
    [{ enabled: false }, "assistant_disabled"],
    [readAssistantConfig(base), "invalid_configuration"],
    // Hand-built past the validator: the adapter checks the recipient count itself too.
    [{ ...(external() as Extract<AssistantConfig, { env: "external" }>), approvedRecipients: [RECIPIENT, "recipient-b"] }, "invalid_configuration"],
  ];
  for (const [config, code] of cases) {
    const { driver, calls } = testProvider();
    assert.throws(() => createProviderAdapter(config, driver), (e: unknown) => e instanceof AssistantConfigError && e.code === code);
    assert.equal(calls.length, 0);
  }
});

test("the wire carries the configured endpoint, model and key, and exactly the ModelRequest in the body", async () => {
  const { driver, calls } = testProvider({ reply: { kind: "text", text: "hi" } });
  const response = await createProviderAdapter(external(), driver).complete(REQUEST, { timeoutMs: 250, maxOutputChars: 400 });
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.url, ENDPOINT);
  assert.deepEqual(c.headers, { "content-type": "application/json", authorization: `Bearer ${KEY}` });
  assert.deepEqual(c.sent, { model: "fixture-model-1", maxOutputTokens: 1024, maxOutputChars: 400, messages: REQUEST.messages, tools: [] });
  assert.equal(c.body.includes(KEY), false, "the key is only in the authentication header, never the body");
  assert.equal(c.timeoutMs, 250);
  assert.deepEqual(response, { kind: "text", text: "hi", meta: { recipient: RECIPIENT, model: "fixture-model-1" } });
});

// --- the output-token cap comes only from the configuration --------------------------------------------------------------------

test("every model call hands the driver the configured output-token cap", async () => {
  const { driver, calls } = testProvider({ reply: { kind: "text", text: "a" } }, { reply: { kind: "text", text: "b" } }, { reply: { kind: "text", text: "c" } });
  const adapter = createProviderAdapter(external({ MODEL_MAX_OUTPUT_TOKENS: "777" }), driver);
  for (let i = 0; i < 3; i += 1) await adapter.complete(REQUEST);
  assert.deepEqual(calls.map((c) => c.sent.maxOutputTokens), [777, 777, 777]);
});

test("neither the caller's options nor the request can set or change the output-token cap", async () => {
  const { driver, calls } = testProvider();
  const adapter = createProviderAdapter(external(), driver);
  const smuggled = { ...REQUEST, maxOutputTokens: 999_999, max_tokens: 999_999 } as unknown as ModelRequest;
  await adapter.complete(smuggled, { timeoutMs: 250, maxOutputTokens: 999_999, max_tokens: 999_999 } as never);
  assert.equal(calls[0].sent.maxOutputTokens, 1024);
  assert.equal(calls[0].body.includes("999999"), false, "nothing the caller supplied reached the wire");
  // Under the guard, a request carrying a cap is refused outright, and nothing is sent.
  const guarded = testProvider();
  await assert.rejects(withModelGuard(createProviderAdapter(external(), guarded.driver)).complete(smuggled), (e: unknown) => e instanceof ModelRequestError);
  assert.equal(guarded.calls.length, 0);
});

test("a configuration built past the validator with an unusable output-token cap fails closed, naming the variable, and sends nothing", () => {
  const good = external() as Extract<AssistantConfig, { env: "external" }>;
  for (const cap of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_MODEL_OUTPUT_TOKENS + 1, "1024"]) {
    const { driver, calls } = testProvider();
    assert.throws(
      () => createProviderAdapter({ ...good, maxOutputTokens: cap } as never, driver),
      (e: unknown) => e instanceof AssistantConfigError && e.code === "invalid_configuration" && e.variables.join() === "MODEL_MAX_OUTPUT_TOKENS",
      String(cap),
    );
    assert.equal(calls.length, 0);
  }
  assert.equal(readProviderTarget({ ...good, maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS }).config.maxOutputTokens, MAX_MODEL_OUTPUT_TOKENS);
});

test("the transport's timeout is never longer than the configuration's", async () => {
  const { driver, calls } = testProvider({ reply: { kind: "text", text: "hi" } });
  await createProviderAdapter(external(), driver).complete(REQUEST, { timeoutMs: 100_000 });
  assert.equal(calls[0].timeoutMs, 300);
});

// --- provider failures are typed, and sanitised -------------------------------------------------------------------------------

test("every provider status maps onto a typed code", async () => {
  const table: Array<[number, ModelErrorCode]> = [
    [401, "authentication_failed"], [403, "authentication_failed"], [408, "timeout"], [504, "timeout"], [429, "rate_limited"],
    [400, "refused"], [404, "refused"], [422, "refused"], [500, "unavailable"], [502, "unavailable"], [503, "unavailable"], [302, "unavailable"], [100, "unavailable"],
  ];
  for (const [status, code] of table) {
    const { driver } = testProvider({ status, body: `provider says: bad key ${KEY}` });
    const error = await providerError(() => createProviderAdapter(external(), driver).complete(REQUEST));
    assert.equal(error.code, code, String(status));
    assert.equal(error.message.includes("provider says"), false, "the provider's own text is dropped");
  }
});

test("a transport that throws is unavailable, and what it threw (which quoted the key) is dropped", async () => {
  const { driver } = testProvider({ throws: "connection reset" });
  const error = await providerError(() => createProviderAdapter(external(), driver).complete(REQUEST));
  assert.equal(error.code, "unavailable");
});

test("only the NAME of what a transport throws is read: a timeout is timeout, an oversized answer is invalid_response (not retryable), anything else unavailable", async () => {
  const thrown: Array<[unknown, ModelErrorCode, boolean]> = [
    [Object.assign(new Error(`timed out ${KEY}`), { name: "TimeoutError" }), "timeout", true],
    [Object.assign(new Error(`too large ${KEY}`), { name: "ResponseTooLarge" }), "invalid_response", false],
    [new TypeError(`fetch failed ${KEY}`), "unavailable", true],
    [Object.assign(new Error(`aborted ${KEY}`), { name: "AbortError" }), "unavailable", true],
    [`ResponseTooLarge ${KEY}`, "unavailable", true],
    [null, "unavailable", true],
  ];
  for (const [error, code, retryable] of thrown) {
    const { driver } = testProvider();
    const throwing = { ...driver, transport: async () => Promise.reject(error) };
    const failure = await providerError(() => createProviderAdapter(external(), throwing).complete(REQUEST));
    assert.equal(failure.code, code, String((error as Error)?.name ?? error));
    // What a client is told: an answer that came back too large is not worth retrying; an outage or a timeout may be.
    assert.equal(toAssistantApiError(failure).retryable, retryable, code);
  }
});

test("a malformed or substituted answer is invalid_response: unparsable, not an object, or from another model", async () => {
  for (const step of [{ status: 200, body: "not json" }, { status: 200, body: JSON.stringify({ reply: "text" }) }, { reply: { kind: "text", text: "hi" }, model: "some-other-model" }]) {
    const { driver } = testProvider(step as never);
    assert.equal((await providerError(() => createProviderAdapter(external(), driver).complete(REQUEST))).code, "invalid_response", JSON.stringify(step));
  }
});

test("a provider cannot answer as another recipient: the adapter states the configured recipient, whatever the answer claims", async () => {
  const { driver } = testProvider({ reply: { kind: "text", text: "hi", meta: { recipient: "evil", model: "evil" } } });
  const guarded = withModelGuard(createProviderAdapter(external(), driver), { approvedRecipients: [RECIPIENT] });
  const response = await guarded.complete(REQUEST);
  assert.deepEqual(response.meta, { recipient: RECIPIENT, model: "fixture-model-1" });
});

test("a request that cannot be encoded is a ModelRequestError, and nothing is sent", async () => {
  const { driver, calls } = testProvider();
  const broken = { ...driver, encode: () => { throw new Error(`cannot encode ${KEY}`); } };
  await assert.rejects(createProviderAdapter(external(), broken).complete(REQUEST), (e: unknown) => e instanceof ModelRequestError && !dump(e).includes(KEY));
  assert.equal(calls.length, 0);
});

// --- the model guard's limits still apply on top ------------------------------------------------------------------------------

test("under the model guard: a hanging provider times out, an oversized answer is refused, and token counts are reported", async () => {
  const hang = testProvider({ hang: true });
  const timedOut = await providerError(() => withModelGuard(createProviderAdapter(external(), hang.driver), { timeoutMs: 40 }).complete(REQUEST));
  assert.equal(timedOut.code, "timeout");
  assert.equal(hang.calls[0].hadSignal, true, "the transport was handed the abort signal");

  const big = testProvider({ reply: { kind: "text", text: "x".repeat(600) } });
  assert.equal((await providerError(() => withModelGuard(createProviderAdapter(external(), big.driver), { maxOutputChars: 500 }).complete(REQUEST))).code, "output_too_large");

  const counted = testProvider({ reply: { kind: "text", text: "hi" }, inputTokens: 12, outputTokens: 3 });
  const infos: unknown[] = [];
  await withModelGuard(createProviderAdapter(external(), counted.driver), { approvedRecipients: [RECIPIENT], onCall: (i) => infos.push(i) }).complete(REQUEST);
  assert.deepEqual(infos.map((i) => { const { durationMs: _d, ...rest } = i as { durationMs: number }; void _d; return rest; }), [{ recipient: RECIPIENT, model: "fixture-model-1", inputTokens: 12, outputTokens: 3, outcome: "ok" }]);
});

// --- usage of a refused answer -----------------------------------------------------------------------------------------------------

test("the adapter vouches for usage only when the body names the configured model, before the answer is judged", async () => {
  const seen: unknown[] = [];
  const onUsage = (u: unknown) => seen.push(u);
  const run = async (step: Parameters<typeof testProvider>[0], driverOver: Record<string, unknown> = {}) => {
    seen.length = 0;
    const { driver } = testProvider(step);
    await createProviderAdapter(external(), { ...driver, ...driverOver }).complete(REQUEST, { onUsage }).catch(() => undefined);
    return [...seen];
  };
  // The configured model: vouched, whether the answer is then accepted or refused.
  assert.deepEqual(await run({ reply: { kind: "text", text: "hi" }, model: "fixture-model-1", inputTokens: 12, outputTokens: 3 }), [{ inputTokens: 12, outputTokens: 3 }]);
  assert.deepEqual(await run({ reply: { kind: "poem" }, model: "fixture-model-1", inputTokens: 250, outputTokens: 32 }), [{ inputTokens: 250, outputTokens: 32 }]);
  // Another model, no model, malformed counts, an error status: nothing vouched.
  assert.deepEqual(await run({ reply: { kind: "text", text: "hi" }, model: "some-other-model", inputTokens: 999, outputTokens: 999 }), []);
  assert.deepEqual(await run({ reply: { kind: "text", text: "hi" }, inputTokens: 999, outputTokens: 999 }), []);
  assert.deepEqual(await run({ reply: { kind: "text", text: "hi" }, model: "fixture-model-1", inputTokens: -1, outputTokens: 1.5 }), []);
  assert.deepEqual(await run({ status: 500, body: JSON.stringify({ model: "fixture-model-1", inputTokens: 9 }) }), []);
  // A driver without readUsage, or one whose readUsage throws or answers for another model, vouches for nothing.
  assert.deepEqual(await run({ reply: { kind: "poem" }, model: "fixture-model-1", inputTokens: 1 }, { readUsage: undefined }), []);
  assert.deepEqual(await run({ reply: { kind: "poem" }, model: "fixture-model-1", inputTokens: 1 }, { readUsage: () => { throw new Error(`boom ${KEY}`); } }), []);
  assert.deepEqual(await run({ reply: { kind: "poem" }, model: "fixture-model-1", inputTokens: 1 }, { readUsage: () => ({ model: "evil", inputTokens: 5 }) }), []);
});

test("accounting never changes the outcome: a throwing usage callback leaves the answer, and the refusal, exactly as they were", async () => {
  const boom = () => { throw new Error("sink down"); };
  const ok = testProvider({ reply: { kind: "text", text: "hi" }, model: "fixture-model-1", inputTokens: 1 });
  assert.deepEqual(await createProviderAdapter(external(), ok.driver).complete(REQUEST, { onUsage: boom }), { kind: "text", text: "hi", meta: { recipient: RECIPIENT, model: "fixture-model-1", inputTokens: 1 } });
  const wrong = testProvider({ reply: { kind: "text", text: "hi" }, model: "some-other-model", inputTokens: 1 });
  assert.equal((await providerError(() => createProviderAdapter(external(), wrong.driver).complete(REQUEST, { onUsage: boom }))).code, "invalid_response");
});

test("under the guard, a refused answer from the configured model reports its usage, and one from another model reports none", async () => {
  const infos: Array<[string, number | null, number | null]> = [];
  const onCall = (i: { outcome: string; inputTokens: number | null; outputTokens: number | null }) => infos.push([i.outcome, i.inputTokens, i.outputTokens]);
  const refused = testProvider({ reply: { kind: "poem" }, model: "fixture-model-1", inputTokens: 250, outputTokens: 32 });
  await assert.rejects(withModelGuard(createProviderAdapter(external(), refused.driver), { onCall }).complete(REQUEST));
  const other = testProvider({ reply: { kind: "text", text: "hi" }, model: "some-other-model", inputTokens: 999, outputTokens: 999 });
  await providerError(() => withModelGuard(createProviderAdapter(external(), other.driver), { onCall }).complete(REQUEST));
  assert.deepEqual(infos, [["invalid_response", 250, 32], ["invalid_response", null, null]]);
});

test("provider.ts imports only the model contract and the configuration, and makes no network call of its own", () => {
  const code = fs.readFileSync(path.join(FRONTEND, "services/assistant/provider.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["./config", "./model"]);
  assert.doesNotMatch(code, /fetch\(|require\(|import\(|process\.env|https?:\/\//);
});
