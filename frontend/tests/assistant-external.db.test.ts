// The external entry point with the REAL, database-backed tools behind it (services/assistant/external.ts). The model is a scripted
// fake: no provider, no network. It needs the local PostgreSQL (compare_tax_regimes reads the seeded assessment year; query_transactions
// reads the caller's own, here empty, ledger).
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXTERNAL_PROFILE, askExternal } from "../services/assistant/external";
import { readAssistantConfig } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import type { ModelAdapter, ModelRequest } from "../services/assistant/model";
import { parseToolArguments } from "../services/assistant/model";
import { ASSISTANT_TOOL_DEFINITIONS, OrchestratorError } from "../services/assistant/orchestrator";
import { ModelProviderError } from "../services/assistant/model";
import type { AccessAuditRecord } from "../lib/assistant/access-plan";
import { ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import { AUTHORIZATION_VERSION } from "../lib/assistant/authorization";
import { EGRESS_FIELD_CLASSES, FULL_PROFILE } from "../lib/assistant/profiles";
import { createAssistantTools } from "../services/assistant/tools";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";

const USER = "0b6f5a2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const KEY = "test-key-NOT-A-REAL-SECRET-0003";
/** An external configuration can only be built by hand: the reader never produces one. */
const external = (over: Record<string, string> = {}): AssistantConfig => ({
  ...(readAssistantConfig({
    ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "synthetic", MODEL_ENDPOINT: "https://provider.invalid/v1", MODEL_API_KEY: KEY,
    MODEL_ID: "fixture-v1", MODEL_APPROVED_RECIPIENTS: `${RECIPIENT},recipient-b`, MODEL_TIMEOUT_MS: "5000", MODEL_MAX_OUTPUT_CHARS: "20000", ...over,
  }) as Extract<AssistantConfig, { enabled: true }>),
  env: "external",
});
const CONFIG = external();
const INPUT = { userId: USER, userMessages: ["What does SmartCA know about my finances?"] };
const TAX = { assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: parseToolArguments(JSON.stringify(args)) });
const authorization = (dataClasses: readonly string[] = EGRESS_FIELD_CLASSES) => ({
  version: AUTHORIZATION_VERSION, authorizationId: "auth_db_0001", userId: USER, profileId: "full", recipient: RECIPIENT, consent: "granted",
  dataClasses, issuedAt: "2026-09-29T10:00:00Z", expiresAt: "2026-09-29T14:00:00Z",
});

function scripted(...responses: unknown[]): ModelAdapter & { requests: ModelRequest[] } {
  return scriptedAs(RECIPIENT, ...responses);
}
function scriptedAs(recipient: string, ...responses: unknown[]): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(structuredClone(request));
      return { ...((responses.shift() ?? { kind: "text", text: "Here is what I can help with." }) as object), meta: { recipient, model: "m" } } as never;
    },
  };
}
const run = (model: ModelAdapter, over: Record<string, unknown> = {}, config = CONFIG) =>
  askExternal(config, INPUT, { model, authorization: authorization(), recipient: RECIPIENT, now: NOW, ...over });

test("an authorized external run calls ALL SIX real tools, and the model is sent each result exactly as the real tool returns it", async () => {
  // Every real tool goes through the external path here, so a field added to any of them that the egress inventory does not classify
  // stops this run (tool_result_unclassified) instead of crossing the boundary unnoticed.
  const LAW = { question: "What is the Section 87A rebate limit?", assessmentYear: "2026-27" };
  const SIM = { regime: "old", base: { ...TAX, deductions: {} }, scenario: TAX };
  const model = scripted(
    { kind: "tool_calls", calls: [call("c1", "calculate_tax", { regime: "old", ...TAX }), call("c2", "compare_tax_regimes", TAX), call("c3", "query_transactions", { includeDescription: true })] },
    { kind: "tool_calls", calls: [call("c4", "get_financial_summary", {}), call("c5", "simulate_tax", SIM), call("c6", "search_tax_law", LAW)] },
    { kind: "text", text: "The engine computed the figures above." },
  );
  const audits: AccessAuditRecord[] = [];
  const answer = await askExternal(CONFIG, { userId: USER, userMessages: ["What is my tax?"] }, { model, authorization: authorization(), recipient: RECIPIENT, now: NOW, onAccessPlanned: (a) => audits.push(a) });
  assert.equal(answer.state, "answered");
  const real = createAssistantTools();
  const expected = [
    await real.calculate_tax(USER, { regime: "old", ...TAX }),
    await real.compare_tax_regimes(USER, TAX),
    await real.query_transactions(USER, { includeDescription: true }),
    await real.get_financial_summary(USER, {}),
    await real.simulate_tax(USER, SIM),
    await real.search_tax_law(USER, LAW),
  ];
  const sent = model.requests[2].messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.deepEqual(sent, expected.map((r) => JSON.stringify(r)), "all classes authorized: the filter shows each real result whole");
  assert.equal(answer.facts.taxValues.length, 3);
  assert.equal(audits[0].inventoryVersion, fingerprintInventory(), "the audit record names the field list the run was disclosed against");
});

test("a tool outside the authorized plan cannot run, even though the real tool set contains it", async () => {
  const model = scripted({ kind: "tool_calls", calls: [call("c1", "search_tax_law", { question: "What is the 87A rebate?", assessmentYear: "2026-27" })] });
  await assert.rejects(
    askExternal(CONFIG, { userId: USER, userMessages: ["87A?"] }, { model, authorization: authorization(["user_free_text", "user_financial_data", "system_value"]), recipient: RECIPIENT, now: NOW }),
    (e: unknown) => e instanceof OrchestratorError && e.code === "unknown_tool" && e.toolActivity.length === 0,
  );
  assert.equal(model.requests.length, 1, "the refused call was never answered");
});

test("an authorized run offers the server's full profile, plans before the model runs, and returns a validated Answer", async () => {
  const model = scripted();
  const audits: AccessAuditRecord[] = [];
  const answer = await run(model, { onAccessPlanned: (a: AccessAuditRecord) => { assert.equal(model.requests.length, 0, "planned before the model"); audits.push(a); } });
  assert.equal(answer.state, "answered");
  assert.deepEqual(model.requests[0].tools, ASSISTANT_TOOL_DEFINITIONS, "all six tools, exactly as declared");
  assert.deepEqual([...EXTERNAL_PROFILE.tools], [...FULL_PROFILE.tools]);
  assert.deepEqual(audits.map((a) => [a.profileId, a.recipient, a.userId, a.allowedTools.length]), [["full", RECIPIENT, USER, 6]]);
});

test("a narrower authorization narrows the tools the model is offered", async () => {
  const model = scripted();
  await run(model, { authorization: authorization(["user_free_text", "user_financial_data", "system_value"]) });
  assert.deepEqual(model.requests[0].tools?.map((t) => t.name), ASSISTANT_TOOL_NAMES.filter((t) => t !== "search_tax_law"));
});

test("options cannot choose the profile: a profile, tool list or tool set passed alongside is ignored", async () => {
  const model = scripted();
  await run(model, { profile: { id: "god", tools: ["delete_ledger"], classes: {} }, allowedTools: ["delete_ledger"], tools: {}, visibleClasses: {} });
  assert.deepEqual(model.requests[0].tools?.map((t) => t.name), [...ASSISTANT_TOOL_NAMES], "still exactly the server's profile");
});

test("only the authorized recipient may answer, even when the configuration approves another", async () => {
  await assert.rejects(run(scriptedAs("recipient-b")), (e: unknown) => e instanceof ModelProviderError && e.code === "recipient_not_approved");
});

test("the configuration's timeout applies: a model that hangs is stopped, typed", async () => {
  const hanging: ModelAdapter = { complete: () => new Promise(() => undefined) };
  await assert.rejects(run(hanging, {}, external({ MODEL_TIMEOUT_MS: "40" })), (e: unknown) => e instanceof ModelProviderError && e.code === "timeout");
});

test("the key appears in no error or audit record", async () => {
  const seen: string[] = [];
  for (const over of [{ authorization: undefined }, { recipient: "recipient-b" }, { now: Date.UTC(2026, 8, 30) }]) {
    try { await run(scripted(), over); } catch (error) { seen.push(String(error), JSON.stringify(error), (error as Error).stack ?? ""); }
  }
  try { await run(scriptedAs("recipient-b")); } catch (error) { seen.push(String(error), JSON.stringify(error), (error as Error).stack ?? ""); }
  await run(scripted(), { onAccessPlanned: (a: AccessAuditRecord) => seen.push(JSON.stringify(a)) });
  assert.ok(seen.length > 0);
  assert.equal(seen.join(" | ").includes(KEY), false);
});
