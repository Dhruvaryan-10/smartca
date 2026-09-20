// Phase 6 hardening (B6): the contract between the six REAL tools and the answer layer. DATABASE-BACKED file (note the .db in its
// name): the real tools import the database client, and compare_tax_regimes reads the assessment_years reference row, so it needs
// DATABASE_URL and the seeded local database. Nothing is written: retrieval and the ledger are injected, and the rest is the
// deterministic engine.
//
// The answer layer (lib/assistant/answer.ts) has no imports, so it cannot share the tools' types. It re-reads each tool's result
// by shape instead. This file is what keeps the two from drifting apart silently:
//   1. every tool's REAL result is accepted by the answer layer (no invalid_tool_result, no invalid_tool_record) and yields the
//      fact the layer promises: fail clearly, naming the tool, if a shape changes;
//   2. each tool's result KEYS are pinned, so a renamed or removed field fails here first, with instructions;
//   3. the hand-built envelopes the PURE tests use (tests/helpers-answer.ts) still have the real shape, so those tests stay honest.
// It does not re-implement any tool: it calls them.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswer } from "../lib/assistant/answer";
import type { ToolRecord } from "../lib/assistant/answer";
import { askAssistant } from "../services/assistant/ask";
import { createAssistantTools } from "../services/assistant/tools";
import type { ToolResult } from "../services/assistant/tools";
import type { TaxRetrievalResult } from "../services/tax-retrieval";
import { calcRecord, calcResult, compareRecord, evidence as helperEvidence, inr, searchRecord, simulateRecord, summaryRecord, transactionsRecord } from "./helpers-answer";
import { USER, call, evidence as retrievedEvidence, scriptedModel, taxBody, text, toolCalls } from "./helpers-orchestrator";

const ROWS = [
  { id: "r1", occurredOn: "2026-01-10", type: "income", amountPaise: 100_000, category: "Salary", description: "January salary", source: "manual" },
  { id: "r2", occurredOn: "2026-02-10", type: "expense", amountPaise: 30_000, category: "Rent", description: "Rent", source: "manual" },
  { id: "r3", occurredOn: "2026-03-05", type: "expense", amountPaise: 5_000, category: "Food", description: null, source: null },
];
const FOUND: TaxRetrievalResult = { status: "ok", assessmentYear: "2026-27", corpusVersion: "v1", evidence: [retrievedEvidence(1), retrievedEvidence(2)], unmatchedSectionRefs: [], sectionResolutions: [] };
const tools = createAssistantTools({ retrieve: async () => FOUND, listTransactions: async () => ROWS as never });
const scenario = { assessmentYear: taxBody.assessmentYear, ageCategory: taxBody.ageCategory, income: taxBody.income };

const real = async () => ({
  search_tax_law: await tools.search_tax_law(USER, { question: "What is the 87A rebate?", assessmentYear: "2026-27" }),
  query_transactions: await tools.query_transactions(USER, { includeDescription: true }),
  get_financial_summary: await tools.get_financial_summary(USER, {}),
  calculate_tax: await tools.calculate_tax(USER, { regime: "old", ...taxBody }),
  compare_tax_regimes: await tools.compare_tax_regimes(USER, taxBody),
  simulate_tax: await tools.simulate_tax(USER, { regime: "old", base: taxBody, scenario }),
} as const);

const drift = (tool: string, what: string) => `${tool}: ${what}. The tool's result shape and lib/assistant/answer.ts (parseOk) must change together: update the reader and this test.`;
const record = (tool: string, result: ToolResult<unknown>): ToolRecord => ({ round: 1, callId: `${tool}-1`, tool, result });
const problems = (a: ReturnType<typeof buildAnswer>) => a.violations.filter((v) => v.code === "invalid_tool_result" || v.code === "invalid_tool_record");

test("B6: every one of the six real tools succeeds here, so the contract below is checked on real output", async () => {
  const results = await real();
  for (const [tool, result] of Object.entries(results)) assert.equal(result.status, "ok", `${tool} should succeed on these inputs, got ${JSON.stringify(result).slice(0, 200)}`);
});

test("B6: the answer layer accepts each real tool result, and turns it into the fact it promises", async () => {
  const results = await real();
  const facts = (tool: keyof typeof results) => buildAnswer({ text: "Ok.", toolRecords: [record(tool, results[tool])] });

  const search = facts("search_tax_law");
  assert.deepEqual(problems(search), [], drift("search_tax_law", "the answer layer rejects the real result"));
  assert.deepEqual(search.facts.evidence.map((e) => e.evidenceId), FOUND.status === "ok" ? FOUND.evidence.map((e) => e.evidenceId) : [], drift("search_tax_law", "evidence ids are not preserved in order"));

  const query = facts("query_transactions");
  assert.deepEqual(problems(query), [], drift("query_transactions", "the answer layer rejects the real result"));
  assert.equal(query.facts.ledger[0]?.shape, "transactions", drift("query_transactions", "no transactions fact"));
  assert.deepEqual((query.facts.ledger[0].payload as { totals: unknown }).totals, { incomePaise: 100_000, expensePaise: 35_000 }, drift("query_transactions", "totals are not preserved"));

  const summary = facts("get_financial_summary");
  assert.deepEqual(problems(summary), [], drift("get_financial_summary", "the answer layer rejects the real result"));
  assert.equal(summary.facts.ledger[0]?.shape, "summary", drift("get_financial_summary", "no summary fact"));
  assert.equal((summary.facts.ledger[0].payload as { incomePaise: number }).incomePaise, 100_000, drift("get_financial_summary", "the income figure is not preserved"));

  const calc = facts("calculate_tax");
  assert.deepEqual(problems(calc), [], drift("calculate_tax", "the answer layer rejects the real result"));
  assert.equal(calc.facts.taxValues[0]?.shape, "single_regime", drift("calculate_tax", "no single-regime tax fact"));
  assert.deepEqual((calc.facts.taxValues[0].payload as { result: unknown }).result, calcResult("old"), drift("calculate_tax", "the engine's result is not carried verbatim"));

  const compare = facts("compare_tax_regimes");
  assert.deepEqual(problems(compare), [], drift("compare_tax_regimes", "the answer layer rejects the real result"));
  assert.equal(compare.facts.taxValues[0]?.shape, "regime_comparison", drift("compare_tax_regimes", "no comparison fact"));
  assert.ok(compare.facts.taxValues[0].notice !== null, drift("compare_tax_regimes", "the comparison's notice is not preserved"));

  const simulate = facts("simulate_tax");
  assert.deepEqual(problems(simulate), [], drift("simulate_tax", "the answer layer rejects the real result"));
  assert.equal(simulate.facts.taxValues[0]?.shape, "scenario", drift("simulate_tax", "no scenario fact"));
});

test("B6: refusals from the real tools keep their reason and detail through the answer layer", async () => {
  const refusedTax = await tools.calculate_tax(USER, { regime: "new", ...taxBody });
  const a = buildAnswer({ text: "I can't compute that.", toolRecords: [record("calculate_tax", refusedTax)] });
  assert.equal(a.state, "unsupported");
  assert.deepEqual(a.facts.refusals.map((r) => r.reason), ["unsupported_tax_rule"]);
  const refusedLaw = createAssistantTools({ retrieve: async () => ({ status: "insufficient_evidence", reason: "no_corpus_for_assessment_year", assessmentYear: "2026-27", corpusVersion: "v1", sectionRefs: ["87A"], yearMismatch: { requested: "2026-27", stated: ["2024-25"] } }) });
  const law = await refusedLaw.search_tax_law(USER, { question: "87A in AY 2024-25?", assessmentYear: "2026-27" });
  const b = buildAnswer({ text: "The corpus does not cover that year.", toolRecords: [record("search_tax_law", law)] });
  assert.equal(b.state, "insufficient_evidence");
  assert.deepEqual(b.facts.refusals.map((r) => [r.reason, (r.detail as { yearMismatch: unknown }).yearMismatch]), [["no_corpus_for_assessment_year", { requested: "2026-27", stated: ["2024-25"] }]]);
});

/** The result keys of each tool, pinned. A renamed or removed key must fail HERE, with a message naming the tool. */
const KEYS: Record<string, string[]> = {
  search_tax_law: ["assessmentYear", "corpusVersion", "evidence", "sectionResolutions", "unmatchedSectionRefs"],
  query_transactions: ["dataNotice", "descriptionsIncluded", "fieldsTruncated", "filter", "matched", "returned", "totals", "transactions", "truncated"],
  get_financial_summary: ["categories", "expensePaise", "incomePaise", "months", "monthsTruncated", "period", "periodIsDefault", "range", "savingsPaise", "savingsRatePercent", "transactionCount"],
  calculate_tax: ["assessmentYear", "input", "regime", "result"],
  compare_tax_regimes: ["assessmentYear", "comparison", "input", "notice"],
  simulate_tax: ["base", "delta", "regime", "scenario"],
};
const EVIDENCE_KEYS = ["assessmentYear", "authorityTier", "corpusVersion", "effectiveFrom", "evidenceId", "publisher", "quote", "retrievedAt", "sectionRef", "sourceKey", "title", "url", "verificationStatus"];

test("B6: each tool's result keys are pinned: a changed shape fails here first and says which tool", async () => {
  const results = await real();
  for (const [tool, expected] of Object.entries(KEYS)) {
    const result = results[tool as keyof typeof results];
    assert.equal(result.status, "ok");
    assert.deepEqual(Object.keys((result as { result: object }).result).sort(), expected, drift(tool, "the result's keys changed"));
  }
  const evidence = (results.search_tax_law as { result: { evidence: object[] } }).result.evidence[0];
  assert.deepEqual(Object.keys(evidence).sort(), EVIDENCE_KEYS, drift("search_tax_law", "an evidence object's keys changed (chunkId and score must stay out)"));
  const row = (results.query_transactions as { result: { transactions: object[] } }).result.transactions[0];
  assert.deepEqual(Object.keys(row).sort(), ["amountPaise", "category", "description", "occurredOn", "source", "type"], drift("query_transactions", "a transaction row's keys changed (no id, no user, no import batch)"));
  const delta = (results.simulate_tax as { result: { delta: object } }).result.delta;
  assert.deepEqual(Object.keys(delta).sort(), ["assessmentYearLabel", "base", "change", "engineVersion", "regime", "rulesVersion", "scenario"], drift("simulate_tax", "the delta's keys changed"));
});

/** The key STRUCTURE of a value, ignoring the values and treating an empty list as unknown. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : [shapeOf(value[0])];
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]));
  return "value";
}
function sameShape(a: unknown, b: unknown): boolean {
  if (a === "[]" || b === "[]") return Array.isArray(a) ? true : a === "[]" && (b === "[]" || Array.isArray(b));
  if (Array.isArray(a) && Array.isArray(b)) return sameShape(a[0], b[0]);
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

test("B6: the hand-built envelopes the pure answer tests use still have the real tools' shape", async () => {
  const results = await real();
  const built: Record<string, unknown> = {
    search_tax_law: searchRecord([helperEvidence(1)]).result,
    query_transactions: transactionsRecord([{ occurredOn: "2026-01-10", type: "income", amountPaise: 100_000, category: "Salary", description: "x", source: "manual" }]).result,
    get_financial_summary: summaryRecord({ incomePaise: 100_000, expensePaise: 35_000, categories: [{ category: "Rent", totalPaise: 30_000 }] }).result,
    calculate_tax: calcRecord("old").result,
    compare_tax_regimes: compareRecord().result,
    simulate_tax: simulateRecord({}, { deductionRupees: 0 }).result,
  };
  for (const [tool, envelope] of Object.entries(built)) {
    const realResult = (results[tool as keyof typeof results] as { result: unknown }).result;
    const builtResult = (envelope as { result: unknown }).result;
    assert.ok(sameShape(shapeOf(builtResult), shapeOf(realResult)), `tests/helpers-answer.ts: the hand-built ${tool} envelope no longer has the real tool's shape. Rebuild it from the real tool's output, so the pure answer tests keep testing what the tools really return.`);
  }
});

test("end to end with the REAL tools: orchestrator (real tool set loaded on demand), then the answer layer; the tool's own figures are what the answer carries", async () => {
  const args = { regime: "old", assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
  const old = calcResult("old");
  const honest = `Under the old regime your tax is ${inr(old.totalTaxPaise)}.`;
  const answer = await askAssistant({ userId: USER, userMessages: ["What is my tax on 15 lakh with 80C?"] }, { model: scriptedModel(toolCalls(call("c1", "calculate_tax", args)), text(honest)) });
  assert.equal(answer.state, "answered");
  assert.deepEqual((answer.facts.taxValues[0].payload as { result: unknown }).result, old, "the engine's result, carried through unchanged");

  const tampered = await askAssistant({ userId: USER, userMessages: ["What is my tax on 15 lakh with 80C?"] }, { model: scriptedModel(toolCalls(call("c1", "calculate_tax", args)), text(`Under the old regime your tax is ${inr(old.totalTaxPaise - 100)}.`)) });
  assert.equal(tampered.state, "withheld");
  assert.deepEqual((tampered.facts.taxValues[0].payload as { result: unknown }).result, old, "the tool's value is untouched by what the model said");
});
