// The external entry point with the REAL, database-backed tools behind it (services/assistant/external.ts), and the recording test
// provider (helpers-provider.ts) at the provider boundary: no real provider, no network. It needs the local PostgreSQL (the tools read
// the seeded assessment year and the caller's own ledger; one test writes a throwaway user and ledger, and deletes them).
//
// What is pinned: an authorized request reaches the provider at the CONFIGURED endpoint and model, offered exactly the plan's tools; the
// provider is sent each tool result as the egress filter shows it, never the raw ledger rows (no user id, no row id, no unrequested
// description) and never a SmartCA credential; the caller cannot redirect it; tool gating and the model limits still hold; and every
// provider failure comes out typed, with a stable public code and nothing of the provider or the key in it.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXTERNAL_PROFILE, askExternal } from "../services/assistant/external";
import { validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { ModelProviderError } from "../services/assistant/model";
import type { ModelAdapter } from "../services/assistant/model";
import { ASSISTANT_TOOL_DEFINITIONS, OrchestratorError } from "../services/assistant/orchestrator";
import { toAssistantApiError, toAssistantApiResponse } from "../services/assistant/api-contract";
import type { AccessAuditRecord } from "../lib/assistant/access-plan";
import { AUTHORIZATION_VERSION } from "../lib/assistant/authorization";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { filterToolResult } from "../lib/assistant/egress-filter";
import { EGRESS_FIELD_CLASSES, FULL_PROFILE } from "../lib/assistant/profiles";
import { ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import { createAssistantTools } from "../services/assistant/tools";
import { createTransaction } from "../services/transactions";
import { deleteTestUser, makeTestUser } from "./helpers";
import { testProvider, toolMessagesSent } from "./helpers-provider";
import type { WireStep } from "./helpers-provider";

const USER = "0b6f5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const RECIPIENT = "recipient-a";
const ENDPOINT = "https://provider.invalid/v1/complete";
const MODEL_ID = "fixture-model-1";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const KEY = "test-key-NOT-A-REAL-SECRET-0003";
/** An external configuration comes only from validateExternalEnv: the reader never produces one. */
const external = (over: Record<string, string> = {}): AssistantConfig =>
  validateExternalEnv({
    ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: MODEL_ID,
    MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "5000", MODEL_MAX_OUTPUT_CHARS: "20000", ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "100", ASSISTANT_MAX_CONCURRENT_RUNS: "2", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", MODEL_MAX_OUTPUT_TOKENS: "1024", ASSISTANT_RUN_RETENTION_DAYS: "400", ...over,
  });
const CONFIG = external();
const TAX = { assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
const authorization = (userId = USER, dataClasses: readonly string[] = EGRESS_FIELD_CLASSES) => ({
  version: AUTHORIZATION_VERSION, authorizationId: "auth_db_0001", userId, profileId: "full", recipient: RECIPIENT, consent: "granted",
  dataClasses, issuedAt: "2026-09-29T10:00:00Z", expiresAt: "2026-09-29T14:00:00Z", inventoryVersion: fingerprintInventory(),
});
const tools = (...calls: Array<[string, string, unknown]>): WireStep => ({ reply: { kind: "tool_calls", calls: calls.map(([id, name, args]) => ({ id, name, args })) } });
const done: WireStep = { reply: { kind: "text", text: "The engine computed the figures above." } };
const run = (steps: WireStep[], over: Record<string, unknown> = {}, config = CONFIG, userId = USER) => {
  const provider = testProvider(...steps);
  const promise = askExternal(config, { userId, userMessages: ["What is my tax?"] }, { driver: provider.driver, authorization: authorization(userId), now: NOW, ...over });
  return { promise, calls: provider.calls };
};

// --- the authorized path ----------------------------------------------------------------------------------------------------

test("an authorized request reaches the configured provider, offered the full profile's tools, and each real tool result as filtered", async () => {
  const LAW = { question: "What is the Section 87A rebate limit?", assessmentYear: "2026-27" };
  const SIM = { regime: "old", base: { ...TAX, deductions: {} }, scenario: TAX };
  const audits: AccessAuditRecord[] = [];
  const { promise, calls } = run(
    [
      tools(["c1", "calculate_tax", { regime: "old", ...TAX }], ["c2", "compare_tax_regimes", TAX], ["c3", "query_transactions", { includeDescription: true }]),
      tools(["c4", "get_financial_summary", {}], ["c5", "simulate_tax", SIM], ["c6", "search_tax_law", LAW]),
      done,
    ],
    { onAccessPlanned: (a: AccessAuditRecord) => audits.push(a) },
  );
  const answer = await promise;
  assert.equal(answer.state, "answered");
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.url, ENDPOINT, "the configured endpoint");
    assert.equal(c.sent.model, MODEL_ID, "the configured model");
    assert.deepEqual(c.sent.tools, ASSISTANT_TOOL_DEFINITIONS, "exactly the full profile's six tools");
  }
  const real = createAssistantTools();
  const raw = [
    ["calculate_tax", await real.calculate_tax(USER, { regime: "old", ...TAX })],
    ["compare_tax_regimes", await real.compare_tax_regimes(USER, TAX)],
    ["query_transactions", await real.query_transactions(USER, { includeDescription: true })],
    ["get_financial_summary", await real.get_financial_summary(USER, {})],
    ["simulate_tax", await real.simulate_tax(USER, SIM)],
    ["search_tax_law", await real.search_tax_law(USER, LAW)],
  ] as const;
  const plan = audits[0];
  const visible = Object.fromEntries(EGRESS_FIELD_CLASSES.map((c) => [c, plan.visibleClasses.includes(c)])) as never;
  assert.deepEqual(
    toolMessagesSent([calls[2]]).map((m) => m.content),
    raw.map(([tool, result]) => JSON.stringify(filterToolResult(tool, result, visible))),
    "the provider is sent exactly the egress filter's view of each real result",
  );
  assert.equal(answer.facts.taxValues.length, 3);
  assert.equal(plan.inventoryVersion, fingerprintInventory());
  assert.deepEqual([...EXTERNAL_PROFILE.tools], [...FULL_PROFILE.tools]);
});

test("the provider sees the filtered representation, never the raw ledger rows: no user id, no row id, no unrequested description, no credential", async () => {
  const user = await makeTestUser("external-egress");
  try {
    const marker = "DESC-MARKER-7f3a";
    const rows = [
      await createTransaction(user.id, { type: "expense", amountPaise: 45_000, category: "Groceries", description: `Weekly shop ${marker}`, source: "UPI", occurredOn: "2026-03-05" }),
      await createTransaction(user.id, { type: "income", amountPaise: 900_000, category: "Salary", description: `March pay ${marker}`, source: "Bank", occurredOn: "2026-03-01" }),
    ];
    const { promise, calls } = run([tools(["c1", "query_transactions", {}], ["c2", "get_financial_summary", {}]), done], {}, CONFIG, user.id);
    await promise;
    const wire = calls.map((c) => `${c.url}\n${JSON.stringify(c.headers)}\n${c.body}`).join("\n");
    const bodies = calls.map((c) => c.body).join("\n");
    assert.match(bodies, /Groceries/, "authorized ledger fields do cross");
    assert.match(bodies, /45000/);
    assert.equal(bodies.includes(marker), false, "descriptions were not asked for, so none crossed");
    assert.equal(bodies.includes(user.id), false, "the user id never reaches the provider");
    for (const secret of [process.env.DATABASE_URL, process.env.AUTH_SECRET, KEY].filter((s): s is string => typeof s === "string" && s.length > 0)) {
      assert.equal(bodies.includes(secret), false, "no credential in any body");
    }
    assert.equal(wire.includes(process.env.DATABASE_URL ?? "\u0000"), false, "not even in headers");
    for (const field of ["userId", "createdAt", "importBatchId"]) assert.equal(bodies.includes(field), false, `no raw row field ${field}`);
    for (const row of rows) assert.equal(bodies.includes(String(row.id)), false, "no database row id crosses");
  } finally {
    await deleteTestUser(user.id);
  }
});

test("a tool outside the authorized plan cannot run, even though the real tool set contains it", async () => {
  const { promise, calls } = run([tools(["c1", "search_tax_law", { question: "What is the 87A rebate?", assessmentYear: "2026-27" }])], {
    authorization: authorization(USER, ["user_free_text", "user_financial_data", "system_value"]),
  });
  await assert.rejects(promise, (e: unknown) => e instanceof OrchestratorError && e.code === "unknown_tool" && e.toolActivity.length === 0);
  assert.equal(calls.length, 1, "the refused call was never answered");
  assert.deepEqual(calls[0].sent.tools.map((t) => t.name), ASSISTANT_TOOL_NAMES.filter((t) => t !== "search_tax_law"));
});

test("the caller cannot redirect the request: a model, recipient, endpoint, model id, recipient list, profile or tool list passed alongside is ignored", async () => {
  let evilCalled = false;
  const evil: ModelAdapter = { complete: async () => { evilCalled = true; return { kind: "text", text: "pwned", meta: { recipient: "evil", model: "evil" } }; } };
  const { promise, calls } = run([done], {
    model: evil, recipient: "evil", endpoint: "https://evil.invalid", modelId: "evil-model", approvedRecipients: ["evil"],
    profile: { id: "god", tools: ["delete_ledger"], classes: {} }, allowedTools: ["delete_ledger"], tools: {}, visibleClasses: {},
  });
  await promise;
  assert.equal(evilCalled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].sent.model, MODEL_ID);
  assert.deepEqual(calls[0].sent.tools.map((t) => t.name), [...ASSISTANT_TOOL_NAMES]);
});

// --- model limits and provider failures ---------------------------------------------------------------------------------------

test("model limits hold through the whole path: a hanging provider times out, an oversized answer is refused", async () => {
  const hang = run([{ hang: true }], {}, external({ MODEL_TIMEOUT_MS: "40" }));
  await assert.rejects(hang.promise, (e: unknown) => e instanceof ModelProviderError && e.code === "timeout");
  const big = run([{ reply: { kind: "text", text: "x".repeat(600) } }], {}, external({ MODEL_MAX_OUTPUT_CHARS: "500" }));
  await assert.rejects(big.promise, (e: unknown) => e instanceof ModelProviderError && e.code === "output_too_large");
});

test("every provider failure comes out typed, with a stable public code, and nothing of the provider or the key in it", async () => {
  const cases: Array<[WireStep, string, boolean]> = [
    [{ status: 503, body: `upstream down ${KEY}` }, "provider_unavailable", true],
    [{ throws: "connection refused" }, "provider_unavailable", true],
    [{ status: 429, body: "slow down" }, "provider_rate_limited", true],
    [{ status: 400, body: "bad request" }, "provider_rejected", false],
    [{ status: 401, body: `invalid key ${KEY}` }, "provider_configuration", false],
    [{ status: 200, body: "not json" }, "provider_invalid_response", false],
    [{ reply: { kind: "text", text: "hi" }, model: "another-model" }, "provider_invalid_response", false],
    [{ reply: { kind: "nonsense" } }, "provider_invalid_response", false],
  ];
  for (const [step, code, retryable] of cases) {
    const { promise } = run([step]);
    const response = await toAssistantApiResponse(() => promise);
    assert.equal(response.ok, false, JSON.stringify(step));
    if (response.ok) continue;
    assert.deepEqual([response.error.code, response.error.retryable], [code, retryable], JSON.stringify(step));
    const everything = JSON.stringify(response);
    for (const leak of [KEY, "upstream", "invalid key", "connection refused", ENDPOINT, USER]) assert.equal(everything.includes(leak), false, `${code} leaked ${leak}`);
  }
  // The same path, as the typed error itself: the provider's text never reaches it either.
  await run([{ status: 503, body: `upstream down ${KEY}` }]).promise.catch((e: unknown) => {
    assert.ok(e instanceof ModelProviderError);
    assert.equal(`${String(e)} ${JSON.stringify(e)} ${(e as Error).stack}`.includes(KEY), false);
    assert.equal(toAssistantApiError(e).code, "provider_unavailable");
  });
});
