// RAG evaluation harness: scoring and aggregation. PURE tests: no database. They feed the scorer synthetic retrieval
// results whose correct verdict is obvious, so a change to the scoring rules is caught here and not by a number moving.
//
// These pin the harness, not retrieval quality. Retrieval quality is measured by `npm run rag:eval`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wilson } from "../lib/rag-eval/stats";
import { scoreCase } from "../lib/rag-eval/score";
import type { ChunkInfo, RunOutcome } from "../lib/rag-eval/score";
import { aggregate } from "../lib/rag-eval/aggregate";
import type { EvalCase, GoldEvidence } from "../lib/rag-eval/dataset";
import type { TaxEvidence, TaxRetrievalResult } from "../services/tax-retrieval";

// --- fixtures ------------------------------------------------------------------------

const SRC = "src-a";
const gold = (id: string, heading: string, anchors: string[], sourceKey = SRC): GoldEvidence => ({ id, description: id, sourceKey, heading, anchors });
const GOLD = new Map<string, GoldEvidence>([
  ["g-alpha", gold("g-alpha", "Alpha", ["alpha row"])],
  ["g-beta", gold("g-beta", "Beta", ["beta row"])],
  ["g-gamma", gold("g-gamma", "Gamma", ["gamma row"])],
  ["g-other", gold("g-other", "Alpha", ["alpha row"], "src-b")],
]);

const CHUNKS = new Map<string, ChunkInfo>([
  ["c-alpha", { sourceKey: SRC, headingPath: ["Top", "Alpha"], chunkIndex: 0, text: "intro\nalpha row is here\nmore" }],
  ["c-beta", { sourceKey: SRC, headingPath: ["Beta"], chunkIndex: 1, text: "beta row is here" }],
  ["c-gamma", { sourceKey: SRC, headingPath: ["Gamma"], chunkIndex: 2, text: "gamma row is here" }],
  ["c-other", { sourceKey: "src-b", headingPath: ["Alpha"], chunkIndex: 0, text: "alpha row elsewhere" }],
  ["c-noise", { sourceKey: SRC, headingPath: ["Noise"], chunkIndex: 3, text: "nothing relevant" }],
]);

const evidence = (chunkId: string, over: Partial<TaxEvidence> = {}): TaxEvidence => {
  const chunk = CHUNKS.get(chunkId);
  return {
    evidenceId: `ev_${chunkId}`,
    chunkId,
    sourceKey: chunk?.sourceKey ?? SRC,
    title: "t",
    publisher: "p",
    url: "https://x.gov.in/",
    authorityTier: "official_guidance",
    sectionRef: null,
    quote: chunk ? chunk.text.split("\n").find((l) => /row/.test(l)) ?? chunk.text : "q",
    assessmentYear: "2026-27",
    effectiveFrom: null,
    retrievedAt: "2026-09-19T00:00:00.000Z",
    corpusVersion: "v1",
    verificationStatus: "primary_verified",
    score: 1,
    ...over,
  };
};

const ok = (evidenceList: TaxEvidence[], extra: Partial<Extract<TaxRetrievalResult, { status: "ok" }>> = {}): RunOutcome => ({
  kind: "result",
  result: { status: "ok", assessmentYear: "2026-27", corpusVersion: "v1", evidence: evidenceList, unmatchedSectionRefs: [], sectionResolutions: [], ...extra },
});
const insufficient = (reason: Extract<TaxRetrievalResult, { status: "insufficient_evidence" }>["reason"]): RunOutcome => ({
  kind: "result",
  result: { status: "insufficient_evidence", reason, assessmentYear: "2026-27", corpusVersion: "v1", sectionRefs: [] },
});

const makeCase = (over: Partial<EvalCase> = {}): EvalCase => ({
  id: "tst-01",
  category: "cat",
  question: "q?",
  assessmentYear: "2026-27",
  expectedBehavior: "answer",
  split: "dev",
  review: { status: "gold" },
  engineRequired: false,
  retrieval: { expectation: "ok" },
  expectedEvidence: [{ anyOf: ["g-alpha"] }],
  contextEvidence: [],
  distractorEvidence: [],
  forbiddenAuthorityTiers: [],
  requiredAuthorityTiers: [],
  expectedSectionResolutions: [],
  tags: [],
  notes: "",
  ...over,
});

const score = (c: EvalCase, outcome: RunOutcome) => scoreCase(c, outcome, GOLD, CHUNKS);
const kinds = (s: ReturnType<typeof score>) => s.failures.map((f) => f.kind).sort();
const hard = (s: ReturnType<typeof score>) => s.failures.filter((f) => f.hard).map((f) => f.kind).sort();

// --- Wilson interval -----------------------------------------------------------------

test("wilson: known 95% intervals, and no interval when there is nothing to count", () => {
  const half = wilson(5, 10);
  assert.equal(half.rate, 0.5);
  assert.ok(Math.abs(half.low! - 0.2366) < 0.0005 && Math.abs(half.high! - 0.7634) < 0.0005);
  const none = wilson(0, 10);
  assert.equal(none.low, 0);
  assert.ok(Math.abs(none.high! - 0.2775) < 0.0005);
  const all = wilson(10, 10);
  assert.equal(all.high, 1);
  assert.ok(Math.abs(all.low! - 0.7225) < 0.0005);
  assert.deepEqual(wilson(0, 0), { k: 0, n: 0, rate: null, low: null, high: null });
  assert.throws(() => wilson(3, 2), /k must be between 0 and n/);
});

// --- recall, MRR, quote support ------------------------------------------------------

test("a gold chunk at rank 2 is missed at k=1, found at k=3, and gives a reciprocal rank of 0.5", () => {
  const s = score(makeCase(), ok([evidence("c-noise"), evidence("c-alpha")]));
  assert.deepEqual(s.requirements.map((r) => r.rank), [2]);
  assert.equal(s.firstGoldRank, 2);
  assert.equal(s.reciprocalRank, 0.5);
  assert.deepEqual(kinds(s), []);
});

test("gold is matched by source, heading and anchor text: the same anchor under another source does not count", () => {
  const s = score(makeCase(), ok([evidence("c-other")]));
  assert.equal(s.requirements[0].rank, null);
  assert.deepEqual(kinds(s), ["gold_not_retrieved"]);
});

test("a requirement can be met by any of its alternatives, and every requirement of a multi-chunk case is needed", () => {
  const either = score(makeCase({ expectedEvidence: [{ anyOf: ["g-beta", "g-alpha"] }] }), ok([evidence("c-alpha")]));
  assert.equal(either.requirements[0].satisfiedBy, "g-alpha");

  const both = makeCase({ expectedEvidence: [{ anyOf: ["g-alpha"] }, { anyOf: ["g-beta"] }] });
  const partial = score(both, ok([evidence("c-alpha")]));
  assert.deepEqual(partial.requirements.map((r) => r.rank), [1, null]);
  assert.deepEqual(kinds(partial), ["gold_not_retrieved"]);
  assert.match(partial.failures[0].detail, /g-beta/);
});

test("quote support: the returned quote must contain the anchor, and an unsupported quote is a failure", () => {
  const supported = score(makeCase(), ok([evidence("c-alpha")]));
  assert.equal(supported.requirements[0].quoteSupported, true);

  const unsupported = score(makeCase(), ok([evidence("c-alpha", { quote: "intro" })]));
  assert.equal(unsupported.requirements[0].quoteSupported, false);
  assert.deepEqual(kinds(unsupported), ["quote_does_not_support_gold"]);
});

// --- false-insufficient, false-ok, typed reasons -------------------------------------

test("an answerable case that comes back insufficient is a false-insufficient; only a section reason is a HARD failure", () => {
  const generic = score(makeCase(), insufficient("no_matching_passages"));
  assert.equal(generic.falseInsufficient, true);
  assert.deepEqual(hard(generic), []);
  assert.deepEqual(kinds(generic), ["false_insufficient", "gold_not_retrieved"]);

  const bySection = score(makeCase(), insufficient("section_not_in_corpus"));
  assert.deepEqual(hard(bySection), ["answerable_case_unsupported_by_section_resolution"]);
});

test("false-ok and typed-reason accuracy apply to insufficient cases only, and a right status with a wrong reason fails", () => {
  const c = makeCase({
    expectedBehavior: "insufficient_evidence",
    retrieval: { expectation: "insufficient_evidence", reasons: ["no_matching_passages"] },
    expectedEvidence: [],
  });
  const good = score(c, insufficient("no_matching_passages"));
  assert.equal(good.falseOk, false);
  assert.equal(good.reasonCorrect, true);
  assert.deepEqual(kinds(good), []);

  const wrongReason = score(c, insufficient("section_not_in_corpus"));
  assert.equal(wrongReason.falseOk, false);
  assert.equal(wrongReason.reasonCorrect, false);
  assert.deepEqual(kinds(wrongReason), ["wrong_reason"]);

  const falseOk = score(c, ok([evidence("c-alpha")]));
  assert.equal(falseOk.falseOk, true);
  assert.equal(falseOk.reasonCorrect, false);
  assert.deepEqual(kinds(falseOk), ["false_ok"]);
});

test("a partial-support insufficient case asserts no retrieval status: ok is not a false-ok, and it is reported as such", () => {
  const c = makeCase({ expectedBehavior: "insufficient_evidence", retrieval: { expectation: "not_asserted" }, expectedEvidence: [], contextEvidence: ["g-alpha"] });
  const s = score(c, ok([evidence("c-alpha")]));
  assert.equal(s.falseOk, null);
  assert.equal(s.reasonCorrect, null);
  assert.deepEqual(kinds(s), []);
});

// --- distractors ---------------------------------------------------------------------

test("distractor intrusion is measured at ranks 1, 3 and 5, and a distractor in the top 3 is a failure", () => {
  const c = makeCase({ distractorEvidence: ["g-gamma"] });
  const leads = score(c, ok([evidence("c-gamma"), evidence("c-alpha")]));
  assert.deepEqual(leads.distractor, { at1: true, at3: true, at5: true, ids: ["g-gamma"] });
  assert.deepEqual(kinds(leads), ["distractor_in_top3"]);

  const late = score(c, ok([evidence("c-alpha"), evidence("c-noise"), evidence("c-noise", { evidenceId: "ev2" }), evidence("c-noise", { evidenceId: "ev3" }), evidence("c-gamma")]));
  assert.deepEqual(late.distractor, { at1: false, at3: false, at5: true, ids: ["g-gamma"] });
  assert.deepEqual(kinds(late), []);

  assert.equal(score(makeCase(), ok([evidence("c-alpha")])).distractor, null);
});

// --- hard safety failures ------------------------------------------------------------

test("hard: evidence for the wrong assessment year, including a year the question is about", () => {
  const wrong = score(makeCase(), ok([evidence("c-alpha", { assessmentYear: "2025-26" })]));
  assert.deepEqual(hard(wrong), ["wrong_assessment_year_evidence"]);

  // The parameter was 2026-27 and the evidence is 2026-27, but the question is about AY 2024-25: nothing may stand in for it.
  const c = makeCase({ questionAssessmentYears: ["2024-25"] });
  assert.deepEqual(hard(score(c, ok([evidence("c-alpha")]))), ["wrong_assessment_year_evidence"]);
  assert.deepEqual(hard(score(c, insufficient("no_matching_passages"))), []);

  const spanning = makeCase({ questionAssessmentYears: ["2026-27", "2025-26"] });
  assert.deepEqual(hard(score(spanning, ok([evidence("c-alpha")]))), []);
});

test("hard: a quote that is not a verbatim slice of its stored passage, or whose passage cannot be found", () => {
  const fabricated = score(makeCase(), ok([evidence("c-alpha", { quote: "alpha row is HERE" })]));
  assert.ok(hard(fabricated).includes("non_verbatim_quote"));

  const unknownChunk = score(makeCase(), ok([evidence("c-alpha", { chunkId: "c-missing" })]));
  assert.ok(hard(unknownChunk).includes("non_verbatim_quote"));

  const tooLong = new Map(CHUNKS).set("c-long", { sourceKey: SRC, headingPath: ["Long"], chunkIndex: 9, text: "x".repeat(500) });
  const s = scoreCase(makeCase(), ok([evidence("c-long", { quote: "x".repeat(401) })]), GOLD, tooLong);
  assert.ok(hard(s).includes("non_verbatim_quote"), "over the 400-character contract");
});

test("hard: evidence from a forbidden authority tier", () => {
  const c = makeCase({ forbiddenAuthorityTiers: ["statute"] });
  assert.deepEqual(hard(score(c, ok([evidence("c-alpha", { authorityTier: "statute" })]))), ["forbidden_authority_tier_evidence"]);
  assert.deepEqual(hard(score(c, ok([evidence("c-alpha")]))), []);
});

test("hard: a claim that needs statute or a circular, supported only by official guidance", () => {
  const c = makeCase({ requiredAuthorityTiers: ["statute", "notification_circular"], expectedBehavior: "insufficient_evidence", retrieval: { expectation: "insufficient_evidence" }, expectedEvidence: [] });
  assert.deepEqual(hard(score(c, ok([evidence("c-alpha")]))), ["higher_tier_claim_supported_only_by_guidance"]);
  assert.deepEqual(hard(score(c, ok([evidence("c-alpha", { authorityTier: "statute" })]))), []);
  assert.deepEqual(hard(score(c, insufficient("no_matching_passages"))), []);
});

// --- route_to_engine and refuse_out_of_scope: safety only ----------------------------

test("route and refuse cases are never scored for recall, MRR, false-ok or reasons, only for the safety properties", () => {
  const c = makeCase({ expectedBehavior: "route_to_engine", engineRequired: true, retrieval: { expectation: "not_asserted" }, expectedEvidence: [], contextEvidence: ["g-alpha"] });
  const s = score(c, ok([evidence("c-noise")]));
  assert.equal(s.requirements.length, 0);
  assert.equal(s.reciprocalRank, null);
  assert.equal(s.falseInsufficient, null);
  assert.equal(s.falseOk, null);
  assert.equal(s.reasonCorrect, null);
  assert.equal(s.distractor, null);
  assert.deepEqual(kinds(s), []);

  const wrongYear = score(c, ok([evidence("c-noise", { assessmentYear: "2025-26" })]));
  assert.deepEqual(hard(wrongYear), ["wrong_assessment_year_evidence"]);
});

test("hard: an engine-required case whose retrieval result carries anything but evidence (an answer or an amount)", () => {
  const c = makeCase({ expectedBehavior: "route_to_engine", engineRequired: true, retrieval: { expectation: "not_asserted" }, expectedEvidence: [] });
  const withAmount: RunOutcome = { kind: "result", result: { ...(ok([evidence("c-noise")]) as { result: TaxRetrievalResult }).result, taxPayable: 12345 } as unknown as TaxRetrievalResult };
  assert.deepEqual(hard(score(c, withAmount)), ["engine_required_numeric_answer_from_evidence"]);

  const inEvidence: RunOutcome = { kind: "result", result: { status: "ok", assessmentYear: "2026-27", corpusVersion: "v1", evidence: [{ ...evidence("c-noise"), amount: 1 } as unknown as TaxEvidence], unmatchedSectionRefs: [], sectionResolutions: [] } };
  assert.deepEqual(hard(score(c, inEvidence)), ["engine_required_numeric_answer_from_evidence"]);

  assert.deepEqual(hard(score(c, ok([evidence("c-noise")]))), []);
  // The same stray field on a case that does not need the engine is not this failure.
  assert.deepEqual(hard(score(makeCase({ expectedEvidence: [] }), withAmount)), []);
});

// --- Phase 5C: the safe refusals for a year mismatch and a missing authority tier ------------------

const yearRefusal = (reason: "no_corpus_for_assessment_year" | "assessment_year_mismatch"): RunOutcome => ({
  kind: "result",
  result: { status: "insufficient_evidence", reason, assessmentYear: "2026-27", corpusVersion: "v1", sectionRefs: [], yearMismatch: { requested: "2026-27", stated: ["2024-25"] } },
});
const tierRefusal: RunOutcome = {
  kind: "result",
  result: {
    status: "insufficient_evidence", reason: "required_authority_tier_unavailable", assessmentYear: "2026-27", corpusVersion: "v1", sectionRefs: [],
    authorityTier: { required: ["statute"], available: ["official_guidance"] },
  },
};
const otherYearCase = makeCase({
  id: "tst-05", question: "other year?", expectedBehavior: "insufficient_evidence", questionAssessmentYears: ["2024-25"],
  retrieval: { expectation: "insufficient_evidence", reasons: ["no_corpus_for_assessment_year"] }, expectedEvidence: [],
});
const statuteCase = makeCase({
  id: "tst-06", question: "statute?", expectedBehavior: "insufficient_evidence", requiredAuthorityTiers: ["statute"],
  retrieval: { expectation: "insufficient_evidence", reasons: ["required_authority_tier_unavailable"] }, expectedEvidence: [],
});

test("a question about another year: returning this year's evidence is a hard failure, the typed refusal is safe and is carried into the score", () => {
  const unsafe = score(otherYearCase, ok([evidence("c-alpha")]));
  assert.deepEqual(hard(unsafe), ["wrong_assessment_year_evidence"]);
  assert.equal(unsafe.falseOk, true);

  const safe = score(otherYearCase, yearRefusal("no_corpus_for_assessment_year"));
  assert.deepEqual(safe.failures, []);
  assert.equal(safe.falseOk, false);
  assert.equal(safe.reasonCorrect, true);
  assert.deepEqual(safe.actual.yearMismatch, { requested: "2026-27", stated: ["2024-25"] });
  assert.equal(safe.actual.authorityTier, null);
  assert.deepEqual(safe.actual.evidence, [], "a refusal carries no evidence");
});

test("a claim that needs statute: guidance-only evidence is a hard failure, the typed refusal is safe and names the tiers", () => {
  const unsafe = score(statuteCase, ok([evidence("c-alpha")]));
  assert.deepEqual(hard(unsafe), ["higher_tier_claim_supported_only_by_guidance"]);

  const safe = score(statuteCase, tierRefusal);
  assert.deepEqual(safe.failures, []);
  assert.equal(safe.reasonCorrect, true);
  assert.deepEqual(safe.actual.authorityTier, { required: ["statute"], available: ["official_guidance"] });
  assert.equal(safe.actual.yearMismatch, null);
});

test("the two typed refusals are wrong reasons where a case expects something else, and are never mistaken for a section failure", () => {
  const expectsNoPassages = makeCase({ expectedBehavior: "insufficient_evidence", retrieval: { expectation: "insufficient_evidence", reasons: ["no_matching_passages"] }, expectedEvidence: [] });
  assert.deepEqual(kinds(score(expectsNoPassages, tierRefusal)), ["wrong_reason"]);
  assert.deepEqual(hard(score(expectsNoPassages, tierRefusal)), []);
  // An answerable case refused for a year or tier is a false-insufficient, not the section-resolution hard failure.
  assert.deepEqual(kinds(score(makeCase(), tierRefusal)), ["false_insufficient", "gold_not_retrieved"]);
  assert.deepEqual(hard(score(makeCase(), yearRefusal("assessment_year_mismatch"))), []);
});

test("the structural engine check accepts the safety fields, which are not answers or amounts", () => {
  const c = makeCase({ expectedBehavior: "route_to_engine", engineRequired: true, retrieval: { expectation: "not_asserted" }, expectedEvidence: [] });
  assert.deepEqual(hard(score(c, yearRefusal("assessment_year_mismatch"))), []);
  assert.deepEqual(hard(score(c, tierRefusal)), []);
});

// --- section resolution --------------------------------------------------------------

test("section-resolution accuracy compares basis, resolved section and clause coverage, and a missing resolution is wrong", () => {
  const c = makeCase({ expectedSectionResolutions: [{ requested: "80CCD(1B)", basis: "cited_in_passage", resolvedTo: "80CCD(1B)", clauseCovered: true }] });
  const right = score(c, ok([evidence("c-alpha")], { sectionResolutions: [{ requested: "80CCD(1b)", basis: "cited_in_passage", resolvedTo: "80CCD(1b)", clauseCovered: true, evidenceIds: ["ev_c-alpha"] }] }));
  assert.deepEqual(right.sectionResolutions.map((r) => r.correct), [true]);
  assert.deepEqual(kinds(right), []);

  const wrongBasis = score(c, ok([evidence("c-alpha")], { sectionResolutions: [{ requested: "80CCD(1b)", basis: "parent_section", resolvedTo: "80CCD", clauseCovered: false, evidenceIds: [] }] }));
  assert.deepEqual(wrongBasis.sectionResolutions.map((r) => r.correct), [false]);
  assert.deepEqual(kinds(wrongBasis), ["section_resolution_mismatch"]);

  const absent = score(c, insufficient("section_not_in_corpus"));
  assert.deepEqual(absent.sectionResolutions.map((r) => r.correct), [false]);
});

test("a retrieval error is recorded as a failure of the case, not a crash of the run", () => {
  const s = score(makeCase(), { kind: "error", message: "boom" });
  assert.equal(s.actual.status, "error");
  assert.deepEqual(kinds(s), ["gold_not_retrieved", "retrieval_error"]);
});

// --- aggregation ---------------------------------------------------------------------

test("aggregation: the primary block holds gold cases only, provisional cases get their own block, nothing is dropped", () => {
  const goldCase = makeCase({ id: "tst-01" });
  const provisional = makeCase({ id: "tst-02", question: "q2?", review: { status: "provisional", priority: "must_review", reason: "needs a tax professional" } });
  const scores = [
    score(goldCase, ok([evidence("c-alpha")])),
    score(provisional, insufficient("no_matching_passages")),
  ];

  const primary = aggregate(scores.filter((s) => s.reviewStatus === "gold"));
  const prov = aggregate(scores.filter((s) => s.reviewStatus === "provisional"));
  assert.equal(primary.cases, 1);
  assert.equal(prov.cases, 1);
  assert.deepEqual([primary.recallAt[1].k, primary.recallAt[1].n], [1, 1]);
  assert.deepEqual([prov.recallAt[1].k, prov.recallAt[1].n], [0, 1]);
  assert.deepEqual([prov.falseInsufficient.k, prov.falseInsufficient.n], [1, 1]);
  assert.equal(primary.mrr.mean, 1);
  assert.equal(prov.mrr.mean, 0);
});

test("aggregation: recall is pooled over requirements, full-case recall needs every requirement, and Wilson bounds ride along", () => {
  const two = makeCase({ expectedEvidence: [{ anyOf: ["g-alpha"] }, { anyOf: ["g-beta"] }] });
  const m = aggregate([score(two, ok([evidence("c-alpha"), evidence("c-noise")]))]);
  assert.deepEqual([m.recallAt[5].k, m.recallAt[5].n], [1, 2]);
  assert.deepEqual([m.fullCaseRecallAt[5].k, m.fullCaseRecallAt[5].n], [0, 1]);
  assert.ok(m.recallAt[5].low! < 0.5 && m.recallAt[5].high! > 0.5);
  assert.deepEqual([m.quoteSupport.k, m.quoteSupport.n], [1, 1], "quote support is over the requirements that were retrieved");
});

test("aggregation: an empty bucket has no rates, not zero rates", () => {
  const m = aggregate([]);
  assert.equal(m.cases, 0);
  assert.equal(m.recallAt[1].rate, null);
  assert.equal(m.mrr.mean, null);
  assert.equal(m.falseOk.rate, null);
});
