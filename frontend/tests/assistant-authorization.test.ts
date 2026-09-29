// The assistant session authorization (lib/assistant/authorization.ts). PURE: no database, no DATABASE_URL, no network. Nothing uses
// it yet; these pin that effective access is the INTERSECTION of the profile and the person's explicit authorization, that nothing is
// defaulted or widened, and that each kind of failure is told apart.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTHORIZATION_VERSION, AssistantAuthorizationError, RECIPIENT_ID_PATTERN, resolveAuthorization } from "../lib/assistant/authorization";
import type { AssistantAuthorization, AssistantAuthorizationErrorCode } from "../lib/assistant/authorization";
import { AssistantProfileError, EGRESS_FIELD_CLASSES, FULL_PROFILE, SYNTHETIC_PROFILE, classesReturnedBy } from "../lib/assistant/profiles";
import type { AssistantProfile } from "../lib/assistant/profiles";
import { ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import type { EgressFieldClass } from "../lib/assistant/tool-contract";
import { META_ID, isRecipientId } from "../services/assistant/model";

const FRONTEND = path.resolve(__dirname, "..");
const USER = "8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const CONTEXT = { userId: USER, recipient: RECIPIENT, now: NOW };
const ALL: EgressFieldClass[] = [...EGRESS_FIELD_CLASSES];

const grant = (over: Record<string, unknown> = {}): AssistantAuthorization =>
  ({
    version: AUTHORIZATION_VERSION,
    authorizationId: "auth_0001",
    userId: USER,
    profileId: "full",
    recipient: RECIPIENT,
    consent: "granted",
    dataClasses: ALL,
    issuedAt: "2026-09-29T10:00:00Z",
    expiresAt: "2026-09-29T14:00:00Z",
    ...over,
  }) as AssistantAuthorization;

const refuses = (code: AssistantAuthorizationErrorCode, authorization: unknown, context: unknown = CONTEXT, profile: unknown = FULL_PROFILE) =>
  assert.throws(
    () => resolveAuthorization(profile, authorization, context),
    (e: unknown) => e instanceof AssistantAuthorizationError && e.code === code,
    `expected ${code} for ${JSON.stringify(authorization)?.slice(0, 160)}`,
  );

// --- a full grant -------------------------------------------------------------------------------------------------------------

test("a full, explicit grant under FULL_PROFILE resolves to all six tools and all four classes, frozen", () => {
  const effective = resolveAuthorization(FULL_PROFILE, grant(), CONTEXT);
  assert.deepEqual(effective, {
    version: 1,
    authorizationId: "auth_0001",
    userId: USER,
    profileId: "full",
    recipient: RECIPIENT,
    dataClasses: ALL,
    allowedTools: [...ASSISTANT_TOOL_NAMES],
    issuedAt: "2026-09-29T10:00:00Z",
    expiresAt: "2026-09-29T14:00:00Z",
  });
  assert.ok(Object.isFrozen(effective) && Object.isFrozen(effective.dataClasses) && Object.isFrozen(effective.allowedTools));
  // The order the person listed classes in does not matter.
  assert.deepEqual(resolveAuthorization(FULL_PROFILE, grant({ dataClasses: [...ALL].reverse() }), CONTEXT).dataClasses, ALL);
});

// --- intersection, never union ------------------------------------------------------------------------------------------------

test("the tools come from the profile only: a grant under SYNTHETIC_PROFILE never reaches query_transactions", () => {
  const effective = resolveAuthorization(SYNTHETIC_PROFILE, grant({ profileId: "synthetic" }), CONTEXT);
  assert.deepEqual(effective.allowedTools, [...SYNTHETIC_PROFILE.tools]);
  assert.equal(effective.allowedTools.includes("query_transactions"), false);
  // There is no field through which an authorization could name a tool.
  refuses("authorization_invalid", { ...grant({ profileId: "synthetic" }), tools: ["query_transactions"] }, CONTEXT, SYNTHETIC_PROFILE);
  refuses("authorization_invalid", { ...grant(), allowedTools: [...ASSISTANT_TOOL_NAMES] });
});

test("a class the profile forbids cannot be authorized: it is a mismatch, not granted and not quietly dropped", () => {
  const noCorpus: AssistantProfile = { id: "ledger", tools: ["get_financial_summary", "query_transactions"], classes: { user_free_text: true, user_financial_data: true, tax_corpus_text: false, system_value: true } };
  refuses("data_class_mismatch", grant({ profileId: "ledger" }), CONTEXT, noCorpus);
  const ok = resolveAuthorization(noCorpus, grant({ profileId: "ledger", dataClasses: ["user_free_text", "user_financial_data", "system_value"] }), CONTEXT);
  assert.deepEqual(ok.dataClasses, ["user_free_text", "user_financial_data", "system_value"]);
  assert.deepEqual(ok.allowedTools, ["query_transactions", "get_financial_summary"]);
});

test("a narrower grant narrows the tools: a tool is usable only when every class it returns is authorized", () => {
  const noFinancial = resolveAuthorization(FULL_PROFILE, grant({ dataClasses: ["user_free_text", "tax_corpus_text", "system_value"] }), CONTEXT);
  assert.deepEqual(noFinancial.allowedTools, ["search_tax_law"]);
  assert.deepEqual(noFinancial.dataClasses, ["user_free_text", "tax_corpus_text", "system_value"]);
  const noCorpus = resolveAuthorization(FULL_PROFILE, grant({ dataClasses: ["user_free_text", "user_financial_data", "system_value"] }), CONTEXT);
  assert.deepEqual(noCorpus.allowedTools, ["query_transactions", "get_financial_summary", "calculate_tax", "compare_tax_regimes", "simulate_tax"]);
  for (const tool of noCorpus.allowedTools) assert.ok(classesReturnedBy(tool).every((c) => noCorpus.dataClasses.includes(c)), tool);
});

test("without user_free_text nothing can be sent, and without system_value no tool can run: both are refused, not emptied", () => {
  // Every tool can return user free text (a refusal repeats an argument name), and the conversation itself is user free text.
  for (const tool of ASSISTANT_TOOL_NAMES) assert.ok(classesReturnedBy(tool).includes("user_free_text") && classesReturnedBy(tool).includes("system_value"), tool);
  refuses("data_class_mismatch", grant({ dataClasses: ["user_financial_data", "tax_corpus_text", "system_value"] }));
  refuses("data_class_mismatch", grant({ dataClasses: ["user_free_text", "user_financial_data", "tax_corpus_text"] }));
  refuses("data_class_mismatch", grant({ dataClasses: ["user_free_text", "system_value"] }));
});

test("an effective grant is never wider than the profile or the authorization", () => {
  const subsets = (1 << ALL.length) - 1;
  for (let mask = 1; mask <= subsets; mask++) {
    const classes = ALL.filter((_, i) => mask & (1 << i));
    for (const profile of [FULL_PROFILE, SYNTHETIC_PROFILE]) {
      try {
        const e = resolveAuthorization(profile, grant({ profileId: profile.id, dataClasses: classes }), CONTEXT);
        assert.ok(e.allowedTools.every((t) => profile.tools.includes(t)), "tools within the profile");
        assert.ok(e.dataClasses.every((c) => classes.includes(c) && profile.classes[c]), "classes within both");
        assert.ok(e.allowedTools.every((t) => classesReturnedBy(t).every((c) => e.dataClasses.includes(c))), "no tool returns an unauthorized class");
      } catch (error) {
        assert.ok(error instanceof AssistantAuthorizationError && error.code === "data_class_mismatch", String(error));
      }
    }
  }
});

// --- consent: explicit, never defaulted ---------------------------------------------------------------------------------------

test("no authorization, or consent absent or not granted, is consent_not_given", () => {
  refuses("consent_not_given", undefined);
  refuses("consent_not_given", null);
  const { consent: _omitted, ...withoutConsent } = grant();
  void _omitted;
  refuses("consent_not_given", withoutConsent);
  refuses("consent_not_given", grant({ consent: "not_granted" }));
});

test("a broad intention or preference is not consent: only the explicit value \"granted\" in a complete authorization counts", () => {
  // Something that is not an authorization at all, or a consent value that is not exactly "granted", is malformed.
  for (const intent of [true, "yes", "share everything", { consent: true }, { consent: "yes" }]) refuses("authorization_invalid", intent);
  // A stated intention or preference with no consent value is consent not given.
  for (const intent of [{ intent: "use all my data" }, { preference: "maximum access" }, { ...grant(), consent: undefined, preference: "share everything" }]) {
    refuses("consent_not_given", intent);
  }
  for (const consent of [true, 1, "Granted", "GRANTED", "granted ", "accepted", "withdrawn", null]) refuses("authorization_invalid", grant({ consent }));
  // "granted" alone, with nothing else stated, authorizes nothing.
  refuses("authorization_invalid", { consent: "granted" });
  refuses("authorization_invalid", { consent: "granted", dataClasses: ALL });
});

test("nothing is defaulted: every field is required, and an unknown field or version is refused", () => {
  for (const field of ["version", "authorizationId", "userId", "profileId", "recipient", "dataClasses", "issuedAt", "expiresAt"]) {
    const partial: Record<string, unknown> = { ...grant() };
    delete partial[field];
    refuses("authorization_invalid", partial);
  }
  refuses("authorization_invalid", { ...grant(), extra: 1 });
  for (const version of [0, 2, "1", null]) refuses("authorization_invalid", grant({ version }));
});

test("malformed values are refused", () => {
  const bad: Record<string, unknown[]> = {
    authorizationId: ["", " auth", "a".repeat(129), 7, "auth id"],
    userId: ["", "   ", 7, "u".repeat(257)],
    profileId: ["", " ", 7],
    recipient: ["", "-lead", "has space", "r".repeat(65), 7],
    dataClasses: [[], "user_free_text", ["user_free_text", "user_free_text"], ["user_free_text", "everything"], [7]],
    issuedAt: ["2026-09-29", "2026-09-29T10:00:00", "2026-09-29T10:00:00+05:30", "2026-02-30T10:00:00Z", "not a date", 1_790_000_000_000],
    expiresAt: ["2026-09-29T25:00:00Z", "2026-13-01T00:00:00Z"],
  };
  for (const [field, values] of Object.entries(bad)) for (const value of values) refuses("authorization_invalid", grant({ [field]: value }));
  // A window that ends when it starts, or before, is malformed.
  refuses("authorization_invalid", grant({ expiresAt: "2026-09-29T10:00:00Z" }));
  refuses("authorization_invalid", grant({ expiresAt: "2026-09-29T09:00:00Z" }));
  // A broken context authorizes nothing either.
  for (const context of [null, "ctx", { ...CONTEXT, now: "now" }, { ...CONTEXT, now: -1 }, { ...CONTEXT, now: 1.5 }, { ...CONTEXT, userId: "" }, { ...CONTEXT, recipient: "has space" }]) {
    refuses("authorization_invalid", grant(), context);
  }
});

// --- validity, binding, profile -----------------------------------------------------------------------------------------------

test("outside the validity window is authorization_expired, distinct from not given and from invalid", () => {
  refuses("authorization_expired", grant(), { ...CONTEXT, now: Date.UTC(2026, 8, 29, 14, 0, 0) });
  refuses("authorization_expired", grant(), { ...CONTEXT, now: Date.UTC(2026, 8, 30) });
  refuses("authorization_expired", grant(), { ...CONTEXT, now: Date.UTC(2026, 8, 29, 9, 59, 59) });
  assert.equal(resolveAuthorization(FULL_PROFILE, grant(), { ...CONTEXT, now: Date.UTC(2026, 8, 29, 10, 0, 0) }).authorizationId, "auth_0001");
});

test("a grant from another user, or for another recipient, is binding_mismatch", () => {
  refuses("binding_mismatch", grant({ userId: "someone-else" }));
  refuses("binding_mismatch", grant(), { ...CONTEXT, userId: "someone-else" });
  refuses("binding_mismatch", grant({ recipient: "recipient-b" }));
  refuses("binding_mismatch", grant(), { ...CONTEXT, recipient: "recipient-b" });
});

test("a grant for another profile is profile_mismatch: consent to one mode does not carry to another", () => {
  refuses("profile_mismatch", grant({ profileId: "synthetic" }));
  refuses("profile_mismatch", grant({ profileId: "full" }), CONTEXT, SYNTHETIC_PROFILE);
});

test("an unusable profile is refused by resolveProfile, before the authorization is read", () => {
  assert.throws(() => resolveAuthorization({ id: "x", tools: [], classes: FULL_PROFILE.classes }, grant(), CONTEXT), AssistantProfileError);
  assert.throws(() => resolveAuthorization(null, grant(), CONTEXT), AssistantProfileError);
});

test("an error names a code and a fixed message, never the user, the recipient or any other value", () => {
  const secretUser = "user-SECRET-4242";
  const cases: Array<() => unknown> = [
    () => resolveAuthorization(FULL_PROFILE, grant({ userId: secretUser }), CONTEXT),
    () => resolveAuthorization(FULL_PROFILE, grant({ recipient: "recipient-SECRET" }), CONTEXT),
    () => resolveAuthorization(FULL_PROFILE, grant({ authorizationId: "bad id SECRET" }), CONTEXT),
  ];
  for (const run of cases) {
    try {
      run();
      assert.fail("expected a refusal");
    } catch (error) {
      assert.ok(error instanceof AssistantAuthorizationError);
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error)} ${String(error.stack)}`, /SECRET/);
    }
  }
});

// --- purity and agreement ------------------------------------------------------------------------------------------------------

test("the recipient pattern is exactly the model guard's canonical META_ID: same source, same flags", () => {
  assert.equal(RECIPIENT_ID_PATTERN.source, META_ID.source);
  assert.equal(RECIPIENT_ID_PATTERN.flags, META_ID.flags);
});

test("the recipient shape agrees with the model guard's isRecipientId", () => {
  const samples = ["recipient-a", "r", "a.b:c_d-e", "A1", "-a", ".a", "has space", "r".repeat(64), "r".repeat(65), "é", ""];
  for (const recipient of samples) {
    let accepted = true;
    try {
      resolveAuthorization(FULL_PROFILE, grant({ recipient }), { ...CONTEXT, recipient });
    } catch (error) {
      assert.ok(error instanceof AssistantAuthorizationError && error.code === "authorization_invalid", String(error));
      accepted = false;
    }
    assert.equal(accepted, isRecipientId(recipient), recipient);
  }
});

test("authorization.ts imports only pure lib/assistant modules and reads no clock, environment or network", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "lib/assistant/authorization.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["./profiles", "./tool-contract"]);
  assert.doesNotMatch(code, /require\(|import\(|process\.env|fetch\(|Date\.now\(|new Date\(\)/);
});
