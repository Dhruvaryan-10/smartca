// The external entry point (services/assistant/external.ts). PURE: no database, no DATABASE_URL, no network, no provider: the provider is
// the recording test provider (helpers-provider.ts). Every case here is refused BEFORE a run starts, because a run that reaches the model
// loads the real, database-backed tool set (runAssistant does that at the start of any run that is given no tools, and askExternal gives
// none). Runs are in assistant-external.db.test.ts.
//
// What is pinned, with ZERO provider calls in every case: the profile is the server's (EXTERNAL_PROFILE) and cannot be chosen or widened by
// the request; nothing runs without the person's explicit authorization, for this user and the configured recipient; the configuration,
// not the caller, decides the recipient, and it must approve exactly one; the reader still cannot produce an external configuration;
// synthetic mode is untouched.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { askExternal } from "../services/assistant/external";
import type { ExternalRunOptions } from "../services/assistant/external";
import { AssistantConfigError, readAssistantConfig, validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { OrchestratorError } from "../services/assistant/orchestrator";
import { AUTHORIZATION_VERSION, AssistantAuthorizationError } from "../lib/assistant/authorization";
import type { AssistantAuthorization, AssistantAuthorizationErrorCode } from "../lib/assistant/authorization";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { EGRESS_FIELD_CLASSES, SYNTHETIC_PROFILE } from "../lib/assistant/profiles";
import { ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import { SYNTHETIC_TOOL_NAMES } from "../services/assistant/synthetic-tools";
import { NotAuthenticatedError } from "../services/errors";
import { testProvider } from "./helpers-provider";

const FRONTEND = path.resolve(__dirname, "..");
const USER = "8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const KEY = "test-key-NOT-A-REAL-SECRET-0002";
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_ENV: "synthetic",
  MODEL_ENDPOINT: "https://provider.invalid/v1",
  MODEL_API_KEY: KEY,
  MODEL_ID: "fixture-v1",
  MODEL_APPROVED_RECIPIENTS: RECIPIENT,
  MODEL_TIMEOUT_MS: "200",
  MODEL_MAX_OUTPUT_CHARS: "2000",
};
/** An external configuration comes only from validateExternalEnv: the reader never produces one. */
const external = (over: Record<string, string> = {}): AssistantConfig => validateExternalEnv({ ...ENV, ASSISTANT_ENV: "external", ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "100", ASSISTANT_MAX_CONCURRENT_RUNS: "2", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", MODEL_MAX_OUTPUT_TOKENS: "1024", ASSISTANT_RUN_RETENTION_DAYS: "400", ...over });
const INPUT = { userId: USER, userMessages: ["What does SmartCA know about my finances?"] };

const grant = (over: Record<string, unknown> = {}): AssistantAuthorization =>
  ({
    version: AUTHORIZATION_VERSION,
    authorizationId: "auth_0001",
    userId: USER,
    profileId: "full",
    recipient: RECIPIENT,
    consent: "granted",
    dataClasses: [...EGRESS_FIELD_CLASSES],
    issuedAt: "2026-09-29T10:00:00Z",
    expiresAt: "2026-09-29T14:00:00Z",
    inventoryVersion: fingerprintInventory(),
    ...over,
  }) as AssistantAuthorization;

/** Run askExternal against a recording provider; the returned `calls` are what reached the provider boundary. */
function attempt(over: Partial<ExternalRunOptions> & Record<string, unknown> = {}, config = external(), input: unknown = INPUT) {
  const provider = testProvider();
  const run = askExternal(config, input as never, { driver: provider.driver, authorization: grant(), now: NOW, ...over });
  return { run, calls: provider.calls };
}

async function refusedBeforeProvider(code: AssistantAuthorizationErrorCode, over: Partial<ExternalRunOptions>, config = external()) {
  const { run, calls } = attempt(over, config);
  await assert.rejects(run, (e: unknown) => e instanceof AssistantAuthorizationError && e.code === code, code);
  assert.equal(calls.length, 0, `${code}: zero provider calls`);
}

// --- consent ------------------------------------------------------------------------------------------------------------------

test("without explicit consent nothing runs: absent, not granted, a bare intention, or malformed", async () => {
  await refusedBeforeProvider("consent_not_given", { authorization: undefined });
  await refusedBeforeProvider("consent_not_given", { authorization: null });
  await refusedBeforeProvider("consent_not_given", { authorization: grant({ consent: "not_granted" }) });
  await refusedBeforeProvider("consent_not_given", { authorization: { intent: "use everything" } });
  await refusedBeforeProvider("authorization_invalid", { authorization: true });
  await refusedBeforeProvider("authorization_invalid", { authorization: { consent: "granted" } });
  await refusedBeforeProvider("authorization_expired", { now: Date.UTC(2026, 8, 30) });
});

test("consent for another user, or for a recipient other than the configured one, is not this run's consent", async () => {
  await refusedBeforeProvider("binding_mismatch", { authorization: grant({ userId: "someone-else" }) });
  await refusedBeforeProvider("binding_mismatch", { authorization: grant({ recipient: "recipient-b" }) });
  // The configuration names another recipient: the person's consent for recipient-a does not carry over to it.
  await refusedBeforeProvider("binding_mismatch", {}, external({ MODEL_APPROVED_RECIPIENTS: "recipient-z" }));
});

// --- the profile is the server's --------------------------------------------------------------------------------------------

test("a request cannot choose or widen the profile: extra input fields are refused before any provider call", async () => {
  for (const extra of [{ profile: "full" }, { profile: SYNTHETIC_PROFILE }, { allowedTools: [...ASSISTANT_TOOL_NAMES] }, { visibleClasses: { user_free_text: true } }, { recipient: "evil" }, { model: "evil" }]) {
    const { run, calls } = attempt({}, external(), { ...INPUT, ...extra });
    await assert.rejects(run, (e: unknown) => e instanceof OrchestratorError && e.code === "invalid_input", JSON.stringify(extra));
    assert.equal(calls.length, 0);
  }
});

test("consent given for another egress inventory is refused before any provider call", async () => {
  await refusedBeforeProvider("inventory_changed", { authorization: grant({ inventoryVersion: "inv1-00000000" }) });
});

test("an authorization given for another profile is refused: consent to one mode does not carry to another", async () => {
  await refusedBeforeProvider("profile_mismatch", { authorization: grant({ profileId: "synthetic" }) });
  await refusedBeforeProvider("profile_mismatch", { authorization: grant({ profileId: "god" }) });
});

// --- the configuration decides the recipient ---------------------------------------------------------------------------------

test("an external configuration must approve exactly one recipient: more is refused before any provider call", async () => {
  // The validator already refuses it; a configuration built past the validator is refused by askExternal too.
  assert.throws(() => external({ MODEL_APPROVED_RECIPIENTS: `${RECIPIENT},recipient-b` }), (e: unknown) => e instanceof AssistantConfigError && e.variables.includes("MODEL_APPROVED_RECIPIENTS"));
  const { run, calls } = attempt({}, { ...(external() as Extract<AssistantConfig, { env: "external" }>), approvedRecipients: [RECIPIENT, "recipient-b"] });
  await assert.rejects(run, (e: unknown) => e instanceof AssistantConfigError && e.code === "invalid_configuration" && e.variables.includes("MODEL_APPROVED_RECIPIENTS"));
  assert.equal(calls.length, 0);
});

test("the configuration reader still cannot produce an external configuration, and askExternal refuses any other", async () => {
  assert.throws(() => readAssistantConfig({ ...ENV, ASSISTANT_ENV: "external" }), (e: unknown) => e instanceof AssistantConfigError && e.code === "real_data_mode_not_permitted");
  for (const [config, code] of [[readAssistantConfig(ENV), "invalid_configuration"], [{ enabled: false }, "assistant_disabled"]] as Array<[AssistantConfig, string]>) {
    const { run, calls } = attempt({}, config);
    await assert.rejects(run, (e: unknown) => e instanceof AssistantConfigError && e.code === code);
    assert.equal(calls.length, 0);
  }
  const { run, calls } = attempt({}, external(), { userId: "", userMessages: ["hi"] });
  await assert.rejects(run, NotAuthenticatedError);
  assert.equal(calls.length, 0);
});

test("the key appears in no refusal", async () => {
  const seen: string[] = [];
  for (const over of [{ authorization: undefined }, { authorization: grant({ recipient: "recipient-b" }) }, { now: Date.UTC(2026, 8, 30) }]) {
    try { await attempt(over).run; } catch (error) { seen.push(String(error), JSON.stringify(error), (error as Error).stack ?? ""); }
  }
  assert.equal(seen.length, 9);
  assert.equal(seen.join("\n").includes(KEY), false);
});

// --- structure --------------------------------------------------------------------------------------------------------------

test("external.ts builds its model only from the configuration and a driver, after the plan, with no tool override", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "services/assistant/external.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal((code.match(/askAssistant\(/g) ?? []).length, 1);
  assert.doesNotMatch(code, /\btools:\s/, "the real tool set is used: no tools override");
  assert.doesNotMatch(code, /options\.(model|recipient|endpoint|modelId|approvedRecipients)\b/, "nothing that addresses the request comes from the caller");
  assert.match(code, /model:\s*createProviderAdapter\(config,\s*options\.driver\)/);
  assert.ok(code.indexOf("planModelAccess(") < code.indexOf("createProviderAdapter("), "the provider is built only after the plan");
  assert.match(code, /allowedTools:\s*plan\.allowedTools/);
  assert.match(code, /visibleClasses:\s*plan\.visibleClasses/);
  assert.match(code, /approvedRecipients:\s*\[\.\.\.plan\.approvedRecipients\]/);
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["../errors", "./ask", "./config", "./model", "./orchestrator", "./provider", "@/lib/assistant/access-plan", "@/lib/assistant/answer", "@/lib/assistant/profiles"].sort());
  assert.match(code, /^import type \{ ToolActivity \} from "\.\/orchestrator";$/m, "the orchestrator import is type-only");
  assert.doesNotMatch(code, /import\(|require\(|fetch\(|process\.env/);
});

test("synthetic mode is unchanged: its profile, its tools, and its entry point know nothing of the external one", () => {
  assert.deepEqual([...SYNTHETIC_PROFILE.tools], [...SYNTHETIC_TOOL_NAMES]);
  const synthetic = fs.readFileSync(path.join(FRONTEND, "services/assistant/synthetic.ts"), "utf8");
  assert.match(synthetic, /allowedTools:\s*SYNTHETIC_TOOL_NAMES/);
  assert.doesNotMatch(synthetic, /external|visibleClasses|planModelAccess|createProviderAdapter/);
});
