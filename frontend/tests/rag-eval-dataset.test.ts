// RAG evaluation dataset (rag-evals/ay-2026-27-v1): schema, splits, gold evidence, and the freeze on the test set.
// No database: everything here is about the files, the shipped corpus, and the rules that keep the evaluation honest.
//
// These tests pin the DATASET. They never look at what retrieval returns, so a gold label can never be adjusted to
// make a result look better.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCorpusFromDisk, DEFAULT_CORPUS_DIR } from "../lib/rag/load-corpus";
import { requiredAuthorityTiers, statedAssessmentYears } from "../lib/rag/question-scope";
import { EXPECTED_BEHAVIORS, EvalDatasetError, checkDatasetAgainstCorpus, parseEvalDataset, testSetFingerprint } from "../lib/rag-eval/dataset";
import { loadEvalDataset, loadRawEvalDataset } from "../lib/rag-eval/load-dataset";
import type { RawEvalDataset } from "../lib/rag-eval/dataset";

const FRONTEND = path.resolve(__dirname, "..");

// The split and the review lists come from the Phase 5B discovery report and are pinned here on purpose: changing a
// split, or promoting a provisional case to gold, must be a visible edit to this file and a new dataset version.
const DEV = [
  "slb-01", "slb-02", "slb-04", "slb-05", "reb-03", "c80-02", "d80-01", "sur-01", "ces-01", "sen-01", "idx-01",
  "idx-02", "ayi-01", "ayi-02", "ayi-03", "mis-01", "mis-02", "ins-01", "eng-01", "eng-04", "oos-02", "oos-05",
];
const TEST = [
  "slb-03", "c80-03", "d80-02", "sur-02", "sur-03", "sur-05", "sen-02", "idx-03", "idx-04",
  "reb-01", "reb-02", "c80-01", "std-01", "std-02", "ces-02", "sen-03", "sen-04", "ayi-04", "ayi-05", "mis-03", "mis-04", "idx-05", "ins-02", "ins-03", "ins-04",
  "eng-02", "eng-03", "eng-05", "eng-06", "d80-03", "sur-04",
  "oos-01", "oos-03", "oos-04",
];
const MUST_REVIEW = ["reb-01", "reb-02", "c80-01", "c80-03", "ces-02", "sur-02", "sur-03", "sen-03", "sen-04", "ayi-04", "mis-04", "ins-02", "ins-03", "eng-06"];
const LOW_PRIORITY = ["slb-03", "slb-05", "sen-02", "d80-02", "c80-02", "idx-02"];
const OWNER_DECISION = ["idx-05"];

const raw = (): RawEvalDataset => structuredClone(loadRawEvalDataset());
const dataset = loadEvalDataset();
const corpus = loadCorpusFromDisk();
const sorted = (xs: string[]) => [...xs].sort();

/** The issues a mutated dataset is refused with. */
function issuesOf(mutate: (d: RawEvalDataset) => void): string {
  const d = raw();
  mutate(d);
  try {
    parseEvalDataset(d);
  } catch (error) {
    if (error instanceof EvalDatasetError) return error.issues.join("\n");
    throw error;
  }
  return "";
}

// --- the shipped dataset -------------------------------------------------------------

test("the dataset has 56 cases: 22 dev and 34 test, with the behaviour mix the discovery report designed", () => {
  assert.equal(dataset.cases.length, 56);
  assert.deepEqual(sorted(dataset.cases.filter((c) => c.split === "dev").map((c) => c.id)), sorted(DEV));
  assert.deepEqual(sorted(dataset.cases.filter((c) => c.split === "test").map((c) => c.id)), sorted(TEST));
  const count = (b: string) => dataset.cases.filter((c) => c.expectedBehavior === b).length;
  assert.deepEqual([count("answer"), count("insufficient_evidence"), count("route_to_engine"), count("refuse_out_of_scope")], [21, 22, 8, 5]);
});

test("no duplicate ids and no duplicate questions (case, spacing and punctuation-insensitive)", () => {
  const ids = dataset.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  const normal = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const questions = dataset.cases.map((c) => normal(c.question));
  assert.equal(new Set(questions).size, questions.length);
});

test("every case has a valid behaviour, a retrieval expectation consistent with it, and the fields its behaviour needs", () => {
  for (const c of dataset.cases) {
    assert.ok((EXPECTED_BEHAVIORS as readonly string[]).includes(c.expectedBehavior), `${c.id}: behaviour`);
    if (c.expectedBehavior === "answer") {
      assert.equal(c.retrieval.expectation, "ok", c.id);
      assert.ok(c.expectedEvidence.length > 0, `${c.id}: an answer case needs gold evidence`);
    } else {
      assert.equal(c.expectedEvidence.length, 0, `${c.id}: only answer cases carry scored gold evidence`);
    }
    if (c.expectedBehavior === "route_to_engine" || c.expectedBehavior === "refuse_out_of_scope") {
      assert.equal(c.retrieval.expectation, "not_asserted", `${c.id}: retrieval cannot prove the final behaviour`);
      assert.deepEqual(c.expectedSectionResolutions, [], c.id);
    }
    if (c.expectedBehavior === "route_to_engine") assert.equal(c.engineRequired, true, c.id);
    assert.ok(c.notes.trim().length > 0, `${c.id}: every case says why it belongs`);
  }
});

test("dev/test membership: every case is in exactly one split, the lists in meta.json agree, and the discovery report's split is kept", () => {
  const { dev, test: testIds } = dataset.meta.splits;
  assert.deepEqual(sorted(dev), sorted(DEV));
  assert.deepEqual(sorted(testIds), sorted(TEST));
  assert.equal(dev.filter((id) => testIds.includes(id)).length, 0, "no case is in both splits");
  assert.equal(dev.length + testIds.length, dataset.cases.length);
  for (const c of dataset.cases) assert.equal(c.split, dev.includes(c.id) ? "dev" : "test", c.id);
});

test("provisional cases are explicitly marked, with a reason, exactly as the discovery report lists them; nothing was promoted", () => {
  const provisional = dataset.cases.filter((c) => c.review.status === "provisional");
  assert.deepEqual(sorted(provisional.map((c) => c.id)), sorted([...MUST_REVIEW, ...LOW_PRIORITY, ...OWNER_DECISION]));
  for (const c of provisional) {
    assert.ok(c.review.status === "provisional" && c.review.reason.trim().length > 20, `${c.id}: a provisional case says what needs review`);
    const expected = MUST_REVIEW.includes(c.id) ? "must_review" : LOW_PRIORITY.includes(c.id) ? "low_priority" : "owner_decision";
    assert.equal(c.review.status === "provisional" && c.review.priority, expected, c.id);
  }
  assert.equal(dataset.cases.length - provisional.length, 35);
});

test("every gold source exists in the shipped corpus and is active, and the dataset names that corpus version", () => {
  const sources = new Map(corpus.sources.map((s) => [s.sourceKey, s]));
  for (const g of dataset.goldEvidence) {
    assert.ok(sources.has(g.sourceKey), `${g.id}: unknown source ${g.sourceKey}`);
    assert.equal(sources.get(g.sourceKey)?.status, "active", `${g.id}: source is not active`);
  }
  assert.equal(dataset.meta.corpusVersion, corpus.version);
  assert.equal(dataset.meta.assessmentYear, corpus.assessmentYear);
});

test("every gold anchor exists in the shipped corpus, verbatim, in exactly one chunk under its heading", () => {
  assert.deepEqual(checkDatasetAgainstCorpus(dataset, corpus), []);
  // And independently of the checker: the anchors really are substrings of a chunk of that source under that heading.
  for (const g of dataset.goldEvidence) {
    const source = corpus.sources.find((s) => s.sourceKey === g.sourceKey)!;
    const hits = source.chunks.filter((ch) => ch.headingPath[ch.headingPath.length - 1] === g.heading && g.anchors.every((a) => ch.text.includes(a)));
    assert.equal(hits.length, 1, `${g.id}: ${hits.length} chunks match`);
  }
});

test("gold evidence is identified by source key, heading and anchor text, never by a database id, and every definition is used", () => {
  const text = JSON.stringify(dataset.goldEvidence);
  assert.doesNotMatch(text, /chunkId|chunk_id|evidenceId|ev_[0-9a-f]{16}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  for (const g of dataset.goldEvidence) assert.ok(g.anchors.length > 0 && g.anchors.every((a) => a.trim() === a && a.length >= 8), g.id);

  const used = new Set(dataset.cases.flatMap((c) => [...c.expectedEvidence.flatMap((r) => r.anyOf), ...c.contextEvidence, ...c.distractorEvidence]));
  assert.deepEqual(dataset.goldEvidence.map((g) => g.id).filter((id) => !used.has(id)), [], "a gold definition no case uses");
});

test("the cases do not invent evidence: a case that names gold names only definitions that exist", () => {
  const ids = new Set(dataset.goldEvidence.map((g) => g.id));
  for (const c of dataset.cases) {
    for (const ref of [...c.expectedEvidence.flatMap((r) => r.anyOf), ...c.contextEvidence, ...c.distractorEvidence]) assert.ok(ids.has(ref), `${c.id}: unknown gold ${ref}`);
    // A gold requirement and a distractor for the same case cannot be the same passage.
    const wanted = new Set(c.expectedEvidence.flatMap((r) => r.anyOf));
    assert.deepEqual(c.distractorEvidence.filter((d) => wanted.has(d)), [], c.id);
  }
});

// --- Phase 5C: retrieval's detectors and the labels must agree -------------------------------------

test("the year a question names agrees with the dataset's year labels, so retrieval's detector and the labels cannot drift apart", () => {
  const named: string[] = [];
  for (const c of dataset.cases) {
    const stated = statedAssessmentYears(c.question);
    if (stated.length === 0) continue;
    named.push(c.id);
    // What the labels say the question is about: `questionAssessmentYears`, else the year it was asked with.
    assert.deepEqual(sorted(stated), sorted(c.questionAssessmentYears ?? [c.assessmentYear]), `${c.id}: the question names ${stated.join(", ")}`);
  }
  // Every case that explicitly names a year, in one place, so a new one is a visible decision.
  assert.deepEqual(sorted(named), ["ayi-02", "ayi-03", "eng-04", "ins-01", "sen-02"]);
});

test("every case that names a year other than the one requested is labelled with the year it is about", () => {
  for (const c of dataset.cases) {
    const stated = statedAssessmentYears(c.question);
    if (stated.some((year) => year !== c.assessmentYear)) assert.ok(c.questionAssessmentYears, `${c.id}: names another year, so its hard-failure label needs questionAssessmentYears`);
  }
});

test("the authority tier a question demands agrees with the labels: nothing ordinary is flagged, and the cases retrieval cannot see are named", () => {
  const undetected: string[] = [];
  for (const c of dataset.cases) {
    const required = requiredAuthorityTiers(c.question);
    for (const tier of required) assert.ok(c.requiredAuthorityTiers.includes(tier), `${c.id}: the question demands ${tier}, but the case does not say its claim needs it`);
    if (c.requiredAuthorityTiers.length > 0 && required.length === 0) undetected.push(c.id);
  }
  // The claim needs a higher tier but the question does not SAY so (a circular the engine's comments cite; another Act), so
  // only an answer layer could know. The retrieval layer cannot see these, and this list makes that limit explicit.
  assert.deepEqual(sorted(undetected), ["ayi-04", "ins-03"]);
});

test("the dataset vocabulary accepts the Phase 5C reasons, without any label being edited", () => {
  for (const reason of ["assessment_year_mismatch", "required_authority_tier_unavailable"]) {
    assert.doesNotMatch(issuesOf((d) => { d.cases.find((c) => c.id === "ins-04")!.retrieval = { expectation: "insufficient_evidence", reasons: [reason] }; }), /retrieval\.reasons/);
  }
  assert.match(issuesOf((d) => { d.cases[0].retrieval = { expectation: "ok", reasons: ["made_up_reason"] }; }), /retrieval\.reasons/);
});

// --- the freeze on the test set ------------------------------------------------------

test("the test cases are frozen: their labels match the fingerprint recorded when they were created", () => {
  const rawDataset = loadRawEvalDataset();
  const freeze = (rawDataset.meta as { testFreeze: { fingerprintSha256: string; caseCount: number } }).testFreeze;
  assert.equal(freeze.caseCount, 34);
  assert.equal(testSetFingerprint(rawDataset), freeze.fingerprintSha256, "a test case's labels changed: that needs a NEW dataset version, not an edit");
});

test("the fingerprint notices a changed label but not a reworded note", () => {
  const base = testSetFingerprint(raw());
  const relabelled = raw();
  (relabelled.cases.find((c) => c.id === "sur-05") as Record<string, unknown>).expectedBehavior = "insufficient_evidence";
  assert.notEqual(testSetFingerprint(relabelled), base);

  const reworded = raw();
  (reworded.cases.find((c) => c.id === "sur-05") as Record<string, unknown>).notes = "A different explanation of the same label.";
  assert.equal(testSetFingerprint(reworded), base);

  const dev = raw();
  (dev.cases.find((c) => c.id === "slb-01") as Record<string, unknown>).question = "A tuned dev question?";
  assert.equal(testSetFingerprint(dev), base, "dev cases are not frozen");
});

// --- no test case doubles as dev data, and the set is independent of the regression cases ------

test("no test case is used as dev data: not in the retrieval code, not in the regression cases, not in any existing test", () => {
  const testCases = dataset.cases.filter((c) => c.split === "test");
  const productionFiles = ["services/tax-retrieval.ts", "services/tax-corpus.ts", "lib/rag/corpus.ts", "lib/rag/section-resolution.ts", "lib/rag/load-corpus.ts"];
  const production = productionFiles.map((f) => fs.readFileSync(path.join(FRONTEND, f), "utf8")).join("\n");
  const regression = fs.readFileSync(path.join(DEFAULT_CORPUS_DIR, "retrieval-tests.json"), "utf8");
  const existingTests = fs
    .readdirSync(path.join(FRONTEND, "tests"))
    .filter((f) => /^rag-(corpus|ingest|retrieval|schema|security|section-refs)\.test\.ts$/.test(f) || f === "helpers-rag.ts" || f === "helpers-corpus.ts")
    .map((f) => fs.readFileSync(path.join(FRONTEND, "tests", f), "utf8"))
    .join("\n");

  for (const c of testCases) {
    for (const [where, haystack] of [["retrieval code", production], ["regression cases", regression], ["existing tests", existingTests]] as const) {
      assert.ok(!haystack.includes(c.question), `${c.id}: its question appears in ${where}`);
      assert.ok(!haystack.includes(`"${c.id}"`), `${c.id}: its id appears in ${where}`);
    }
  }
});

test("the evaluation set is independent of the existing regression cases: no question is one of them", () => {
  const regression = (JSON.parse(fs.readFileSync(path.join(DEFAULT_CORPUS_DIR, "retrieval-tests.json"), "utf8")) as { cases: Array<{ question: string }> }).cases;
  assert.ok(regression.length >= 19);
  const normal = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const taken = new Set(regression.map((c) => normal(c.question)));
  for (const c of dataset.cases) assert.ok(!taken.has(normal(c.question)), `${c.id} repeats a regression question`);
});

// --- the validator refuses a bad dataset ---------------------------------------------

test("the validator refuses a duplicate id, and says which", () => {
  assert.match(issuesOf((d) => { d.cases[1].id = d.cases[0].id as string; }), /duplicate id "slb-01"/);
});

test("the validator refuses a duplicate question, however it is spaced or capitalised", () => {
  assert.match(issuesOf((d) => { d.cases[1].question = `  ${(d.cases[0].question as string).toUpperCase()}  `; }), /same question as/);
});

test("the validator refuses an invalid behaviour, split, year or field", () => {
  assert.match(issuesOf((d) => { d.cases[0].expectedBehavior = "maybe"; }), /expectedBehavior/);
  assert.match(issuesOf((d) => { d.cases[0].split = "validation"; }), /split/);
  assert.match(issuesOf((d) => { d.cases[0].assessmentYear = "2026"; }), /assessmentYear/);
  assert.match(issuesOf((d) => { d.cases[0].surprise = 1; }), /unknown field "surprise"/);
  assert.match(issuesOf((d) => { delete d.cases[0].notes; }), /notes/);
});

test("the validator refuses inconsistent split membership", () => {
  assert.match(issuesOf((d) => { (d.meta.splits as { test: string[] }).test.push("slb-01"); }), /slb-01.*both splits|both splits.*slb-01/);
  assert.match(issuesOf((d) => { d.cases[0].split = "test"; }), /slb-01.*split/);
  assert.match(issuesOf((d) => { (d.meta.splits as { dev: string[] }).dev.pop(); }), /not in any split/);
});

test("the validator refuses evidence that does not exist, and a case whose behaviour and evidence disagree", () => {
  assert.match(issuesOf((d) => { d.cases[0].expectedEvidence = [{ anyOf: ["nope"] }]; }), /unknown gold evidence "nope"/);
  assert.match(issuesOf((d) => { d.cases.find((c) => c.id === "eng-01")!.expectedEvidence = [{ anyOf: [(d.goldEvidence[0] as { id: string }).id] }]; }), /eng-01.*expectedEvidence/);
  assert.match(issuesOf((d) => { d.cases[0].expectedEvidence = []; }), /slb-01.*needs at least one/);
  assert.match(issuesOf((d) => { d.cases.find((c) => c.id === "eng-01")!.engineRequired = false; }), /eng-01.*engineRequired/);
  assert.match(issuesOf((d) => { d.cases.find((c) => c.id === "oos-01")!.retrieval = { expectation: "ok" }; }), /oos-01.*not_asserted/);
});

test("the validator refuses a provisional case with no reason, and a gold case that carries one", () => {
  assert.match(issuesOf((d) => { d.cases.find((c) => c.id === "reb-01")!.review = { status: "provisional", priority: "must_review" }; }), /reb-01.*reason/);
  assert.match(issuesOf((d) => { d.cases[0].review = { status: "gold", reason: "x" }; }), /slb-01.*review/);
});

test("the validator refuses a section reference that is not one, and a tier that does not exist", () => {
  assert.match(issuesOf((d) => { d.cases.find((c) => c.id === "idx-01")!.expectedSectionResolutions = [{ requested: "twelve lakh", basis: "indexed", resolvedTo: "87A", clauseCovered: true }]; }), /idx-01.*section reference/);
  assert.match(issuesOf((d) => { d.cases[0].forbiddenAuthorityTiers = ["blog"]; }), /forbiddenAuthorityTiers/);
});

test("the corpus check catches an unknown source, a missing anchor, and an anchor that matches more than one chunk", () => {
  const withGold = (patch: Record<string, unknown>) => {
    const d = raw();
    Object.assign(d.goldEvidence[0], patch);
    return checkDatasetAgainstCorpus(parseEvalDataset(d), corpus).join("\n");
  };
  assert.match(withGold({ sourceKey: "no-such-source" }), /unknown source/);
  assert.match(withGold({ anchors: ["a sentence the corpus never contains"] }), /no chunk/);
  // "Agnipath Scheme" is in both chunks of the new-regime deductions section (the split falls between the heading line and its body).
  const ambiguous = withGold({ sourceKey: "itd-efiling-salaried-individuals-ay-2026-27", heading: "Deductions available under the New Tax Regime (Section 115BAC)", anchors: ["Agnipath Scheme"] });
  assert.match(ambiguous, /more than one chunk/);
});
