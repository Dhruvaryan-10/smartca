// The EXTERNAL configuration (services/assistant/config.ts, validateExternalEnv). PURE: no database, no network. What is pinned: every
// value an external run needs is required and validated, including the per-user limits, the provider's output-token cap and exactly one
// approved recipient; errors name
// variables, never values; the key cannot leak through an error; and the reader STILL refuses external mode, with nothing but tests
// able to build an external configuration.
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_LIMIT_ENV_NAMES, ASSISTANT_PROVIDER_ENV_NAMES, AssistantConfigError, MAX_MODEL_OUTPUT_TOKENS, RUN_LIMIT_CEILINGS, RUN_RETENTION_DAYS_BOUNDS, readAssistantConfig, readRunRetentionDays, validateExternalEnv,
} from "../services/assistant/config";
import { MAX_MESSAGE_CHARS } from "../services/assistant/model";

const FRONTEND = path.resolve(__dirname, "..");
const KEY = "test-key-NOT-A-REAL-SECRET-0006";
const GOOD: Record<string, string> = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_ENV: "external",
  MODEL_ENDPOINT: "https://provider.invalid/v1",
  MODEL_API_KEY: KEY,
  MODEL_ID: "fixture-model-1",
  MODEL_APPROVED_RECIPIENTS: "recipient-a",
  MODEL_TIMEOUT_MS: "5000",
  MODEL_MAX_OUTPUT_CHARS: "20000",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600",
  ASSISTANT_MAX_RUNS_PER_WINDOW: "30",
  ASSISTANT_MAX_CONCURRENT_RUNS: "1",
  ASSISTANT_MAX_TOKENS_PER_WINDOW: "200000",
  ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100",
  MODEL_MAX_OUTPUT_TOKENS: "1024", MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RUN_RETENTION_DAYS: "400",
};
const rejection = (env: Record<string, string | undefined>): AssistantConfigError => {
  try {
    validateExternalEnv(env);
  } catch (error) {
    assert.ok(error instanceof AssistantConfigError, String(error));
    assert.equal([String(error), JSON.stringify(error), inspect(error), error.stack ?? ""].join("\n").includes(KEY), false, "the key is never in an error");
    return error;
  }
  throw new assert.AssertionError({ message: "expected the external configuration to be refused" });
};

test("a complete external configuration validates, with its limits and its one recipient", () => {
  const config = validateExternalEnv(GOOD);
  assert.equal(config.env, "external");
  assert.deepEqual(config.approvedRecipients, ["recipient-a"]);
  assert.deepEqual({ ...config.limits }, { windowSeconds: 3600, maxRunsPerWindow: 30, maxConcurrentRuns: 1, maxTokensPerWindow: 200000, maxGlobalConcurrentRuns: 100 });
  assert.equal(config.runRetentionDays, 400);
  assert.equal(config.maxOutputTokens, 1024);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.limits));
  assert.equal(JSON.stringify(config).includes(KEY), false, "the key renders redacted");
});

test("it must be enabled and explicitly external", () => {
  assert.equal(rejection({ ...GOOD, ASSISTANT_ENABLED: "false" }).code, "assistant_disabled");
  for (const env of ["synthetic", "", "External", "real"]) assert.deepEqual([rejection({ ...GOOD, ASSISTANT_ENV: env }).code, rejection({ ...GOOD, ASSISTANT_ENV: env }).variables], ["invalid_configuration", ["ASSISTANT_ENV"]], env);
});

test("every limit (per user and global) is required, and each out-of-bounds value is refused by name", () => {
  for (const name of ASSISTANT_LIMIT_ENV_NAMES) {
    const missing = rejection({ ...GOOD, [name]: undefined });
    assert.deepEqual([missing.code, missing.variables], ["missing_configuration", [name]], name);
    for (const bad of ["0", "00", "-1", "+1", "1.5", "5.0", "1e3", "0x10", "ten", "NaN", "Infinity", "-Infinity", " ", "5 5", `${10 ** 9}`, "9".repeat(20)]) {
      assert.deepEqual(rejection({ ...GOOD, [name]: bad }).variables, [name], `${name}=${bad}`);
    }
  }
  assert.deepEqual(rejection({ ...GOOD, ASSISTANT_MAX_CONCURRENT_RUNS: String(RUN_LIMIT_CEILINGS.maxConcurrentRuns + 1) }).variables, ["ASSISTANT_MAX_CONCURRENT_RUNS"]);
});

test("MODEL_MAX_OUTPUT_TOKENS is required, plain digits from 1 to its ceiling, and refused by name only, never by value", () => {
  assert.deepEqual([...ASSISTANT_PROVIDER_ENV_NAMES], ["MODEL_MAX_OUTPUT_TOKENS", "MODEL_WIRE_FORMAT"]);
  for (const missing of [undefined, "", "   "]) {
    const error = rejection({ ...GOOD, MODEL_MAX_OUTPUT_TOKENS: missing });
    assert.deepEqual([error.code, error.variables], ["missing_configuration", ["MODEL_MAX_OUTPUT_TOKENS"]], JSON.stringify(missing));
  }
  const malformed = [
    "0", "00", "-1", "-0", "+1", "+1024", "1.5", "1024.0", ".5", "1e3", "1E3", "0x10", "0b1", "1_000", "1,000", "ten", "NaN", "Infinity", "-Infinity",
    " 1024", "1024 ", " 1024 ", "\t1024", "1024\n", "10 24", String(MAX_MODEL_OUTPUT_TOKENS + 1), `${10 ** 9}`, "9".repeat(20),
  ];
  for (const bad of malformed) {
    const error = rejection({ ...GOOD, MODEL_MAX_OUTPUT_TOKENS: bad });
    assert.deepEqual([error.code, error.variables], ["invalid_configuration", ["MODEL_MAX_OUTPUT_TOKENS"]], JSON.stringify(bad));
    if (bad.trim() !== "") assert.equal([error.message, String(error), JSON.stringify(error)].join("\n").includes(bad.trim()), false, `the value ${JSON.stringify(bad)} is not in the error`);
  }
  assert.equal(validateExternalEnv({ ...GOOD, MODEL_MAX_OUTPUT_TOKENS: "1" }).maxOutputTokens, 1);
  assert.equal(validateExternalEnv({ ...GOOD, MODEL_MAX_OUTPUT_TOKENS: String(MAX_MODEL_OUTPUT_TOKENS) }).maxOutputTokens, MAX_MODEL_OUTPUT_TOKENS);
});

test("the output-token ceiling is the model contract's own output bound, the same one MODEL_MAX_OUTPUT_CHARS is held to", () => {
  assert.equal(MAX_MODEL_OUTPUT_TOKENS, MAX_MESSAGE_CHARS);
  // The two output bounds are independent: neither is derived from, or validated against, the other.
  assert.equal(validateExternalEnv({ ...GOOD, MODEL_MAX_OUTPUT_CHARS: "100", MODEL_MAX_OUTPUT_TOKENS: "4000" }).maxOutputChars, 100);
  assert.equal(validateExternalEnv({ ...GOOD, MODEL_MAX_OUTPUT_CHARS: "20000", MODEL_MAX_OUTPUT_TOKENS: "16" }).maxOutputTokens, 16);
});

test("the model settings are required and validated exactly as for any mode, and more than one recipient is refused", () => {
  assert.deepEqual(rejection({ ...GOOD, MODEL_API_KEY: undefined }).variables, ["MODEL_API_KEY"]);
  assert.deepEqual(rejection({ ...GOOD, MODEL_ENDPOINT: "http://provider.invalid" }).variables, ["MODEL_ENDPOINT"]);
  assert.deepEqual(rejection({ ...GOOD, MODEL_ENDPOINT: "https://user:pass@provider.invalid" }).variables, ["MODEL_ENDPOINT"]);
  assert.deepEqual(rejection({ ...GOOD, MODEL_APPROVED_RECIPIENTS: "recipient-a,recipient-b" }).variables, ["MODEL_APPROVED_RECIPIENTS"]);
});

test("the reader still refuses external mode: nothing a deployment's environment sets can produce an external configuration", () => {
  assert.throws(() => readAssistantConfig(GOOD), (e: unknown) => e instanceof AssistantConfigError && e.code === "real_data_mode_not_permitted");
});

test("only config.ts and tests refer to validateExternalEnv: no server code can reach external mode by another path", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && fs.readFileSync(full, "utf8").includes("validateExternalEnv")) offenders.push(path.relative(FRONTEND, full).replace(/\\/g, "/"));
    }
  };
  for (const dir of ["app", "services", "lib", "db", "scripts", "tax-engine"]) if (fs.existsSync(path.join(FRONTEND, dir))) walk(path.join(FRONTEND, dir));
  // The operator preflight (preflight.ts, reached only from scripts/assistant-preflight.ts, pinned in the layering test) VALIDATES an
  // external environment and reports on it; it never returns the configuration to anything that runs, so it cannot reach external mode.
  assert.deepEqual(offenders, ["services/assistant/config.ts", "services/assistant/preflight.ts"]);
  assert.doesNotMatch(fs.readFileSync(path.join(FRONTEND, "services/assistant/preflight.ts"), "utf8"), /askExternal|createProviderAdapter|handleAssistantRequest|\.complete\(|transport\(/);
});

test("every limit accepts values up to its ceiling, whatever their number of digits", () => {
  // A token budget of 10,000,000 or more must be accepted (it was not, when limits shared the 7-digit pattern).
  for (const tokens of ["10000000", "20000000", String(RUN_LIMIT_CEILINGS.maxTokensPerWindow)]) {
    assert.equal(validateExternalEnv({ ...GOOD, ASSISTANT_MAX_TOKENS_PER_WINDOW: tokens }).limits.maxTokensPerWindow, Number(tokens));
  }
  assert.deepEqual(rejection({ ...GOOD, ASSISTANT_MAX_TOKENS_PER_WINDOW: String(RUN_LIMIT_CEILINGS.maxTokensPerWindow + 1) }).variables, ["ASSISTANT_MAX_TOKENS_PER_WINDOW"]);
  const atCeiling = { ...GOOD, ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: String(RUN_LIMIT_CEILINGS.maxGlobalConcurrentRuns) };
  for (const [name, key] of [["ASSISTANT_RATE_WINDOW_SECONDS", "windowSeconds"], ["ASSISTANT_MAX_RUNS_PER_WINDOW", "maxRunsPerWindow"], ["ASSISTANT_MAX_CONCURRENT_RUNS", "maxConcurrentRuns"], ["ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS", "maxGlobalConcurrentRuns"]] as const) {
    assert.equal(validateExternalEnv({ ...atCeiling, [name]: String(RUN_LIMIT_CEILINGS[key]) }).limits[key], RUN_LIMIT_CEILINGS[key]);
    assert.equal(validateExternalEnv({ ...GOOD, [name]: "1" }).limits[key], 1);
  }
  assert.deepEqual(rejection({ ...GOOD, ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: String(RUN_LIMIT_CEILINGS.maxGlobalConcurrentRuns + 1) }).variables, ["ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS"]);
  assert.deepEqual(Object.keys(validateExternalEnv(GOOD).limits).sort(), ["maxConcurrentRuns", "maxGlobalConcurrentRuns", "maxRunsPerWindow", "maxTokensPerWindow", "windowSeconds"]);
  assert.deepEqual(ASSISTANT_LIMIT_ENV_NAMES.filter((n) => n.includes("GLOBAL")), ["ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS"], "the global cap is required configuration (ADR 0003)");
});

test("an impossible pair is refused: a person's concurrency above everyone's", () => {
  const error = rejection({ ...GOOD, ASSISTANT_MAX_CONCURRENT_RUNS: "5", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "4" });
  assert.deepEqual([error.code, [...error.variables].sort()], ["invalid_configuration", ["ASSISTANT_MAX_CONCURRENT_RUNS", "ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS"]]);
  assert.equal(validateExternalEnv({ ...GOOD, ASSISTANT_MAX_CONCURRENT_RUNS: "4", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "4" }).limits.maxGlobalConcurrentRuns, 4);
});

test("run retention is required for an external configuration, and is readable on its own for the retention job, failing closed", () => {
  assert.deepEqual([rejection({ ...GOOD, ASSISTANT_RUN_RETENTION_DAYS: undefined }).code, rejection({ ...GOOD, ASSISTANT_RUN_RETENTION_DAYS: undefined }).variables], ["missing_configuration", ["ASSISTANT_RUN_RETENTION_DAYS"]]);
  for (const bad of ["0", "-1", "1.5", "ten", " ", String(RUN_RETENTION_DAYS_BOUNDS.max + 1)]) {
    assert.deepEqual(rejection({ ...GOOD, ASSISTANT_RUN_RETENTION_DAYS: bad }).variables, ["ASSISTANT_RUN_RETENTION_DAYS"], bad);
    assert.throws(() => readRunRetentionDays({ ASSISTANT_RUN_RETENTION_DAYS: bad }), (e: unknown) => e instanceof AssistantConfigError && e.variables.includes("ASSISTANT_RUN_RETENTION_DAYS") && (bad.trim() === "" || !e.message.includes(`${bad}.`)));
  }
  assert.throws(() => readRunRetentionDays({}), (e: unknown) => e instanceof AssistantConfigError && e.code === "missing_configuration");
  assert.equal(readRunRetentionDays({ ASSISTANT_RUN_RETENTION_DAYS: "1" }), 1);
  assert.equal(readRunRetentionDays({ ASSISTANT_RUN_RETENTION_DAYS: String(RUN_RETENTION_DAYS_BOUNDS.max) }), RUN_RETENTION_DAYS_BOUNDS.max);
});

test("the shortest retention outlasts the longest limit window, so the retention job can never delete a row a limit still counts", () => {
  assert.ok(RUN_RETENTION_DAYS_BOUNDS.min * 86_400 >= RUN_LIMIT_CEILINGS.windowSeconds);
});
