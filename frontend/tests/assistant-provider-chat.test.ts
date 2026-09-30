// The one provider driver (services/assistant/provider-chat-completions.ts), through the provider adapter (provider.ts) and the model
// guard (model.ts), with an in-memory fake `fetch`. PURE: no database, no network, no real key. What is pinned: the wire carries exactly
// the ModelRequest's fields and the configured model, to the configured endpoint, with the key only in the authentication header;
// configuration fails closed; every transport, status and decoding failure is a typed ModelProviderError with nothing of the provider,
// the key or the request in it; an answer naming another model, or none, is refused; the guard's limits still apply; and a user id,
// session, authorization or provider choice in a request cannot reach the wire.
// (A request BODY that names a provider, model, endpoint, recipient, profile, tools, classes or limits is refused by the application
// service before anything runs: tests/assistant-service.db.test.ts, "the caller cannot choose ...".)
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PROVIDER_RESPONSE_BYTES, chatCompletionsDriver, encodeChatCompletion } from "../services/assistant/provider-chat-completions";
import type { FetchLike } from "../services/assistant/provider-chat-completions";
import { createProviderAdapter } from "../services/assistant/provider";
import { AssistantConfigError, readAssistantConfig, validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { ModelProviderError, ModelRequestError, ModelResponseError, withModelGuard } from "../services/assistant/model";
import type { ModelRequest } from "../services/assistant/model";

const FRONTEND = path.resolve(__dirname, "..");
const KEY = "test-key-NOT-A-REAL-SECRET-0005";
const RECIPIENT = "recipient-a";
const MODEL = "fixture-model-1";
const ENDPOINT = "https://provider.invalid/v1/chat/completions";
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: MODEL,
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "300", MODEL_MAX_OUTPUT_CHARS: "500",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "100", ASSISTANT_MAX_CONCURRENT_RUNS: "2", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", ASSISTANT_RUN_RETENTION_DAYS: "400",
};
const external = (over: Record<string, string | undefined> = {}): AssistantConfig => validateExternalEnv({ ...ENV, ...over });
const dump = (e: unknown) => [String(e), JSON.stringify(e), inspect(e, { depth: 5, showHidden: true }), (e as Error)?.stack ?? ""].join("\n");

const REQUEST: ModelRequest = {
  messages: [
    { role: "system", content: "You are SmartCA." },
    { role: "user", content: "What is my tax?" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "calculate_tax", arguments: { kind: "json", value: { regime: "new" } } }] },
    { role: "tool", toolCallId: "c1", name: "calculate_tax", content: "{\"tax\":1000}" },
  ],
  tools: [{ name: "calculate_tax", description: "Calculates tax.", parameters: { type: "object", properties: {} } }],
};

// --- the fake provider ----------------------------------------------------------------------------------------------------------

type Seen = { url: string; init: RequestInit; sent: Record<string, unknown> };
function fakeFetch(respond: (init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, init, sent: JSON.parse(String(init.body)) });
      return respond(init);
    },
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const completion = (message: Record<string, unknown>, finish: unknown = "stop", over: Record<string, unknown> = {}) => ({
  id: "chatcmpl-1", object: "chat.completion", model: MODEL, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 2 }, ...over,
});
const text = (content: string) => completion({ role: "assistant", content });
const toolCall = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });
const adapterFor = (fetch: FetchLike, config = external()) => createProviderAdapter(config, chatCompletionsDriver({ fetch }));
/** Never settles on its own; rejects with the signal's reason when the call is aborted, as the platform fetch does. */
const hanging = (init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));

async function providerError(run: () => Promise<unknown>): Promise<ModelProviderError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ModelProviderError, `expected a ModelProviderError, got ${String(error)}`);
    assert.equal(dump(error).includes(KEY), false, "the key is in no part of the error");
    assert.equal(dump(error).includes("What is my tax"), false, "the request is in no part of the error");
    return error;
  }
  throw new assert.AssertionError({ message: "expected a provider failure" });
}

// --- a valid request ------------------------------------------------------------------------------------------------------------

test("a valid request: POST to the configured endpoint, the key only as a bearer header, no redirects, and exactly the request's fields", async () => {
  const { fetch, seen } = fakeFetch(() => json(text("Your tax is 1,000.")));
  const response = await adapterFor(fetch).complete(REQUEST, { timeoutMs: 250 });

  assert.equal(seen.length, 1);
  const [call] = seen;
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error", "the key must never follow a redirect to another host");
  assert.deepEqual(call.init.headers, { "content-type": "application/json", authorization: `Bearer ${KEY}` });
  assert.ok(call.init.signal instanceof AbortSignal, "the call is bounded by a signal");
  assert.equal(String(call.init.body).includes(KEY), false, "the key is never in the body");
  assert.deepEqual(call.sent, {
    model: MODEL,
    messages: [
      { role: "system", content: "You are SmartCA." },
      { role: "user", content: "What is my tax?" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "calculate_tax", arguments: "{\"regime\":\"new\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"tax\":1000}" },
    ],
    tools: [{ type: "function", function: { name: "calculate_tax", description: "Calculates tax.", parameters: { type: "object", properties: {} } } }],
  });
  assert.deepEqual(response, { kind: "text", text: "Your tax is 1,000.", meta: { recipient: RECIPIENT, model: MODEL, inputTokens: 10, outputTokens: 2 } });
});

test("tool calls come back in the model contract's safe form, broken argument text as `malformed`, and pass the guard", async () => {
  const { fetch } = fakeFetch(() => json(completion({ role: "assistant", content: null, tool_calls: [toolCall("a", "calculate_tax", "{\"regime\":\"old\"}"), toolCall("b", "simulate_tax", "{not json")] }, "tool_calls")));
  const response = await withModelGuard(adapterFor(fetch), { approvedRecipients: [RECIPIENT] }).complete(REQUEST);
  assert.equal(response.kind, "tool_calls");
  assert.deepEqual(response.kind === "tool_calls" && response.calls.map((c) => [c.id, c.name, c.arguments.kind]), [["a", "calculate_tax", "json"], ["b", "simulate_tax", "malformed"]]);
  assert.deepEqual(response.meta, { recipient: RECIPIENT, model: MODEL, inputTokens: 10, outputTokens: 2 });
});

test("a request with no tools sends no tools field", async () => {
  const { fetch, seen } = fakeFetch(() => json(text("hi")));
  await adapterFor(fetch).complete({ messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(Object.keys(seen[0].sent).sort(), ["messages", "model"]);
});

// --- configuration fails closed ---------------------------------------------------------------------------------------------------

test("malformed configuration fails closed, names variables and never values, and nothing is sent", () => {
  const cases: Array<[() => AssistantConfig, string, string]> = [
    [() => external({ MODEL_ID: "vendor/model-1" }), "invalid_configuration", "MODEL_ID"],
    [() => external({ MODEL_ENDPOINT: "http://provider.invalid/v1/chat/completions" }), "invalid_configuration", "MODEL_ENDPOINT"],
    [() => external({ MODEL_ENDPOINT: `https://user:${KEY}@provider.invalid/v1` }), "invalid_configuration", "MODEL_ENDPOINT"],
    [() => external({ MODEL_APPROVED_RECIPIENTS: `${RECIPIENT},recipient-b` }), "invalid_configuration", "MODEL_APPROVED_RECIPIENTS"],
    [() => external({ MODEL_TIMEOUT_MS: "999999" }), "invalid_configuration", "MODEL_TIMEOUT_MS"],
    [() => external({ ASSISTANT_MAX_TOKENS_PER_WINDOW: undefined }), "missing_configuration", "ASSISTANT_MAX_TOKENS_PER_WINDOW"],
    // The one reader a deployment uses still refuses external mode outright (ADR 0002).
    [() => readAssistantConfig(ENV), "real_data_mode_not_permitted", "ASSISTANT_ENV"],
    // A synthetic configuration can never build a provider.
    [() => readAssistantConfig({ ...ENV, ASSISTANT_ENV: "synthetic" }), "invalid_configuration", "ASSISTANT_ENV"],
    [() => ({ enabled: false }), "assistant_disabled", ""],
  ];
  for (const [make, code, variable] of cases) {
    const { fetch, seen } = fakeFetch(() => json(text("hi")));
    assert.throws(
      () => adapterFor(fetch, make()),
      (e: unknown) => e instanceof AssistantConfigError && e.code === code && (variable === "" || e.variables.includes(variable as never)) && !dump(e).includes(KEY),
      `${code} ${variable}`,
    );
    assert.equal(seen.length, 0);
  }
});

test("missing or unusable credentials fail closed before any provider is built", () => {
  for (const key of [undefined, "", "   ", "has a space", "x".repeat(513)]) {
    const { fetch, seen } = fakeFetch(() => json(text("hi")));
    assert.throws(
      () => adapterFor(fetch, external({ MODEL_API_KEY: key })),
      (e: unknown) => e instanceof AssistantConfigError && e.variables.includes("MODEL_API_KEY") && (key === undefined || key.trim() === "" || !e.message.includes(key)),
      JSON.stringify(key),
    );
    assert.equal(seen.length, 0);
  }
});

// --- failures are typed and sanitised --------------------------------------------------------------------------------------------

test("a provider timeout is `timeout`, from the transport's own deadline and from the guard's, and the call is aborted", async () => {
  const direct = fakeFetch(hanging);
  assert.equal((await providerError(() => adapterFor(direct.fetch).complete(REQUEST, { timeoutMs: 30 }))).code, "timeout");
  assert.equal(direct.seen[0].init.signal?.aborted, true);

  const guarded = fakeFetch(hanging);
  assert.equal((await providerError(() => withModelGuard(adapterFor(guarded.fetch), { timeoutMs: 30 }).complete(REQUEST))).code, "timeout");
  assert.equal(guarded.seen[0].init.signal?.aborted, true, "the guard's abort reaches the network call");

  const cancelled = fakeFetch(hanging);
  const outside = new AbortController();
  const pending = providerError(() => withModelGuard(adapterFor(cancelled.fetch), { signal: outside.signal }).complete(REQUEST));
  setTimeout(() => outside.abort(), 10);
  assert.equal((await pending).code, "aborted");
});

test("a transport failure is `unavailable`, and what it said (which quoted the key and the request) is dropped", async () => {
  for (const thrown of [new TypeError(`fetch failed: Bearer ${KEY} What is my tax?`), new TypeError("fetch failed: unexpected redirect"), "a string", null]) {
    const { fetch } = fakeFetch(() => Promise.reject(thrown));
    assert.equal((await providerError(() => adapterFor(fetch).complete(REQUEST))).code, "unavailable", String(thrown));
  }
});

test("provider statuses map onto typed codes, and an error body (which quoted the key) is never read", async () => {
  for (const [status, code] of [[401, "authentication_failed"], [403, "authentication_failed"], [429, "rate_limited"], [400, "refused"], [504, "timeout"], [500, "unavailable"], [503, "unavailable"]] as const) {
    let pulled = 0;
    // highWaterMark 0: the stream produces a chunk only when someone reads it.
    const errorBody = new ReadableStream<Uint8Array>({ pull(c) { pulled += 1; c.enqueue(new TextEncoder().encode(`{"error":"bad key ${KEY}"}`)); c.close(); } }, { highWaterMark: 0 });
    const { fetch } = fakeFetch(() => new Response(errorBody, { status }));
    const error = await providerError(() => adapterFor(fetch).complete(REQUEST));
    assert.equal(error.code, code, String(status));
    assert.equal(pulled, 0, "the error body was never read");
  }
});

test("a malformed answer is `invalid_response`", async () => {
  const bodies: Array<[string, string]> = [
    ["not JSON", "<html>oops</html>"],
    ["not an object", "[1,2]"],
    ["no choices", JSON.stringify({ model: MODEL })],
    ["two choices", JSON.stringify({ ...text("a"), choices: [...text("a").choices, ...text("b").choices] })],
    ["not from the assistant", JSON.stringify(completion({ role: "user", content: "hi" }))],
    ["a refusal", JSON.stringify(completion({ role: "assistant", content: null, refusal: "I cannot help with that." }))],
    ["cut off", JSON.stringify(completion({ role: "assistant", content: "partial" }, "length"))],
    ["filtered", JSON.stringify(completion({ role: "assistant", content: "" }, "content_filter"))],
    ["no text", JSON.stringify(completion({ role: "assistant", content: null }))],
    ["tool calls not a list", JSON.stringify(completion({ role: "assistant", content: "x", tool_calls: { id: "a" } }))],
    ["not a function call", JSON.stringify(completion({ role: "assistant", content: null, tool_calls: [{ id: "a", type: "code", function: { name: "x", arguments: "{}" } }] }, "tool_calls"))],
    ["arguments not text", JSON.stringify(completion({ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "calculate_tax", arguments: {} } }] }, "tool_calls"))],
    ["tool calls cut off", JSON.stringify(completion({ role: "assistant", content: null, tool_calls: [toolCall("a", "calculate_tax", "{}")] }, "length"))],
  ];
  for (const [name, body] of bodies) {
    const { fetch } = fakeFetch(() => new Response(body, { status: 200 }));
    assert.equal((await providerError(() => withModelGuard(adapterFor(fetch)).complete(REQUEST))).code, "invalid_response", name);
  }
});

test("an oversized answer is not read to the end, declared or streamed", async () => {
  const declared = fakeFetch(() => new Response("{}", { status: 200, headers: { "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) } }));
  assert.equal((await providerError(() => adapterFor(declared.fetch).complete(REQUEST))).code, "unavailable");

  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024).fill(32);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  const streamed = fakeFetch(() => new Response(stream, { status: 200 }));
  assert.equal((await providerError(() => adapterFor(streamed.fetch).complete(REQUEST))).code, "unavailable");
  assert.ok(pulled * chunk.byteLength <= MAX_PROVIDER_RESPONSE_BYTES + 2 * chunk.byteLength, "reading stopped at the limit");
});

// --- an unexpected model or recipient ------------------------------------------------------------------------------------------

test("an answer naming another model, or none, is `invalid_response`; an answer can never be from a recipient other than the authorized one", async () => {
  for (const model of ["some-other-model", `${MODEL}-2026-01-01`, "", undefined]) {
    const { fetch } = fakeFetch(() => json({ ...text("hi"), model }));
    assert.equal((await providerError(() => withModelGuard(adapterFor(fetch)).complete(REQUEST))).code, "invalid_response", String(model));
  }
  // The adapter states the configured recipient; if the person authorized another one, the guard refuses the answer before use.
  const { fetch } = fakeFetch(() => json(text("hi")));
  assert.equal((await providerError(() => withModelGuard(adapterFor(fetch), { approvedRecipients: ["recipient-b"] }).complete(REQUEST))).code, "recipient_not_approved");
});

// --- what cannot reach the provider --------------------------------------------------------------------------------------------

test("a user id, session, authorization, database handle or provider choice in a request is refused by the guard, and nothing is sent", async () => {
  const smuggled: unknown[] = [
    { ...REQUEST, userId: "user-1" },
    { ...REQUEST, session: { userId: "user-1" } },
    { ...REQUEST, authorization: { consent: true } },
    { ...REQUEST, db: {} },
    { ...REQUEST, model: "evil-model" },
    { ...REQUEST, provider: "evil" },
    { ...REQUEST, endpoint: "https://evil.invalid" },
    { ...REQUEST, recipient: "evil" },
    { messages: [{ role: "user", content: "hi", userId: "user-1" }] },
    { messages: [{ role: "user", content: "hi" }], tools: [{ ...REQUEST.tools?.[0], allowedTools: ["all"] }] },
  ];
  for (const request of smuggled) {
    const { fetch, seen } = fakeFetch(() => json(text("hi")));
    await assert.rejects(withModelGuard(adapterFor(fetch)).complete(request as ModelRequest), (e: unknown) => e instanceof ModelRequestError, JSON.stringify(request));
    assert.equal(seen.length, 0);
  }
});

test("even past the guard, the encoder copies only the listed fields: nothing else on a request can cross", () => {
  const polluted = {
    userId: "user-1",
    messages: [{ role: "user", content: "hi", userId: "user-1", session: { token: "sess" } }],
    tools: [{ name: "calculate_tax", description: "d", parameters: {}, authorization: { consent: true } }],
    db: { url: "postgres://x" },
  } as unknown as ModelRequest;
  const body = encodeChatCompletion(polluted, { modelId: MODEL, maxOutputChars: 10, userId: "user-1" } as never);
  for (const leaked of ["user-1", "userId", "session", "sess", "authorization", "consent", "postgres", "maxOutputChars"]) assert.equal(body.includes(leaked), false, leaked);
});

test("the driver imports only the model contract at runtime, and nothing that reaches a user, session, authorization, plan, store or database", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "services/assistant/provider-chat-completions.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const runtime = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  const types = [...source.matchAll(/^import\s+type\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(runtime, ["./model"]);
  assert.deepEqual([...new Set(types)].sort(), ["./config", "./model", "./provider"]);
  assert.doesNotMatch(source, /process\.env|require\(|import\(|console\./, "no environment, no dynamic import, no logging");
  assert.doesNotMatch(source, /\buserId\b|\bsession\b|access-plan|run-store|authorization-store|\/service|db\/|drizzle|next-auth/, "no user, session, plan, store or database");
  // The provider adapter imports the driver nowhere: the dependency points only downward.
  for (const upper of ["provider.ts", "model.ts", "config.ts"]) {
    assert.equal(fs.readFileSync(path.join(FRONTEND, "services/assistant", upper), "utf8").includes("provider-chat-completions\""), false, upper);
  }
});

// --- the model's limits still apply ----------------------------------------------------------------------------------------------

test("the guard's limits still apply on top of the real driver: output size, tool-call count, tool names, run budget", async () => {
  const big = fakeFetch(() => json(text("x".repeat(600))));
  assert.equal((await providerError(() => withModelGuard(adapterFor(big.fetch), { maxOutputChars: 500 }).complete(REQUEST))).code, "output_too_large");

  const many = fakeFetch(() => json(completion({ role: "assistant", content: null, tool_calls: Array.from({ length: 9 }, (_, i) => toolCall(`c${i}`, "calculate_tax", "{}")) }, "tool_calls")));
  await assert.rejects(withModelGuard(adapterFor(many.fetch)).complete(REQUEST), (e: unknown) => e instanceof ModelResponseError);

  const badName = fakeFetch(() => json(completion({ role: "assistant", content: null, tool_calls: [toolCall("a", "Drop-Table", "{}")] }, "tool_calls")));
  await assert.rejects(withModelGuard(adapterFor(badName.fetch)).complete(REQUEST), (e: unknown) => e instanceof ModelResponseError);

  const late = fakeFetch(() => json(text("hi")));
  assert.equal((await providerError(() => withModelGuard(adapterFor(late.fetch), { deadlineAt: Date.now() - 1 }).complete(REQUEST))).code, "budget_exceeded");
  assert.equal(late.seen.length, 0, "a spent run budget sends nothing");
});

test("the driver holds no key: it renders nothing secret, and the configuration's key is redacted", () => {
  const driver = chatCompletionsDriver({ fetch: async () => json(text("hi")) });
  assert.equal(inspect(driver, { depth: 5, showHidden: true }).includes(KEY), false);
  const config = external();
  assert.equal([String(config), JSON.stringify(config), inspect(config, { depth: 5 })].join("\n").includes(KEY), false);
});
