// Phase 6D, the part that runs REAL tool wrappers behind the orchestrator. This is a DATABASE-BACKED file (note the .db in its
// name): importing the real tools imports the database client, so it needs DATABASE_URL (loaded from .env.local below). None of
// these tests writes anything: calculate_tax is the pure engine, and search_tax_law is given a stubbed retrieval function.
//
// The orchestrator's own behaviour, with stub tools and no database, is in assistant-orchestrator.test.ts.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ORCHESTRATOR_SYSTEM_PROMPT, runAssistant } from "../services/assistant/orchestrator";
import type { ModelMessage } from "../services/assistant/model";
import { createAssistantTools } from "../services/assistant/tools";
import type { TaxRetrievalResult } from "../services/tax-retrieval";
import { USER, ask, call, evidence, scriptedModel, taxBody, text, toolCalls } from "./helpers-orchestrator";

test("a refusal from calculate_tax is preserved: the engine's own refusal reaches the model unchanged, and nothing is recomputed", async () => {
  const tools = createAssistantTools();
  const args = { regime: "new", ...taxBody };
  const direct = await tools.calculate_tax(USER, args);
  assert.equal(direct.status, "refused");

  const model = scriptedModel(toolCalls(call("c", "calculate_tax", args)), text("I can't compute that: the new regime does not allow those deductions."));
  const result = await runAssistant({ userId: USER, messages: ask("Tax under the new regime with 80C?") }, { model, tools });

  const toolMessage = model.requests[1].messages.find((m): m is Extract<ModelMessage, { role: "tool" }> => m.role === "tool")!;
  assert.equal(toolMessage.content, JSON.stringify(direct), "the refusal, verbatim");
  assert.deepEqual(result.toolCalls[0], { round: 1, callId: "c", tool: "calculate_tax", outcome: "refused", reason: "unsupported_tax_rule", evidenceIds: [] });
  assert.equal(model.requests.length, 2, "one refusal, one answer: no retry with altered input");
  assert.equal(result.toolCalls.length, 1);
});

test("a typed refusal from search_tax_law is preserved, with its detail", async () => {
  const yearMismatch: TaxRetrievalResult = {
    status: "insufficient_evidence", reason: "no_corpus_for_assessment_year", assessmentYear: "2026-27", corpusVersion: "v1", sectionRefs: ["87A"],
    yearMismatch: { requested: "2026-27", stated: ["2024-25"] },
  };
  const tools = createAssistantTools({ retrieve: async () => yearMismatch });
  const model = scriptedModel(toolCalls(call("c", "search_tax_law", { question: "87A rebate in AY 2024-25", assessmentYear: "2026-27" })), text("The corpus does not cover AY 2024-25."));
  const result = await runAssistant({ userId: USER, messages: ask() }, { model, tools });

  assert.deepEqual(result.toolCalls[0], { round: 1, callId: "c", tool: "search_tax_law", outcome: "refused", reason: "no_corpus_for_assessment_year", evidenceIds: [] });
  assert.deepEqual(result.evidenceIds, [], "a refusal contributes no evidence");
  // The model, unlike the caller's record, gets the whole typed refusal, detail included.
  const toolMessage = model.requests[1].messages.find((m) => m.role === "tool");
  assert.match(toolMessage?.content ?? "", /no_corpus_for_assessment_year/);
  assert.deepEqual(JSON.parse(toolMessage?.content ?? "{}").detail.yearMismatch, { requested: "2026-27", stated: ["2024-25"] });
});

test("tax evidence ids survive the round trip, in the tool message and in the result, without the model retyping a quote", async () => {
  const tools = createAssistantTools({
    retrieve: async () => ({ status: "ok", assessmentYear: "2026-27", corpusVersion: "v1", evidence: [evidence(1), evidence(2)], unmatchedSectionRefs: [], sectionResolutions: [] }),
  });
  const args = { question: "What is the 87A rebate?", assessmentYear: "2026-27" };
  const model = scriptedModel(toolCalls(call("c1", "search_tax_law", args)), toolCalls(call("c2", "search_tax_law", args)), text("Section 87A gives a rebate [ev_0000000000000001]."));
  const result = await runAssistant({ userId: USER, messages: ask() }, { model, tools });

  assert.deepEqual(result.evidenceIds, ["ev_0000000000000001", "ev_0000000000000002"], "in order, without repeats");
  const toolText = model.requests[1].messages.filter((m) => m.role === "tool").map((m) => m.content).join("");
  assert.match(toolText, /ev_0000000000000001/);
  assert.match(toolText, /quote 1/);
  assert.equal(result.text, "Section 87A gives a rebate [ev_0000000000000001].", "the model's final text is returned as it wrote it");
  assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /evidenceId/);
  assert.match(ORCHESTRATOR_SYSTEM_PROMPT, /do not retype/i);
});

test("deterministic tool output from the REAL engine is passed back exactly as the tool returns it", async () => {
  const real = createAssistantTools();
  const args = { regime: "old", ...taxBody };
  const realModel = scriptedModel(toolCalls(call("c", "calculate_tax", args)), text("ok"));
  await runAssistant({ userId: USER, messages: ask() }, { model: realModel, tools: real });
  assert.equal(realModel.requests[1].messages.find((m) => m.role === "tool")?.content, JSON.stringify(await real.calculate_tax(USER, args)));
});
