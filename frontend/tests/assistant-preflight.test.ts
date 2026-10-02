// The production preflight (services/assistant/preflight.ts). PURE: the database probe is a fake, and the platform fetch is a tripwire.
// Pinned: a complete, real-looking configuration with a migrated database is ready while the activation gate stays refused; each missing
// piece fails its own check by NAME; placeholder keys and reserved test hosts are caught; a probe failure is reported without its message;
// and no value (key, endpoint, model, limit, database address) appears anywhere in the report.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { runAssistantPreflight } from "../services/assistant/preflight";
import type { PreflightDatabase } from "../services/assistant/preflight";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";

// A key and endpoint SHAPED like production ones, so the placeholder check passes. Neither is real.
const KEY = "gwkey-7Hq2Lm9Vx4Rt8Wz1Np6Ks3Df5Gb0Jc";
const ENDPOINT = "https://models.smartca-gateway.net/v1/chat/completions";
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: "gpt-model-2026",
  MODEL_APPROVED_RECIPIENTS: "provider-main", MODEL_TIMEOUT_MS: "30000", MODEL_MAX_OUTPUT_CHARS: "20000", MODEL_MAX_OUTPUT_TOKENS: "2048",
  MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "30",
  ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "200000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "50", ASSISTANT_RUN_RETENTION_DAYS: "90",
  DATABASE_URL: "postgresql://db.internal:5432/smartca",
};
const HEALTHY: PreflightDatabase = { migrationsApplied: 6, migrationsExpected: 6, missingTables: [] };
const probe = (db: PreflightDatabase) => async () => db;

const realFetch = globalThis.fetch;
let fetches = 0;
before(() => {
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("the preflight must never contact anything");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(fetches, 0, "the preflight contacted nothing");
});

const checkOf = (report: Awaited<ReturnType<typeof runAssistantPreflight>>, name: string) => report.checks.find((c) => c.name === name);
function assertNoValues(report: unknown) {
  const text = JSON.stringify(report);
  for (const value of [KEY, ENDPOINT, "smartca-gateway", "gpt-model-2026", "provider-main", "db.internal", "200000", "2048"]) {
    assert.equal(text.includes(value), false, `the report leaked ${value.slice(0, 10)}…`);
  }
}

test("a complete configuration and a migrated database are ready, and the activation gate is reported as still refused", async () => {
  const report = await runAssistantPreflight(ENV, probe(HEALTHY));
  assert.equal(report.ready, true, JSON.stringify(report.checks));
  assert.equal(report.externalModeActive, false);
  assert.deepEqual(report.checks.map((c) => c.name), ["external configuration", "provider target", "wire format", "not a placeholder", "database migrations", "assistant tables", "consent inventory", "activation gate"]);
  assert.match(checkOf(report, "activation gate")?.detail ?? "", /refused by readAssistantConfig/);
  assert.ok(checkOf(report, "consent inventory")?.detail.includes(fingerprintInventory()));
  assertNoValues(report);
});

test("each missing or invalid variable fails the configuration check by name; dependent checks are not run on a bad configuration", async () => {
  for (const [name, over] of [["MODEL_WIRE_FORMAT", { MODEL_WIRE_FORMAT: "" }], ["MODEL_MAX_OUTPUT_TOKENS", { MODEL_MAX_OUTPUT_TOKENS: "0" }], ["MODEL_APPROVED_RECIPIENTS", { MODEL_APPROVED_RECIPIENTS: "a,b" }], ["ASSISTANT_RUN_RETENTION_DAYS", { ASSISTANT_RUN_RETENTION_DAYS: "" }], ["ASSISTANT_ENV", { ASSISTANT_ENV: "synthetic" }]] as const) {
    const report = await runAssistantPreflight({ ...ENV, ...over }, probe(HEALTHY));
    assert.equal(report.ready, false, name);
    const check = checkOf(report, "external configuration");
    assert.equal(check?.ok, false);
    assert.match(check?.detail ?? "", new RegExp(name), name);
    assert.equal(checkOf(report, "wire format"), undefined);
    assertNoValues(report);
  }
});

test("placeholder keys and reserved test hosts are not production values", async () => {
  for (const [over, variable] of [
    [{ MODEL_API_KEY: "test-key-NOT-A-REAL-SECRET-0001" }, "MODEL_API_KEY"],
    [{ MODEL_API_KEY: "your-key-here" }, "MODEL_API_KEY"],
    [{ MODEL_API_KEY: "changeme" }, "MODEL_API_KEY"],
    [{ MODEL_ENDPOINT: "https://provider.invalid/v1/chat/completions" }, "MODEL_ENDPOINT"],
    [{ MODEL_ENDPOINT: "https://api.example.com/v1/chat/completions" }, "MODEL_ENDPOINT"],
    [{ MODEL_ENDPOINT: "https://localhost/v1/chat/completions" }, "MODEL_ENDPOINT"],
  ] as const) {
    const report = await runAssistantPreflight({ ...ENV, ...over }, probe(HEALTHY));
    assert.equal(report.ready, false, JSON.stringify(over));
    const check = checkOf(report, "not a placeholder");
    assert.deepEqual([check?.ok, check?.detail.endsWith(variable)], [false, true], JSON.stringify(over));
    assert.equal(JSON.stringify(report).includes(Object.values(over)[0]), false, "the value is not echoed");
  }
});

test("an unmigrated database or missing assistant tables fail; a probe that throws is reported without its message", async () => {
  const behind = await runAssistantPreflight(ENV, probe({ migrationsApplied: 4, migrationsExpected: 6, missingTables: ["assistant_runs"] }));
  assert.equal(behind.ready, false);
  assert.deepEqual([checkOf(behind, "database migrations")?.ok, checkOf(behind, "database migrations")?.detail], [false, "4 of 6 applied"]);
  assert.deepEqual([checkOf(behind, "assistant tables")?.ok, checkOf(behind, "assistant tables")?.detail], [false, "missing: assistant_runs"]);

  const broken = await runAssistantPreflight(ENV, async () => {
    throw new Error(`connect ECONNREFUSED ${ENV.DATABASE_URL}`);
  });
  assert.equal(broken.ready, false);
  assert.equal(checkOf(broken, "database")?.ok, false);
  assertNoValues(broken);
  assert.doesNotMatch(JSON.stringify(broken), /ECONNREFUSED|postgresql:/);
});
