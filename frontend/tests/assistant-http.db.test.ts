// The assistant's HTTP boundary (services/assistant/http.ts, behind app/api/assistant/route.ts), end to end against the local PostgreSQL:
//
//   Request -> session user -> body (content type, size, UTF-8, JSON) -> service: body shape -> configuration -> consent (database)
//   -> access plan -> per-user and global admission (PostgreSQL) -> run row -> orchestration -> tool gate -> real tools -> egress filter
//   -> model guard -> provider boundary (a recording test driver) -> answer layer -> audit row -> release -> HTTP response
//
// Every refusal is checked to stop BEFORE the provider and before any tool. Concurrency is deterministic: a provider waits at a gate the
// test opens (no sleeps), and time is an injected clock. Throwaway users, deleted after each test; no real provider, no network.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { assistantAuthorizations, assistantRuns } from "../db/schema";
import { MAX_ASSISTANT_BODY_BYTES, handleAssistantHttp, httpStatusOf } from "../services/assistant/http";
import type { AssistantHttpDeps } from "../services/assistant/http";
import { ASSISTANT_API_ERROR_CODES, toAssistantApiError } from "../services/assistant/api-contract";
import type { AssistantApiResponse } from "../services/assistant/api-contract";
import type { AssistantEvent } from "../services/assistant/events";
import { ASSISTANT_ENV_NAMES, ASSISTANT_LIMIT_ENV_NAMES, ASSISTANT_PROVIDER_ENV_NAMES, ASSISTANT_RETENTION_ENV_NAMES, validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { grantAssistantAuthorization } from "../services/assistant/authorization-store";
import { ModelProviderError } from "../services/assistant/model";
import { AssistantConfigError } from "../services/assistant/config";
import { OrchestratorError } from "../services/assistant/orchestrator";
import { AssistantAuthorizationError } from "../lib/assistant/authorization";
import { NotAuthenticatedError } from "../services/errors";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { AssistantRateLimitError } from "../lib/assistant/run-limits";
import { deleteTestUser, makeTestUser } from "./helpers";
import { testProvider, toolMessagesSent } from "./helpers-provider";
import type { WireStep } from "./helpers-provider";

const KEY = "test-key-NOT-A-REAL-SECRET-0008";
const ENDPOINT = "https://provider.invalid/v1/chat/completions";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: "fixture-model-1",
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "3000", MODEL_MAX_OUTPUT_CHARS: "20000",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "20", ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000",
  ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", MODEL_MAX_OUTPUT_TOKENS: "1024", MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RUN_RETENTION_DAYS: "400",
};
const external = (over: Record<string, string> = {}): AssistantConfig => validateExternalEnv({ ...ENV, ...over });
/** The stale bound the service derives from ENV: timeout 3000 ms x 4 model rounds + 60 s. */
const STALE_MS = 3000 * 4 + 60_000;
const BODY = { messages: ["What is my tax this year?"] };
const TAX = { assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
const toolStep = (...calls: Array<[string, string, unknown]>): WireStep => ({ reply: { kind: "tool_calls", calls: calls.map(([id, name, args]) => ({ id, name, args })) }, inputTokens: 100, outputTokens: 20 });
const done: WireStep = { reply: { kind: "text", text: "The engine computed the figures above." }, inputTokens: 150, outputTokens: 12 };

async function withUsers(n: number, work: (ids: string[]) => Promise<void>) {
  const users = await Promise.all(Array.from({ length: n }, (_, i) => makeTestUser(`assistant-http-${i}`)));
  try {
    await work(users.map((u) => u.id));
  } finally {
    for (const u of users) await deleteTestUser(u.id);
  }
}
const consent = (userId: string, at = NOW, over: Record<string, unknown> = {}) =>
  grantAssistantAuthorization(userId, { profileId: "full", recipient: RECIPIENT, dataClasses: [...EGRESS_FIELD_CLASSES], issuedAt: new Date(at - 7_200_000), expiresAt: new Date(at + 7_200_000), ...over });
const runsOf = (userId: string) => db.select().from(assistantRuns).where(eq(assistantRuns.userId, userId));
const noRunning = async (userId: string) => assert.deepEqual((await runsOf(userId)).filter((r) => r.status === "running"), [], "no slot is left held");

/** A POST to the route. `raw` overrides the JSON body; a stream body counts how often it was read. */
function post(body: unknown, init: { contentType?: string | null; raw?: BodyInit; headers?: Record<string, string>; method?: string } = {}) {
  const headers: Record<string, string> = { ...(init.contentType === null ? {} : { "content-type": init.contentType ?? "application/json" }), ...init.headers };
  return new Request("http://localhost/api/assistant", { method: init.method ?? "POST", headers, body: init.raw ?? JSON.stringify(body), duplex: "half" } as RequestInit);
}
function countingStream(text: string) {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.enqueue(new TextEncoder().encode(text)); c.close(); } }, { highWaterMark: 0 });
  return { stream, pulls: () => pulls };
}

/** Calls the HTTP boundary as the route does, with test dependencies. Returns the status, the parsed body and the raw text. */
async function send(request: Request, deps: Partial<AssistantHttpDeps> & { userId?: string | null; steps?: WireStep[] } = {}) {
  const provider = testProvider(...(deps.steps ?? [done]));
  const events: AssistantEvent[] = [];
  const { userId, steps: _steps, ...rest } = deps;
  void _steps;
  const response = await handleAssistantHttp(request, {
    getSessionUserId: async () => userId ?? null,
    config: external(),
    driver: provider.driver,
    now: () => NOW,
    onEvent: (e) => events.push(e),
    ...rest,
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: JSON.parse(text) as AssistantApiResponse, text, calls: provider.calls, events };
}
const codeOf = (body: AssistantApiResponse) => (body.ok ? "ok" : body.error.code);
const noSecretsIn = (text: string, ...more: Array<string | undefined>) => {
  for (const s of [KEY, ENDPOINT, process.env.DATABASE_URL, process.env.AUTH_SECRET, ...more].filter((v): v is string => typeof v === "string" && v.length > 0)) {
    assert.equal(text.includes(s), false, `leaked ${s.slice(0, 12)}…`);
  }
};
const toolEvents = (events: AssistantEvent[]) => events.filter((e) => e.type === "tool_call");

/** A provider whose transport waits at a gate the test opens: `reached` resolves once a request is at the provider. */
function gatedProvider(step: WireStep = done) {
  let open!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (arrived = r));
  const inner = testProvider(step);
  const driver = { ...inner.driver, transport: async (request: Parameters<typeof inner.driver.transport>[0]) => { arrived(); await gate; return inner.driver.transport(request); } };
  return { driver, calls: inner.calls, reached, open };
}

// --- the complete path --------------------------------------------------------------------------------------------------------------

test("the complete path: an authorized POST runs every layer, answers 200, and leaves a metadata-only audit row and a released slot", async () => {
  await withUsers(1, async ([u]) => {
    const granted = await consent(u);
    const r = await send(post(BODY), { userId: u, steps: [toolStep(["c1", "calculate_tax", { regime: "old", ...TAX }]), done] });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);

    // The provider was called twice (a tool round, then the answer), with the plan's tools, and never with an identity or a credential.
    assert.equal(r.calls.length, 2);
    const wire = r.calls.map((c) => c.body).join("\n");
    noSecretsIn(wire, u, granted.authorizationId);
    for (const c of r.calls) {
      assert.equal(JSON.stringify(c.headers).includes(u), false);
      assert.deepEqual(Object.keys(c.sent).sort(), ["maxOutputChars", "maxOutputTokens", "messages", "model", "tools"], "only the request, the model and the limits");
      assert.equal(c.sent.maxOutputTokens, Number(ENV.MODEL_MAX_OUTPUT_TOKENS), "the configured output-token cap, on every call");
    }
    assert.equal(toolMessagesSent(r.calls).length, 1, "the tool ran, and its (filtered) result reached the model once");
    noSecretsIn(r.text, u, granted.authorizationId);

    // Audit: one row, succeeded, metadata only, the plan recorded, the slot released.
    const [row] = await runsOf(u);
    assert.deepEqual(
      [row.status, row.mode, row.authorizationId, row.profileId, row.recipient, row.modelId, row.inventoryVersion, row.modelCalls, row.toolCalls, row.toolsCalled, row.resultCode],
      ["succeeded", "external", granted.authorizationId, "full", RECIPIENT, "fixture-model-1", fingerprintInventory(), 2, 1, ["calculate_tax"], null],
    );
    assert.deepEqual([row.inputTokens, row.outputTokens], [250, 32]);

    // Events, in the order of the layers, and none carries the user id or a secret.
    assert.deepEqual(r.events.map((e) => e.type), ["assistant_request", "run_started", "model_call", "tool_call", "model_call", "run_completed"]);
    noSecretsIn(JSON.stringify(r.events), u);
  });
});

test("the egress plan reaches the wire: with consent that leaves out financial data, the model is offered, and can use, only the tools that fit it", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u, NOW, { dataClasses: ["user_free_text", "tax_corpus_text", "system_value"] });
    const r = await send(post(BODY), { userId: u, steps: [toolStep(["c1", "query_transactions", {}])] });
    assert.deepEqual([r.status, codeOf(r.body)], [422, "assistant_could_not_complete"]);
    const offered = r.calls[0].sent.tools.map((t) => t.name);
    const [row] = await runsOf(u);
    assert.deepEqual(offered, row.allowedTools, "the model was offered exactly the plan's tools");
    assert.equal(offered.includes("query_transactions") || offered.includes("get_financial_summary"), false);
    assert.deepEqual(row.visibleClasses, ["user_free_text", "tax_corpus_text", "system_value"]);
    assert.equal(toolEvents(r.events).some((e) => e.type === "tool_call" && e.outcome === "ok"), false, "no tool ran");
    assert.equal(row.status, "failed");
    await noRunning(u);
  });
});

// --- the HTTP boundary: identity, method, body ----------------------------------------------------------------------------------

test("no session: 401, the body is never read, nothing reaches the configuration, the database, a tool or the provider", async () => {
  for (const getSessionUserId of [async () => null, async () => "", async () => { throw new Error("session store down"); }]) {
    const body = countingStream(JSON.stringify(BODY));
    let configRead = false;
    const r = await send(post(null, { raw: body.stream }), { getSessionUserId, config: () => { configRead = true; return external(); } });
    assert.deepEqual([r.status, codeOf(r.body)], [401, "not_authenticated"]);
    assert.equal(body.pulls(), 0, "the body was not read");
    assert.equal(configRead, false);
    assert.equal(r.calls.length, 0);
    assert.doesNotMatch(r.text, /session store down/);
  }
});

test("only POST: any other method is 405, with nothing run", async () => {
  await withUsers(1, async ([u]) => {
    const r = await handleAssistantHttp(new Request("http://localhost/api/assistant", { method: "GET" }), { getSessionUserId: async () => u, config: external(), driver: testProvider().driver });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "POST");
    assert.deepEqual(await runsOf(u), []);
  });
});

test("an unusable body is refused as invalid_request (400) BEFORE consent is read, recorded, and never read past the size limit", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const oversized = countingStream("x");
    const cases: Array<[string, Request]> = [
      ["no content type", post(BODY, { contentType: null })],
      ["a form post (as a cross-site form would send)", post(null, { contentType: "application/x-www-form-urlencoded", raw: "messages=hi" })],
      ["text/plain", post(BODY, { contentType: "text/plain" })],
      ["declared too large", post(null, { raw: oversized.stream, headers: { "content-length": String(MAX_ASSISTANT_BODY_BYTES + 1) } })],
      ["streamed too large", post(null, { raw: JSON.stringify({ messages: ["x".repeat(MAX_ASSISTANT_BODY_BYTES)] }) })],
      ["not JSON", post(null, { raw: "{messages:" })],
      ["not UTF-8", post(null, { raw: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) })],
      ["empty", post(null, { raw: "" })],
      ["too many messages", post({ messages: Array.from({ length: 21 }, () => "hi") })],
      ["a message too long", post({ messages: ["x".repeat(50_001)] })],
      ["an empty message", post({ messages: [" "] })],
      ["a user id in the body", post({ ...BODY, userId: "00000000-0000-0000-0000-000000000000" })],
      ["a chosen profile", post({ ...BODY, profile: "full" })],
      ["injected tools", post({ ...BODY, allowedTools: ["query_transactions"] })],
      ["a chosen provider and model", post({ ...BODY, provider: "evil", model: "evil-model" })],
      ["a chosen recipient", post({ ...BODY, recipient: "evil" })],
      ["a supplied consent", post({ ...BODY, authorization: { consent: "granted" } })],
      ["chosen limits", post({ ...BODY, limits: { maxConcurrentRuns: 1000 } })],
    ];
    for (const [name, request] of cases) {
      const r = await send(request, { userId: u });
      assert.deepEqual([r.status, codeOf(r.body)], [400, "invalid_request"], name);
      assert.equal(r.calls.length, 0, `${name}: no provider call`);
      assert.equal(toolEvents(r.events).length, 0, `${name}: no tool`);
      assert.equal(r.events.some((e) => e.type === "run_started"), false, `${name}: no run started`);
    }
    assert.equal(oversized.pulls(), 0, "a body declared too large is not read");
    const rows = await runsOf(u);
    assert.equal(rows.length, cases.length, "every refusal is recorded, against the SESSION user");
    assert.ok(rows.every((row) => row.status === "rejected" && row.resultCode === "invalid_request" && row.authorizationId === null));
  });
});

// --- a client that disconnects ----------------------------------------------------------------------------------------------------

/** A POST carrying a client connection the test can drop. */
function postWith(signal: AbortSignal) {
  return new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY), signal, duplex: "half" } as RequestInit);
}

test("a client that disconnects while the provider is answering cancels the run: the provider request is aborted, the run is released", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const client = new AbortController();
    const inner = testProvider(done);
    let providerSignal: AbortSignal | undefined;
    const driver = {
      ...inner.driver,
      transport: (request: Parameters<typeof inner.driver.transport>[0]) => {
        providerSignal = request.signal;
        setTimeout(() => client.abort(), 10); // the client goes away while the provider is still working
        return new Promise<never>(() => undefined);
      },
    };
    const r = await send(postWith(client.signal), { userId: u, driver });
    assert.deepEqual([r.status, codeOf(r.body)], [422, "request_cancelled"]);
    assert.equal(providerSignal?.aborted, true, "the in-flight provider request was aborted, not left running");
    noSecretsIn(r.text, u);
    const [row] = await runsOf(u);
    assert.deepEqual([row.status, row.resultCode, row.failureKind, row.modelCalls, row.toolCalls], ["failed", "request_cancelled", "ModelProviderError:aborted", 1, 0]);
    assert.deepEqual([row.inputTokens, row.outputTokens], [null, null], "no usage is invented for a cancelled call");
    await noRunning(u);
  });
});

test("a client that disconnects during a tool round gets no further provider call; the first call's usage is still counted", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const client = new AbortController();
    const inner = testProvider(toolStep(["c1", "calculate_tax", { regime: "old", ...TAX }]), done);
    // Gone right after the tool ran (its metadata event is emitted once it finishes) and before the next model call.
    const onEvent = (e: AssistantEvent) => {
      if (e.type === "tool_call") client.abort();
    };
    const r = await send(postWith(client.signal), { userId: u, driver: inner.driver, onEvent });
    assert.deepEqual([r.status, codeOf(r.body)], [422, "request_cancelled"]);
    assert.equal(inner.calls.length, 1, "no second provider request after the client left");
    const [row] = await runsOf(u);
    assert.deepEqual([row.status, row.resultCode, row.toolCalls, row.toolsCalled], ["failed", "request_cancelled", 1, ["calculate_tax"]]);
    assert.deepEqual([row.inputTokens, row.outputTokens], [100, 20], "the answered call is counted; the cancelled one adds nothing");
    await noRunning(u);
  });
});

test("a request whose client is already gone reaches no provider and holds no slot", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const r = await send(postWith(AbortSignal.abort()), { userId: u });
    assert.notEqual(r.status, 200);
    assert.equal(r.calls.length, 0, "nothing was sent");
    await noRunning(u);
  });
});

// --- configuration ----------------------------------------------------------------------------------------------------------------

test("the route's default configuration comes from the environment: off, incomplete or loopback external is 503 with no provider call; complete external answers", async () => {
  const names = [...ASSISTANT_ENV_NAMES, ...ASSISTANT_PROVIDER_ENV_NAMES, ...ASSISTANT_LIMIT_ENV_NAMES, ...ASSISTANT_RETENTION_ENV_NAMES];
  const before = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  const setEnv = (env: Record<string, string | undefined>) => {
    for (const n of names) delete process.env[n];
    for (const [n, v] of Object.entries(env)) if (v !== undefined) process.env[n] = v;
  };
  try {
    await withUsers(1, async ([u]) => {
      await consent(u);
      const provider = testProvider(done);
      const call = () => handleAssistantHttp(post(BODY), { getSessionUserId: async () => u, driver: provider.driver, now: () => NOW }); // no `config`: the route's default
      setEnv({});
      let response = await call();
      assert.deepEqual([response.status, codeOf(await response.json())], [503, "assistant_unavailable"], "unset: off");
      setEnv({ ...ENV, MODEL_WIRE_FORMAT: undefined }); // external, one required variable missing
      response = await call();
      let text = await response.text();
      assert.deepEqual([response.status, codeOf(JSON.parse(text))], [503, "assistant_misconfigured"], "incomplete external is refused");
      noSecretsIn(text);
      setEnv({ ...ENV, MODEL_ENDPOINT: "https://127.0.0.1:11434/v1/chat/completions" }); // external pointed at this machine
      response = await call();
      text = await response.text();
      assert.deepEqual([response.status, codeOf(JSON.parse(text))], [503, "assistant_misconfigured"], "a loopback endpoint is refused under external");
      noSecretsIn(text);
      assert.equal(provider.calls.length, 0, "no refused configuration reaches the provider");
      setEnv(ENV); // a complete, valid external environment
      response = await call();
      text = await response.text();
      assert.equal(response.status, 200, text);
      noSecretsIn(text);
      assert.ok(provider.calls.length > 0, "a complete external configuration reaches the provider");
      assert.deepEqual((await runsOf(u)).map((r) => [r.status, r.resultCode, r.failureKind]), [
        ["rejected", "assistant_unavailable", "AssistantConfigError:assistant_disabled"],
        ["rejected", "assistant_misconfigured", "AssistantConfigError:missing_configuration"],
        ["rejected", "assistant_misconfigured", "AssistantConfigError:invalid_configuration"],
        ["succeeded", null, null],
      ]);
    });
  } finally {
    for (const n of names) {
      if (before[n] === undefined) delete process.env[n];
      else process.env[n] = before[n];
    }
  }
});

// --- consent, and the egress inventory version -----------------------------------------------------------------------------------

test("consent is checked before any limit, tool or provider: none, expired, or another format version is 403", async () => {
  await withUsers(3, async ([none, expired, oldFormat]) => {
    await consent(expired, NOW - 86_400_000);
    const granted = await consent(oldFormat);
    await db.update(assistantAuthorizations).set({ formatVersion: 2 }).where(eq(assistantAuthorizations.id, granted.authorizationId));
    for (const [u, code] of [[none, "consent_required"], [expired, "consent_expired"], [oldFormat, "consent_invalid"]] as const) {
      const r = await send(post(BODY), { userId: u });
      assert.deepEqual([r.status, codeOf(r.body)], [403, code]);
      assert.equal(r.calls.length, 0);
      assert.equal(toolEvents(r.events).length, 0);
      assert.deepEqual((await runsOf(u)).map((row) => row.status), ["rejected"]);
    }
  });
});

test("an egress inventory change invalidates consent: 403 consent_outdated before any limit, tool or provider; a new grant runs", async () => {
  await withUsers(1, async ([u]) => {
    const granted = await consent(u);
    // As if the inventory had changed since the grant: the stored fingerprint no longer matches the current one.
    await db.update(assistantAuthorizations).set({ inventoryVersion: "inv1-00000000" }).where(eq(assistantAuthorizations.id, granted.authorizationId));
    const r = await send(post(BODY), { userId: u });
    assert.deepEqual([r.status, codeOf(r.body)], [403, "consent_outdated"]);
    assert.equal(r.calls.length, 0, "nothing reaches the provider");
    assert.equal(toolEvents(r.events).length, 0, "no tool runs");
    assert.deepEqual(r.events.filter((e) => e.type === "authorization_failure").map((e) => (e as { code: string }).code), ["consent_outdated"]);
    // Refused at the consent step: recorded as rejected, linked to the stale grant, and no slot was taken (concurrency is 1 here).
    const rows = await runsOf(u);
    assert.deepEqual(rows.map((row) => [row.status, row.resultCode, row.authorizationId]), [["rejected", "consent_outdated", granted.authorizationId]]);
    await noRunning(u);
    const [grant] = await db.select().from(assistantAuthorizations).where(eq(assistantAuthorizations.id, granted.authorizationId));
    assert.equal(grant.inventoryVersion, "inv1-00000000", "the grant keeps the inventory the person was shown");
    // A grant of the current inventory is usable at once: the refused attempt left no slot behind.
    await consent(u);
    const next = await send(post(BODY), { userId: u });
    assert.deepEqual([next.status, codeOf(next.body)], [200, "ok"]);
    const succeeded = (await runsOf(u)).filter((row) => row.status === "succeeded");
    assert.equal(succeeded.length, 1);
    assert.equal(succeeded[0].inventoryVersion, fingerprintInventory(), "the run records the inventory in force");
  });
});

// --- admission: per-user and global concurrency, deterministically ------------------------------------------------------------------

test("per-user concurrency over HTTP: while one run is at the provider, the same person's second POST is 429 and never reaches it", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const first = gatedProvider();
    const running = send(post(BODY), { userId: u, driver: first.driver });
    await first.reached;
    const second = await send(post(BODY), { userId: u });
    assert.deepEqual([second.status, codeOf(second.body), second.calls.length], [429, "too_many_concurrent_runs", 0]);
    first.open();
    assert.equal((await running).status, 200);
    await noRunning(u);
  });
});

test("global concurrency over HTTP: at capacity, another person is refused 429 assistant_busy before any tool or provider; a release frees the place", async () => {
  // A time no other test uses, so the global count sees only this test's runs.
  const T = Date.UTC(2041, 2, 1, 12, 0, 0);
  const config = external({ ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "1" });
  await withUsers(2, async ([a, b]) => {
    await consent(a, T);
    await consent(b, T);
    const first = gatedProvider(toolStep(["c1", "calculate_tax", { regime: "old", ...TAX }]));
    const running = send(post(BODY), { userId: a, driver: first.driver, config, now: () => T });
    await first.reached;
    const refused = await send(post(BODY), { userId: b, config, now: () => T });
    assert.deepEqual([refused.status, codeOf(refused.body), refused.calls.length], [429, "assistant_busy", 0]);
    assert.equal(toolEvents(refused.events).length, 0);
    assert.equal(refused.events.find((e) => e.type === "rate_limit_rejection")?.type, "rate_limit_rejection");
    noSecretsIn(refused.text, a);
    assert.deepEqual((await runsOf(b)).map((r) => [r.status, r.resultCode, r.failureKind]), [["rejected", "assistant_busy", "AssistantRateLimitError:global_concurrent_runs"]]);

    first.open();
    await running; // the first run finishes (its scripted provider then answers with the default reply)
    await noRunning(a);
    const admitted = await send(post(BODY), { userId: b, config, now: () => T + 1000 });
    assert.deepEqual([admitted.status, codeOf(admitted.body)], [200, "ok"]);
  });
});

test("global concurrency recovers from an abandoned run: a run that never released stops holding its place after the stale bound", async () => {
  const T = Date.UTC(2041, 3, 1, 12, 0, 0);
  const config = external({ ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "1" });
  await withUsers(2, async ([crashed, b]) => {
    await consent(b, T);
    // A run on some instance that died mid-run: its row stays "running".
    await db.insert(assistantRuns).values({ userId: crashed, mode: "external", status: "running", startedAt: new Date(T) });
    const blocked = await send(post(BODY), { userId: b, config, now: () => T + STALE_MS - 1 });
    assert.deepEqual([blocked.status, codeOf(blocked.body), blocked.calls.length], [429, "assistant_busy", 0]);
    const admitted = await send(post(BODY), { userId: b, config, now: () => T + STALE_MS + 1 });
    assert.deepEqual([admitted.status, codeOf(admitted.body)], [200, "ok"]);
  });
});

// --- failures after admission: typed, released, and safe ---------------------------------------------------------------------------

test("a provider failure after admission is 502, audited, and releases the slot so the next request runs", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const failed = await send(post(BODY), { userId: u, steps: [{ throws: `connection reset while sending ${KEY}` }] });
    assert.deepEqual([failed.status, codeOf(failed.body)], [502, "provider_unavailable"]);
    noSecretsIn(failed.text, u);
    await noRunning(u);
    const next = await send(post(BODY), { userId: u });
    assert.equal(next.status, 200);
    assert.deepEqual((await runsOf(u)).map((r) => r.status).sort(), ["failed", "succeeded"]);
  });
});

test("a tool the plan does not allow is denied before it runs: 422, and the provider saw no result for it", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const r = await send(post(BODY), { userId: u, steps: [toolStep(["c1", "drop_all_tables", {}])] });
    assert.deepEqual([r.status, codeOf(r.body)], [422, "assistant_could_not_complete"]);
    assert.equal(r.calls.length, 1);
    assert.equal(toolMessagesSent(r.calls).length, 0);
    assert.equal(r.events.some((e) => e.type === "tool_denial"), true);
    await noRunning(u);
  });
});

// --- the status mapping -----------------------------------------------------------------------------------------------------------

test("every error category has one HTTP status; a provider timeout is 504", () => {
  const status = (e: unknown) => httpStatusOf({ ok: false, error: toAssistantApiError(e) });
  const cases: Array<[unknown, number]> = [
    [new NotAuthenticatedError(), 401],
    [new AssistantAuthorizationError("consent_not_given"), 403],
    [new AssistantRateLimitError("concurrent_runs"), 429],
    [new AssistantRateLimitError("global_concurrent_runs"), 429],
    [new OrchestratorError("invalid_input", "bad"), 400],
    [new AssistantConfigError("assistant_disabled"), 503],
    [new ModelProviderError("unavailable"), 502],
    [new ModelProviderError("timeout"), 504],
    [new ModelProviderError("output_too_large"), 422],
    [new Error("anything else"), 500],
  ];
  for (const [error, expected] of cases) assert.equal(status(error), expected, String(error));
  assert.equal(new Set(ASSISTANT_API_ERROR_CODES).size, ASSISTANT_API_ERROR_CODES.length);
  for (const code of ASSISTANT_API_ERROR_CODES) assert.ok([400, 401, 403, 422, 429, 500, 502, 503, 504].includes(httpStatusOf({ ok: false, error: { ...toAssistantApiError(null), code } })), code);
});
