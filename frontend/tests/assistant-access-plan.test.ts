// The model access plan (lib/assistant/access-plan.ts): profile ∩ authorization ∩ configured recipients, as one object. PURE: no
// database, no DATABASE_URL, no network. Nothing uses it yet; these pin that a plan is never wider than any of its three inputs, that
// it always carries tools, visible classes and recipients together, and that it drives the orchestrator's existing enforcement.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { planModelAccess } from "../lib/assistant/access-plan";
import { AUTHORIZATION_VERSION, AssistantAuthorizationError } from "../lib/assistant/authorization";
import type { AssistantAuthorization, AssistantAuthorizationErrorCode } from "../lib/assistant/authorization";
import { filterToolResult } from "../lib/assistant/egress-filter";
import { describeEgress, fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { EGRESS_FIELD_CLASSES, FULL_PROFILE, SYNTHETIC_PROFILE, classesReturnedBy } from "../lib/assistant/profiles";
import { ASSISTANT_TOOL_NAMES, LEDGER_DATA_NOTICE } from "../lib/assistant/tool-contract";
import type { EgressFieldClass } from "../lib/assistant/tool-contract";
import { ModelProviderError } from "../services/assistant/model";
import type { ModelAdapter, ModelRequest } from "../services/assistant/model";
import { runAssistant } from "../services/assistant/orchestrator";
import { call, stubTools } from "./helpers-orchestrator";
import { presentForModel } from "../lib/assistant/model-view";

const FRONTEND = path.resolve(__dirname, "..");
const USER = "8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const CONTEXT = { userId: USER, recipient: RECIPIENT, now: NOW };
const CONFIGURED = ["recipient-z", RECIPIENT, "recipient-b"];
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
    inventoryVersion: fingerprintInventory(),
    ...over,
  }) as AssistantAuthorization;

const refuses = (code: AssistantAuthorizationErrorCode, run: () => unknown) =>
  assert.throws(run, (e: unknown) => e instanceof AssistantAuthorizationError && e.code === code, `expected ${code}`);

test("a full grant plans all six tools, all four classes, and only the authorized recipient", () => {
  const plan = planModelAccess(FULL_PROFILE, grant(), CONTEXT, CONFIGURED);
  assert.deepEqual(plan.allowedTools, [...ASSISTANT_TOOL_NAMES]);
  assert.deepEqual({ ...plan.visibleClasses }, { user_free_text: true, user_financial_data: true, tax_corpus_text: true, system_value: true });
  assert.deepEqual(plan.approvedRecipients, [RECIPIENT], "narrowed from the configured list to the one the person authorized");
  assert.deepEqual({ ...plan.audit }, {
    authorizationId: "auth_0001",
    userId: USER,
    profileId: "full",
    recipient: RECIPIENT,
    allowedTools: [...ASSISTANT_TOOL_NAMES],
    visibleClasses: ALL,
    issuedAt: "2026-09-29T10:00:00Z",
    expiresAt: "2026-09-29T14:00:00Z",
    inventoryVersion: fingerprintInventory(),
    plannedAt: NOW,
  });
  assert.deepEqual(plan.disclosure, describeEgress(plan.allowedTools, plan.visibleClasses), "the plan carries its own disclosure");
  for (const part of [plan, plan.visibleClasses, plan.approvedRecipients, plan.allowedTools, plan.audit]) assert.ok(Object.isFrozen(part));
});

test("a narrower grant narrows the plan: classes not authorized are false, and tools that would return them are not offered", () => {
  const plan = planModelAccess(FULL_PROFILE, grant({ dataClasses: ["user_free_text", "user_financial_data", "system_value"] }), CONTEXT, CONFIGURED);
  assert.deepEqual({ ...plan.visibleClasses }, { user_free_text: true, user_financial_data: true, tax_corpus_text: false, system_value: true });
  assert.equal(plan.allowedTools.includes("search_tax_law"), false);
  // Every planned tool's classes are all visible, so the filter is a second line of defence, not the first.
  for (const tool of plan.allowedTools) assert.ok(classesReturnedBy(tool).every((c) => plan.visibleClasses[c]), tool);
});

test("a plan is never wider than the profile, the authorization or the configuration", () => {
  const plan = planModelAccess(SYNTHETIC_PROFILE, grant({ profileId: "synthetic" }), CONTEXT, CONFIGURED);
  assert.equal(plan.allowedTools.includes("query_transactions"), false, "not in the profile, so not in the plan");
  for (let mask = 1; mask < 1 << ALL.length; mask++) {
    const classes = ALL.filter((_, i) => mask & (1 << i));
    try {
      const p = planModelAccess(FULL_PROFILE, grant({ dataClasses: classes }), CONTEXT, CONFIGURED);
      assert.ok(ALL.every((c) => p.visibleClasses[c] === classes.includes(c)), "visible exactly as authorized");
      assert.ok(p.allowedTools.every((t) => FULL_PROFILE.tools.includes(t)));
      assert.deepEqual(p.approvedRecipients, [RECIPIENT]);
    } catch (error) {
      assert.ok(error instanceof AssistantAuthorizationError && error.code === "data_class_mismatch", String(error));
    }
  }
});

test("an authorized recipient the configuration does not approve is recipient_not_approved; an empty list approves nothing", () => {
  refuses("recipient_not_approved", () => planModelAccess(FULL_PROFILE, grant(), CONTEXT, ["recipient-b"]));
  refuses("recipient_not_approved", () => planModelAccess(FULL_PROFILE, grant(), CONTEXT, []));
  for (const bad of [undefined, "recipient-a", [RECIPIENT, 7]]) assert.throws(() => planModelAccess(FULL_PROFILE, grant(), CONTEXT, bad as never), RangeError);
});

test("every authorization failure still stops the plan: consent, validity, binding, profile and class", () => {
  refuses("consent_not_given", () => planModelAccess(FULL_PROFILE, undefined, CONTEXT, CONFIGURED));
  refuses("consent_not_given", () => planModelAccess(FULL_PROFILE, grant({ consent: "not_granted" }), CONTEXT, CONFIGURED));
  refuses("authorization_invalid", () => planModelAccess(FULL_PROFILE, { consent: true }, CONTEXT, CONFIGURED));
  refuses("authorization_expired", () => planModelAccess(FULL_PROFILE, grant(), { ...CONTEXT, now: Date.UTC(2026, 8, 30) }, CONFIGURED));
  refuses("binding_mismatch", () => planModelAccess(FULL_PROFILE, grant(), { ...CONTEXT, userId: "someone-else" }, CONFIGURED));
  refuses("profile_mismatch", () => planModelAccess(SYNTHETIC_PROFILE, grant(), CONTEXT, CONFIGURED));
  refuses("data_class_mismatch", () => planModelAccess(FULL_PROFILE, grant({ dataClasses: ["system_value", "user_financial_data"] }), CONTEXT, CONFIGURED));
});

test("a grant is usable only for the inventory in force: a matching fingerprint plans, any other is inventory_changed", () => {
  assert.equal(planModelAccess(FULL_PROFILE, grant(), CONTEXT, CONFIGURED).audit.inventoryVersion, fingerprintInventory());
  for (const inventoryVersion of ["inv1-00000000", fingerprintInventory().toUpperCase(), "inv2-cab11f51"]) {
    refuses("inventory_changed", () => planModelAccess(FULL_PROFILE, grant({ inventoryVersion }), CONTEXT, CONFIGURED));
  }
  // The inventory is compared only once everything else holds, so a stale grant that is also expired, foreign or unapproved says so.
  const stale = grant({ inventoryVersion: "inv1-00000000" });
  refuses("authorization_expired", () => planModelAccess(FULL_PROFILE, stale, { ...CONTEXT, now: Date.UTC(2026, 8, 30) }, CONFIGURED));
  refuses("binding_mismatch", () => planModelAccess(FULL_PROFILE, stale, { ...CONTEXT, userId: "someone-else" }, CONFIGURED));
  refuses("recipient_not_approved", () => planModelAccess(FULL_PROFILE, stale, CONTEXT, ["recipient-b"]));
});

test("the audit record carries ids, classes, tools and times, never a value from the person's data", () => {
  const plan = planModelAccess(FULL_PROFILE, grant(), CONTEXT, CONFIGURED);
  assert.deepEqual(Object.keys(plan.audit).sort(), ["allowedTools", "authorizationId", "expiresAt", "inventoryVersion", "issuedAt", "plannedAt", "profileId", "recipient", "userId", "visibleClasses"]);
});

// --- the plan drives the orchestrator's existing enforcement ------------------------------------------------------------------

test("a plan passed to the orchestrator limits the declared tools, filters what the model sees, and refuses another recipient", async () => {
  const plan = planModelAccess(FULL_PROFILE, grant({ dataClasses: ["user_free_text", "user_financial_data", "system_value"] }), CONTEXT, CONFIGURED);
  const ledger = {
    status: "ok",
    tool: "query_transactions",
    result: {
      filter: { from: null, to: null, category: null, type: null },
      descriptionsIncluded: false, matched: 1, returned: 1, truncated: false, fieldsTruncated: false,
      totals: { incomePaise: 0, expensePaise: 500 },
      transactions: [{ occurredOn: "2026-03-05", type: "expense", amountPaise: 500, category: "Food", source: null }],
      dataNotice: LEDGER_DATA_NOTICE,
    },
  };
  const script = (recipient: string) => {
    const requests: ModelRequest[] = [];
    const responses = [
      { kind: "tool_calls", calls: [call("c1", "query_transactions", {})], meta: { recipient, model: "m" } },
      { kind: "text", text: "Done.", meta: { recipient, model: "m" } },
    ];
    const model: ModelAdapter & { requests: ModelRequest[] } = { requests, complete: async (r) => { requests.push(structuredClone(r)); return responses.shift() as never; } };
    return model;
  };
  const options = { allowedTools: plan.allowedTools, visibleClasses: plan.visibleClasses, modelPolicy: { approvedRecipients: [...plan.approvedRecipients] } };

  const model = script(RECIPIENT);
  await runAssistant({ userId: USER, messages: [{ role: "user", content: "How much on food?" }] }, { model, tools: stubTools({ query_transactions: ledger as never }).tools, ...options });
  assert.deepEqual(model.requests[0].tools?.map((t) => t.name), [...plan.allowedTools]);
  const sent = model.requests[1].messages.find((m) => m.role === "tool");
  assert.equal(sent?.content, JSON.stringify(presentForModel(filterToolResult("query_transactions", ledger, plan.visibleClasses))));

  const other = script("recipient-b");
  await assert.rejects(
    runAssistant({ userId: USER, messages: [{ role: "user", content: "How much on food?" }] }, { model: other, tools: stubTools().tools, ...options }),
    (e: unknown) => e instanceof ModelProviderError && e.code === "recipient_not_approved",
  );
});

test("access-plan.ts imports only pure lib/assistant modules and reads no clock, environment or network", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "lib/assistant/access-plan.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["./authorization", "./egress-disclosure", "./egress-filter", "./profiles", "./tool-contract"]);
  assert.doesNotMatch(code, /require\(|import\(|process\.env|fetch\(|Date\.now\(|new Date\(/);
});
