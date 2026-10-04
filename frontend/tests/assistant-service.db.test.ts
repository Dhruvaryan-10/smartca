// The application service (services/assistant/service.ts) end to end: session -> body -> configuration -> consent READ FROM THE DATABASE
// -> access plan -> per-user limits -> askExternal -> real tools -> egress filter -> model guard -> the recording test provider ->
// grounded answer -> audit row. Against the local PostgreSQL; throwaway users, deleted after each test. No real provider, no network.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { assistantRuns } from "../db/schema";
import { handleAssistantRequest } from "../services/assistant/service";
import type { AssistantEvent } from "../services/assistant/events";
import { AssistantConfigError, readAssistantConfig, validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { grantAssistantAuthorization, revokeAssistantAuthorization } from "../services/assistant/authorization-store";
import { createTransaction } from "../services/transactions";
import { createPostgresRunLimiter } from "../services/assistant/run-store";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import { ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { deleteTestUser, makeTestUser } from "./helpers";
import { testProvider } from "./helpers-provider";
import type { WireStep } from "./helpers-provider";
import { AssistantRateLimitError } from "../lib/assistant/run-limits";
import type { RunLimiter } from "../lib/assistant/run-limits";

const KEY = "test-key-NOT-A-REAL-SECRET-0007";
const ENDPOINT = "https://provider.invalid/v1/complete";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: "fixture-model-1",
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "3000", MODEL_MAX_OUTPUT_CHARS: "20000",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "20", ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", MODEL_MAX_OUTPUT_TOKENS: "1024", MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RUN_RETENTION_DAYS: "400",
};
const external = (over: Record<string, string> = {}): AssistantConfig => validateExternalEnv({ ...ENV, ...over });
const BODY = { messages: ["What is my tax this year?"] };
const TAX = { assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
const toolStep = (...calls: Array<[string, string, unknown]>): WireStep => ({ reply: { kind: "tool_calls", calls: calls.map(([id, name, args]) => ({ id, name, args })) }, inputTokens: 100, outputTokens: 20 });
const done: WireStep = { reply: { kind: "text", text: "The engine computed the figures above." }, inputTokens: 150, outputTokens: 12 };

async function withUser(work: (userId: string) => Promise<void>, label = "assistant-service") {
  const user = await makeTestUser(label);
  try {
    await work(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}
const consent = (userId: string, over: Record<string, unknown> = {}) =>
  grantAssistantAuthorization(userId, { profileId: "full", recipient: RECIPIENT, dataClasses: [...EGRESS_FIELD_CLASSES], issuedAt: new Date("2026-09-29T10:00:00Z"), expiresAt: new Date("2026-09-29T14:00:00Z"), ...over });
function call(session: unknown, body: unknown, steps: WireStep[] = [done], config: AssistantConfig = external(), now = NOW) {
  const provider = testProvider(...steps);
  const events: AssistantEvent[] = [];
  const promise = handleAssistantRequest(session, body, { config, driver: provider.driver, now: () => now, onEvent: (e) => events.push(e) });
  return { promise, calls: provider.calls, events };
}
const runsOf = (userId: string) => db.select().from(assistantRuns).where(eq(assistantRuns.userId, userId));
const noSecrets = (text: string, userId?: string) => {
  for (const s of [KEY, process.env.DATABASE_URL, process.env.AUTH_SECRET, ENDPOINT, userId, "What is my tax"].filter((v): v is string => typeof v === "string" && v.length > 0)) {
    assert.equal(text.includes(s), false, `leaked ${s.slice(0, 12)}…`);
  }
};

// --- the authorized path, and its audit ----------------------------------------------------------------------------------------

test("an authorized request runs end to end: the answer, the audit row, and metadata-only events", async () => {
  await withUser(async (u) => {
    const granted = await consent(u);
    const { promise, calls, events } = call({ userId: u }, BODY, [toolStep(["c1", "calculate_tax", { regime: "old", ...TAX }], ["c2", "query_transactions", {}]), done]);
    const response = await promise;
    assert.equal(response.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].sent.tools.map((t) => t.name), [...ASSISTANT_TOOL_NAMES]);

    const [row] = await runsOf(u);
    assert.deepEqual(
      [row.status, row.mode, row.authorizationId, row.profileId, row.recipient, row.modelId, row.allowedTools, row.visibleClasses, row.inventoryVersion, row.modelCalls, row.toolCalls, row.toolsCalled, row.inputTokens, row.outputTokens, row.answerState, row.resultCode],
      ["succeeded", "external", granted.authorizationId, "full", RECIPIENT, "fixture-model-1", [...ASSISTANT_TOOL_NAMES], [...EGRESS_FIELD_CLASSES], fingerprintInventory(), 2, 2, ["calculate_tax", "query_transactions"], 250, 32, "answered", null],
    );
    noSecrets(JSON.stringify(row), undefined);
    assert.deepEqual(events.map((e) => e.type), ["assistant_request", "run_started", "model_call", "tool_call", "tool_call", "model_call", "run_completed"]);
    noSecrets(JSON.stringify(events), u);
  });
});

test("the provider sees only the person's own data: another user's ledger never crosses", async () => {
  const a = await makeTestUser("assistant-service-a");
  const b = await makeTestUser("assistant-service-b");
  try {
    await createTransaction(a.id, { type: "expense", amountPaise: 11_100, category: "A-ONLY-CATEGORY", occurredOn: "2026-03-05" });
    await createTransaction(b.id, { type: "expense", amountPaise: 22_200, category: "B-OWN-CATEGORY", occurredOn: "2026-03-06" });
    await consent(b.id);
    const { promise, calls } = call({ userId: b.id }, BODY, [toolStep(["c1", "query_transactions", {}], ["c2", "get_financial_summary", {}]), done]);
    assert.equal((await promise).ok, true);
    const bodies = calls.map((c) => c.body).join("\n");
    assert.match(bodies, /B-OWN-CATEGORY/);
    assert.equal(bodies.includes("A-ONLY-CATEGORY"), false);
    assert.equal(bodies.includes(a.id) || bodies.includes(b.id), false, "no user id crosses");
  } finally {
    await deleteTestUser(a.id);
    await deleteTestUser(b.id);
  }
});

// --- refused before anything runs: zero provider calls, and an audit row where there is a user -----------------------------------

test("no session: not_authenticated, zero provider calls", async () => {
  for (const session of [null, undefined, {}, { userId: "" }, { user: { id: "x" } }]) {
    const { promise, calls, events } = call(session, BODY);
    const response = await promise;
    assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "not_authenticated"]);
    assert.equal(calls.length, 0);
    assert.deepEqual(events.map((e) => e.type), ["assistant_request", "authorization_failure"]);
  }
});

test("no consent, revoked, expired, another user's, or another recipient's: refused before the provider, and recorded", async () => {
  await withUser(async (u) => {
    const cases: Array<[string, () => Promise<unknown>, string, number?]> = [
      ["none", async () => undefined, "consent_required"],
      ["other recipient", () => consent(u, { recipient: "recipient-b" }), "consent_required"],
      ["expired", () => consent(u), "consent_expired", Date.UTC(2026, 8, 29, 15, 0, 0)],
      ["revoked", async () => { const g = await consent(u, { issuedAt: new Date("2026-09-29T10:30:00Z") }); await revokeAssistantAuthorization(u, g.authorizationId); }, "consent_revoked"],
    ];
    for (const [name, setup, code, now] of cases) {
      await setup();
      const { promise, calls, events } = call({ userId: u }, BODY, [done], external(), now ?? NOW);
      const response = await promise;
      assert.deepEqual([response.ok, !response.ok && response.error.code], [false, code], name);
      assert.equal(calls.length, 0, `${name}: zero provider calls`);
      assert.ok(events.some((e) => e.type === "authorization_failure"), name);
    }
    const rows = await runsOf(u);
    assert.deepEqual(rows.map((r) => [r.status, r.resultCode]).sort(), [["rejected", "consent_expired"], ["rejected", "consent_required"], ["rejected", "consent_required"], ["rejected", "consent_revoked"]].sort());
    assert.ok(rows.find((r) => r.resultCode === "consent_revoked")?.authorizationId, "the revoked authorization is linked");
  });
  // Another user's consent: A consents, B asks.
  const a = await makeTestUser("assistant-service-owner");
  const b = await makeTestUser("assistant-service-other");
  try {
    await consent(a.id);
    const { promise, calls } = call({ userId: b.id }, BODY);
    const response = await promise;
    assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "consent_required"]);
    assert.equal(calls.length, 0);
  } finally {
    await deleteTestUser(a.id);
    await deleteTestUser(b.id);
  }
});

test("the caller cannot choose profile, tools, classes, recipient, provider, limits, identity or consent: any extra field is refused", async () => {
  await withUser(async (u) => {
    await consent(u);
    for (const extra of [
      { profile: "full" }, { allowedTools: [...ASSISTANT_TOOL_NAMES] }, { visibleClasses: { user_free_text: true } }, { recipient: "evil" },
      { provider: "evil" }, { model: "evil-model" }, { endpoint: "https://evil.invalid" }, { limits: { maxRunsPerWindow: 1e9 } },
      { timeoutMs: 999999 }, { userId: "someone-else" }, { authorization: { consent: "granted" } },
      { max_tokens: 999999 }, { maxOutputTokens: 999999 }, { max_completion_tokens: 999999 },
    ]) {
      const { promise, calls } = call({ userId: u }, { ...BODY, ...extra });
      const response = await promise;
      assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "invalid_request"], JSON.stringify(extra));
      assert.equal(calls.length, 0);
    }
    for (const body of [null, "hi", { messages: [] }, { messages: [""] }, { messages: "hi" }, { messages: [1] }, {}]) {
      const { promise, calls } = call({ userId: u }, body);
      assert.equal((await promise).ok, false, JSON.stringify(body));
      assert.equal(calls.length, 0);
    }
  });
});

test("external mode is unreachable unless explicitly configured: a synthetic or disabled configuration refuses, and the reader yields external only from a complete environment", async () => {
  assert.deepEqual(readAssistantConfig(ENV), external());
  assert.throws(() => readAssistantConfig({ ...ENV, ASSISTANT_RUN_RETENTION_DAYS: "" }), (e: unknown) => e instanceof AssistantConfigError && e.code === "missing_configuration");
  await withUser(async (u) => {
    await consent(u);
    const synthetic = readAssistantConfig({ ...ENV, ASSISTANT_ENV: "synthetic" });
    for (const [config, code] of [[synthetic, "assistant_misconfigured"], [{ enabled: false }, "assistant_unavailable"]] as Array<[AssistantConfig, string]>) {
      const { promise, calls } = call({ userId: u }, BODY, [done], config);
      const response = await promise;
      assert.deepEqual([response.ok, !response.ok && response.error.code], [false, code]);
      assert.equal(calls.length, 0);
    }
  });
});

// --- limits ---------------------------------------------------------------------------------------------------------------------

test("rate limit: past the per-window run count, the request is refused before the provider", async () => {
  await withUser(async (u) => {
    await consent(u);
    const config = external({ ASSISTANT_MAX_RUNS_PER_WINDOW: "1" });
    assert.equal((await call({ userId: u }, BODY, [done], config).promise).ok, true);
    const second = call({ userId: u }, BODY, [done], config);
    const response = await second.promise;
    assert.deepEqual([response.ok, !response.ok && response.error.code, !response.ok && response.error.retryable], [false, "rate_limited", true]);
    assert.equal(second.calls.length, 0);
    assert.ok(second.events.some((e) => e.type === "rate_limit_rejection"));
  });
});

// --- failures inside the run ------------------------------------------------------------------------------------------------

test("a tool outside the plan is denied, recorded and reported", async () => {
  await withUser(async (u) => {
    await consent(u, { dataClasses: ["user_free_text", "user_financial_data", "system_value"] });
    const { promise, events } = call({ userId: u }, BODY, [toolStep(["c1", "search_tax_law", { question: "What is the 87A rebate?", assessmentYear: "2026-27" }])]);
    const response = await promise;
    assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "assistant_could_not_complete"]);
    assert.ok(events.some((e) => e.type === "tool_denial" && e.code === "unknown_tool"));
    const [row] = await runsOf(u);
    assert.deepEqual([row.status, row.failureKind, row.allowedTools?.includes("search_tax_law")], ["failed", "OrchestratorError:unknown_tool", false]);
  });
});

test("provider timeout and provider error are typed, evented and audited, with nothing of the provider in them", async () => {
  await withUser(async (u) => {
    await consent(u);
    const timeout = call({ userId: u }, BODY, [{ hang: true }], external({ MODEL_TIMEOUT_MS: "60" }));
    const t = await timeout.promise;
    assert.deepEqual([t.ok, !t.ok && t.error.code, !t.ok && t.error.retryable], [false, "provider_timeout", true]);
    assert.ok(timeout.events.some((e) => e.type === "timeout"));
    const outage = call({ userId: u }, BODY, [{ status: 503, body: `upstream exploded ${KEY}` }]);
    const o = await outage.promise;
    assert.deepEqual([o.ok, !o.ok && o.error.code], [false, "provider_unavailable"]);
    assert.ok(outage.events.some((e) => e.type === "provider_failure" && e.code === "unavailable"));
    const rows = await runsOf(u);
    assert.deepEqual(rows.map((r) => r.failureKind).sort(), ["ModelProviderError:timeout", "ModelProviderError:unavailable"]);
    for (const text of [JSON.stringify(o), JSON.stringify(outage.events), JSON.stringify(rows)]) {
      assert.equal(text.includes("upstream exploded"), false);
      noSecrets(text, undefined);
    }
  });
});

test("a broken event sink cannot change the outcome", async () => {
  await withUser(async (u) => {
    await consent(u);
    const provider = testProvider(done);
    const response = await handleAssistantRequest({ userId: u }, BODY, { config: external(), driver: provider.driver, now: () => NOW, onEvent: () => { throw new Error("sink down"); } });
    assert.equal(response.ok, true);
  });
});

// --- the limiter boundary: order, interface, failure --------------------------------------------------------------------------

/** A RunLimiter that records every call and does what it is told. */
function fakeLimiter(behaviour: "allow" | "reject" | "break") {
  const acquired: Array<{ userId: string; at: number }> = [];
  const released: string[] = [];
  const limiter: RunLimiter = {
    async acquire(userId, at) {
      acquired.push({ userId, at: at.getTime() });
      if (behaviour === "reject") throw new AssistantRateLimitError("runs_per_window");
      if (behaviour === "break") throw new Error(`limiter store unreachable ${KEY}`);
      const [row] = await db.insert(assistantRuns).values({ userId, mode: "external", status: "running", startedAt: at }).returning({ id: assistantRuns.id });
      return row.id;
    },
    async release(runId) {
      released.push(runId);
    },
  };
  return { limiter, acquired, released };
}
function callWith(limiter: RunLimiter, session: unknown, steps: WireStep[] = [done], config: AssistantConfig = external(), now = NOW) {
  const provider = testProvider(...steps);
  const promise = handleAssistantRequest(session, BODY, { config, driver: provider.driver, now: () => now, limiter });
  return { promise, calls: provider.calls };
}

test("authorization is checked BEFORE the limits: without consent the limiter is never asked, even when it would refuse", async () => {
  await withUser(async (u) => {
    const fake = fakeLimiter("reject");
    const response = await callWith(fake.limiter, { userId: u }).promise;
    assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "consent_required"]);
    assert.equal(fake.acquired.length, 0, "an unauthorized request takes no slot and learns nothing about limits");
    await consent(u);
    const limited = callWith(fake.limiter, { userId: u });
    const r = await limited.promise;
    assert.deepEqual([r.ok, !r.ok && r.error.code], [false, "rate_limited"]);
    assert.deepEqual(fake.acquired, [{ userId: u, at: NOW }], "asked once, with the injected time");
    assert.equal(limited.calls.length, 0, "a refused request never reaches the provider");
  });
});

test("the service uses the injected limiter: an allowing limiter runs the request and releases its slot with the outcome", async () => {
  await withUser(async (u) => {
    await consent(u);
    const fake = fakeLimiter("allow");
    const { promise, calls } = callWith(fake.limiter, { userId: u });
    assert.equal((await promise).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(fake.acquired.length, 1);
    assert.equal(fake.released.length, 1);
  });
});

test("a limiter that fails fails closed: no provider call, and nothing of the failure in the response", async () => {
  await withUser(async (u) => {
    await consent(u);
    const { promise, calls } = callWith(fakeLimiter("break").limiter, { userId: u });
    const response = await promise;
    assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "internal_error"]);
    assert.equal(calls.length, 0);
    assert.equal(JSON.stringify(response).includes(KEY) || JSON.stringify(response).includes("unreachable"), false);
  });
});

test("missing limits fail closed before consent is read: no limiter can be built, no provider is called", async () => {
  await withUser(async (u) => {
    await consent(u);
    const base = external() as Extract<AssistantConfig, { env: "external" }>;
    for (const limits of [undefined, { ...base.limits, maxTokensPerWindow: undefined }, { ...base.limits, maxRunsPerWindow: 0 }, { ...base.limits, maxConcurrentRuns: Number.NaN }]) {
      const provider = testProvider(done);
      const response = await handleAssistantRequest({ userId: u }, BODY, { config: { ...base, limits } as never, driver: provider.driver, now: () => NOW });
      assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "assistant_misconfigured"], JSON.stringify(limits));
      assert.equal(provider.calls.length, 0);
    }
  });
});


// --- concurrency and slot release, deterministically (no sleeps: the provider waits on a gate the test opens) ------------------------

/** A provider whose transport waits at a gate: `reached` resolves once a request is at the provider, `open` lets it answer. */
function gatedProvider(step: WireStep = done) {
  let open!: () => void;
  let arrived!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (arrived = r));
  const inner = testProvider(step);
  const driver = { ...inner.driver, transport: async (request: Parameters<typeof inner.driver.transport>[0]) => { arrived(); await gate; return inner.driver.transport(request); } };
  return { driver, calls: inner.calls, reached, open };
}
const noRunning = async (userId: string) => assert.deepEqual((await runsOf(userId)).filter((r) => r.status === "running"), [], "no slot is left held");

test("concurrent-run limit: while one run is at the provider, a second request is refused, and never reaches the provider", async () => {
  await withUser(async (u) => {
    await consent(u);
    const first = gatedProvider();
    const running = handleAssistantRequest({ userId: u }, BODY, { config: external(), driver: first.driver, now: () => NOW });
    await first.reached; // the first run holds its slot and is waiting at the provider
    const second = testProvider(done);
    const refused = await handleAssistantRequest({ userId: u }, BODY, { config: external(), driver: second.driver, now: () => NOW });
    assert.deepEqual([refused.ok, !refused.ok && refused.error.code], [false, "too_many_concurrent_runs"]);
    assert.equal(second.calls.length, 0);
    first.open();
    assert.equal((await running).ok, true);
    await noRunning(u);
  });
});

test("two service instances (two logical servers) racing for the same person: exactly one run reaches the provider", async () => {
  await withUser(async (u) => {
    await consent(u);
    const config = external();
    const servers = [gatedProvider(), gatedProvider()].map((provider) => ({
      provider,
      // Each instance has its own limiter object; only PostgreSQL is shared.
      deps: { config, driver: provider.driver, now: () => NOW, limiter: createPostgresRunLimiter(config.enabled && config.env === "external" ? config.limits : null, { mode: "external", staleAfterMs: 72_000 }) },
    }));
    const requests = servers.map((s) => handleAssistantRequest({ userId: u }, BODY, s.deps));
    const loser = await Promise.race(requests); // the refused request settles at once; the winner is held at its provider's gate
    assert.deepEqual([loser.ok, !loser.ok && loser.error.code], [false, "too_many_concurrent_runs"]);
    for (const s of servers) s.provider.open();
    const results = await Promise.all(requests);
    assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
    assert.equal(servers.reduce((n, s) => n + s.provider.calls.length, 0), 1, "exactly one provider call in total");
    await noRunning(u);
  });
});

test("the slot is released on every terminal path: success, provider failure, timeout, tool denial, and a failure outside the run", async () => {
  await withUser(async (u) => {
    await consent(u, { dataClasses: ["user_free_text", "user_financial_data", "system_value"] });
    const cases: Array<[string, WireStep[], AssistantConfig, (() => number) | null, string | null]> = [
      ["success", [done], external(), null, null],
      ["provider failure", [{ status: 503, body: "down" }], external(), null, "provider_unavailable"],
      ["timeout", [{ hang: true }], external({ MODEL_TIMEOUT_MS: "40" }), null, "provider_timeout"],
      ["tool denial", [toolStep(["c1", "search_tax_law", { question: "87A?", assessmentYear: "2026-27" }])], external(), null, "assistant_could_not_complete"],
      ["a clock that breaks after the slot is taken", [done], external(), (() => { let n = 0; return () => { n += 1; if (n > 3) throw new Error("clock failed"); return NOW; }; })(), "internal_error"],
    ];
    for (const [name, steps, config, clock, code] of cases) {
      const provider = testProvider(...steps);
      const response = await handleAssistantRequest({ userId: u }, BODY, { config, driver: provider.driver, now: clock ?? (() => NOW) });
      assert.deepEqual([response.ok, response.ok ? null : response.error.code], [code === null, code], name);
      await noRunning(u);
    }
    const rows = await runsOf(u);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["failed", "failed", "failed", "failed", "succeeded"]);
  });
});

test("fail closed: when the limiter's database work fails, the request is refused, and no provider call and no tool run happens", async () => {
  await withUser(async (u) => {
    await consent(u);
    const provider = testProvider(toolStep(["c1", "calculate_tax", { regime: "old", ...TAX }]), done);
    const events: AssistantEvent[] = [];
    // A real PostgreSQL failure inside acquire: the database rejects the row (a check constraint), and the transaction rolls back.
    const broken = createPostgresRunLimiter({ windowSeconds: 3600, maxRunsPerWindow: 20, maxConcurrentRuns: 1, maxTokensPerWindow: 1_000_000, maxGlobalConcurrentRuns: 100 }, { mode: "bogus" as never, staleAfterMs: 72_000 });
    const response = await handleAssistantRequest({ userId: u }, BODY, { config: external(), driver: provider.driver, now: () => NOW, limiter: broken, onEvent: (e) => events.push(e) });
    assert.deepEqual([response.ok, !response.ok && response.error.code], [false, "internal_error"]);
    assert.equal(provider.calls.length, 0, "no provider call");
    assert.equal(events.some((e) => e.type === "tool_call" || e.type === "model_call" || e.type === "run_started"), false, "no model call, no tool run");
    await noRunning(u);
  });
});
