// The external entry point (services/assistant/external.ts). PURE: no database, no DATABASE_URL, no network, no provider. Every case
// here is refused BEFORE a run starts, because a run that reaches the model loads the real, database-backed tool set (runAssistant does
// that at the start of any run that is given no tools, and askExternal gives none). Runs are in assistant-external.db.test.ts.
//
// What is pinned: the profile is the server's (EXTERNAL_PROFILE) and cannot be chosen or widened by the request, the options or the
// model; nothing runs without the person's explicit authorization; only the authorized, approved recipient may answer, under the
// configuration's limits; the configuration reader still cannot produce an external configuration; synthetic mode is untouched.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { askExternal } from "../services/assistant/external";
import type { ExternalRunOptions } from "../services/assistant/external";
import { AssistantConfigError, readAssistantConfig } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import type { ModelAdapter, ModelRequest } from "../services/assistant/model";
import { OrchestratorError } from "../services/assistant/orchestrator";
import { AUTHORIZATION_VERSION, AssistantAuthorizationError } from "../lib/assistant/authorization";
import type { AssistantAuthorization, AssistantAuthorizationErrorCode } from "../lib/assistant/authorization";
import { EGRESS_FIELD_CLASSES, SYNTHETIC_PROFILE } from "../lib/assistant/profiles";
import { ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import { SYNTHETIC_TOOL_NAMES } from "../services/assistant/synthetic-tools";
import { NotAuthenticatedError } from "../services/errors";

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
  MODEL_APPROVED_RECIPIENTS: `${RECIPIENT},recipient-b`,
  MODEL_TIMEOUT_MS: "200",
  MODEL_MAX_OUTPUT_CHARS: "2000",
};
/** An external configuration can only be built by hand: the reader never produces one. */
const external = (over: Record<string, string> = {}): AssistantConfig => ({ ...(readAssistantConfig({ ...ENV, ...over }) as Extract<AssistantConfig, { enabled: true }>), env: "external" });
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
    ...over,
  }) as AssistantAuthorization;

/** A recording model that answers with text, as `recipient`. */
function textModel(recipient = RECIPIENT, reply = "Here is what I can help with."): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { requests, complete: async (request) => { requests.push(structuredClone(request)); return { kind: "text", text: reply, meta: { recipient, model: "m" } }; } };
}
const options = (model: ModelAdapter, over: Partial<ExternalRunOptions> = {}): ExternalRunOptions => ({ model, authorization: grant(), recipient: RECIPIENT, now: NOW, ...over });

async function refusedBeforeModel(code: AssistantAuthorizationErrorCode, over: Partial<ExternalRunOptions>, config = external()) {
  const model = textModel();
  await assert.rejects(askExternal(config, INPUT, options(model, over)), (e: unknown) => e instanceof AssistantAuthorizationError && e.code === code, code);
  assert.equal(model.requests.length, 0, `${code}: the model was never called`);
}



// --- consent ------------------------------------------------------------------------------------------------------------------

test("without explicit consent nothing runs: absent, not granted, a bare intention, or malformed", async () => {
  await refusedBeforeModel("consent_not_given", { authorization: undefined });
  await refusedBeforeModel("consent_not_given", { authorization: null });
  await refusedBeforeModel("consent_not_given", { authorization: grant({ consent: "not_granted" }) });
  await refusedBeforeModel("consent_not_given", { authorization: { intent: "use everything" } });
  await refusedBeforeModel("authorization_invalid", { authorization: true });
  await refusedBeforeModel("authorization_invalid", { authorization: { consent: "granted" } });
  await refusedBeforeModel("authorization_expired", { now: Date.UTC(2026, 8, 30) });
});

test("consent for another user or another recipient is not this run's consent", async () => {
  await refusedBeforeModel("binding_mismatch", { authorization: grant({ userId: "someone-else" }) });
  await refusedBeforeModel("binding_mismatch", { recipient: "recipient-b" });
});

// --- the profile is the server's --------------------------------------------------------------------------------------------

test("a request cannot choose or widen the profile: extra input fields are refused before the model runs", async () => {
  for (const extra of [{ profile: "full" }, { profile: SYNTHETIC_PROFILE }, { allowedTools: [...ASSISTANT_TOOL_NAMES] }, { visibleClasses: { user_free_text: true } }]) {
    const model = textModel();
    await assert.rejects(
      askExternal(external(), { ...INPUT, ...extra } as never, options(model)),
      (e: unknown) => e instanceof OrchestratorError && e.code === "invalid_input",
      JSON.stringify(extra),
    );
    assert.equal(model.requests.length, 0);
  }
});


test("an authorization given for another profile is refused: consent to one mode does not carry to another", async () => {
  await refusedBeforeModel("profile_mismatch", { authorization: grant({ profileId: "synthetic" }) });
  await refusedBeforeModel("profile_mismatch", { authorization: grant({ profileId: "god" }) });
});

// --- recipients and limits ----------------------------------------------------------------------------------------------------

test("an authorized recipient the configuration does not approve is refused before the model runs", async () => {
  await refusedBeforeModel("recipient_not_approved", {}, external({ MODEL_APPROVED_RECIPIENTS: "recipient-b" }));
  await refusedBeforeModel("recipient_not_approved", {}, external({ MODEL_APPROVED_RECIPIENTS: "recipient-z" }));
});


// --- configuration still fails closed --------------------------------------------------------------------------------------

test("the configuration reader still cannot produce an external configuration, and askExternal refuses any other", async () => {
  assert.throws(() => readAssistantConfig({ ...ENV, ASSISTANT_ENV: "external" }), (e: unknown) => e instanceof AssistantConfigError && e.code === "real_data_mode_not_permitted");
  const model = textModel();
  await assert.rejects(askExternal(readAssistantConfig(ENV), INPUT, options(model)), (e: unknown) => e instanceof AssistantConfigError && e.code === "invalid_configuration");
  await assert.rejects(askExternal({ enabled: false }, INPUT, options(model)), (e: unknown) => e instanceof AssistantConfigError && e.code === "assistant_disabled");
  await assert.rejects(askExternal(external(), { userId: "", userMessages: ["hi"] }, options(model)), NotAuthenticatedError);
  assert.equal(model.requests.length, 0);
});


// --- structure --------------------------------------------------------------------------------------------------------------

test("external.ts composes askAssistant once, with no tool override, no provider package and no database", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "services/assistant/external.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal((code.match(/askAssistant\(/g) ?? []).length, 1);
  assert.doesNotMatch(code, /\btools:\s/, "the real tool set is used: no tools override");
  assert.match(code, /allowedTools:\s*plan\.allowedTools/);
  assert.match(code, /visibleClasses:\s*plan\.visibleClasses/);
  assert.match(code, /approvedRecipients:\s*\[\.\.\.plan\.approvedRecipients\]/);
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["../errors", "./ask", "./config", "./model", "@/lib/assistant/access-plan", "@/lib/assistant/answer", "@/lib/assistant/profiles"].sort());
  assert.doesNotMatch(code, /import\(|require\(|fetch\(|process\.env/);
});

test("synthetic mode is unchanged: its profile, its tools, and its entry point know nothing of the external one", () => {
  assert.deepEqual([...SYNTHETIC_PROFILE.tools], [...SYNTHETIC_TOOL_NAMES]);
  const synthetic = fs.readFileSync(path.join(FRONTEND, "services/assistant/synthetic.ts"), "utf8");
  assert.match(synthetic, /allowedTools:\s*SYNTHETIC_TOOL_NAMES/);
  assert.doesNotMatch(synthetic, /external|visibleClasses|planModelAccess/);
});
