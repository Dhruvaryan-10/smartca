// RAG evaluation harness: the runner, the report, and repeatability. The first tests use fake retrieval and need no
// database; the last ones run the real retrieval against the shipped corpus inside a transaction that is always rolled
// back (as every other retrieval test does), so they never depend on what is in the development database.
//
// Nothing here asserts a retrieval metric or a pass threshold: the baseline is recorded by `npm run rag:eval`, not
// pinned by a test.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCorpusFromDisk } from "../lib/rag/load-corpus";
import { loadEvalDataset } from "../lib/rag-eval/load-dataset";
import { runEvaluation } from "../lib/rag-eval/run";
import type { EvalDeps } from "../lib/rag-eval/run";
import { formatReport } from "../lib/rag-eval/report";
import type { TaxRetrievalResult } from "../services/tax-retrieval";

const dataset = loadEvalDataset();
const corpus = loadCorpusFromDisk();

/** Fake retrieval that records what it was asked, and finds nothing. */
function recordingDeps(): { deps: EvalDeps; asked: string[] } {
  const asked: string[] = [];
  const deps: EvalDeps = {
    retrieve: async ({ question, assessmentYear }) => {
      asked.push(question);
      const result: TaxRetrievalResult = { status: "insufficient_evidence", reason: "no_matching_passages", assessmentYear, corpusVersion: corpus.version, sectionRefs: [] };
      return result;
    },
    lookupChunks: async () => new Map(),
  };
  return { deps, asked };
}

test("a dev run never retrieves for a test case, and a test run never retrieves for a dev case", async () => {
  const devQuestions = new Set(dataset.cases.filter((c) => c.split === "dev").map((c) => c.question));
  const testQuestions = new Set(dataset.cases.filter((c) => c.split === "test").map((c) => c.question));

  const dev = recordingDeps();
  const devResult = await runEvaluation(dataset, corpus, dev.deps, { split: "dev" });
  assert.equal(dev.asked.length, 22);
  assert.ok(dev.asked.every((q) => devQuestions.has(q) && !testQuestions.has(q)));
  assert.equal(devResult.cases.length, 22);
  assert.ok(devResult.cases.every((c) => c.split === "dev"));

  const held = recordingDeps();
  const testResult = await runEvaluation(dataset, corpus, held.deps, { split: "test" });
  assert.equal(held.asked.length, 34);
  assert.ok(held.asked.every((q) => testQuestions.has(q)));
  assert.ok(testResult.cases.every((c) => c.split === "test"));
});

test("every case gets a result, in dataset order, and provisional cases are reported in their own block and not in the primary one", async () => {
  const { deps } = recordingDeps();
  const result = await runEvaluation(dataset, corpus, deps);
  assert.deepEqual(result.cases.map((c) => c.id), dataset.cases.map((c) => c.id));

  const provisional = dataset.cases.filter((c) => c.review.status === "provisional").length;
  assert.equal(result.metrics.provisional.cases, provisional);
  assert.equal(result.metrics.primary.cases, dataset.cases.length - provisional);
  assert.equal(result.metrics.primary.cases + result.metrics.provisional.cases, 56, "nothing is dropped");
  assert.equal(result.metrics.bySplit.dev.cases + result.metrics.bySplit.test.cases, result.metrics.primary.cases);

  // Categories partition the primary set.
  const perCategory = Object.values(result.metrics.byCategory).reduce((sum, m) => sum + m.cases, 0);
  assert.equal(perCategory, result.metrics.primary.cases);
});

test("the machine-readable result is plain JSON with no timestamp, and identifies the dataset and the corpus it ran against", async () => {
  const { deps } = recordingDeps();
  const result = await runEvaluation(dataset, corpus, deps);
  const json = JSON.stringify(result);
  assert.deepEqual(JSON.parse(json), result, "survives a JSON round trip unchanged");
  assert.doesNotMatch(json, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "no timestamp: two runs of the same thing serialise identically");
  assert.equal(result.dataset.version, dataset.meta.datasetVersion);
  assert.match(result.dataset.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.corpus.version, corpus.version);
  assert.equal(result.corpus.manifestSha256, corpus.manifestSha256);
});

test("the report shows every section the brief asks for, never a single headline accuracy, and lists every failure with its detail", async () => {
  const { deps } = recordingDeps();
  const result = await runEvaluation(dataset, corpus, deps);
  const report = formatReport(result);

  for (const heading of ["OVERALL", "BY CATEGORY", "DEV VS TEST", "PROVISIONAL", "HARD SAFETY", "FAILURES"]) assert.match(report, new RegExp(heading), heading);
  for (const metric of ["recall@1", "recall@3", "recall@5", "MRR", "quote support", "false-insufficient", "false-ok", "typed-reason", "distractor intrusion", "section-resolution"]) {
    assert.match(report, new RegExp(metric, "i"), metric);
  }
  assert.doesNotMatch(report, /\baccuracy\s*[:=]\s*\d/i, "no single accuracy figure");
  // Phase 5C: the two safe refusals are counted where the hard failures are, so a change in either is visible.
  assert.match(report, /assessment-year mismatch refusals: 0 case\(s\)/);
  assert.match(report, /required-authority-tier refusals: 0 case\(s\)/);
  assert.match(report, /Wilson/);

  // Every failing case appears, with what the brief asks for.
  const failing = result.cases.filter((c) => c.failures.length > 0);
  assert.ok(failing.length > 0, "the fake retrieval finds nothing, so answer cases fail");
  for (const c of failing) assert.ok(report.includes(c.id) && report.includes(c.question), `${c.id} is listed with its question`);
  for (const label of ["expected behavior", "retrieval status", "reason", "evidence", "missing"]) assert.match(report, new RegExp(label, "i"), label);
  assert.match(report, /provisional/i);
});

test("a case that fails only because retrieval threw is reported, and the run carries on", async () => {
  const deps: EvalDeps = { retrieve: async () => { throw new Error("connection lost"); }, lookupChunks: async () => new Map() };
  const result = await runEvaluation(dataset, corpus, deps, { split: "dev" });
  assert.equal(result.cases.length, 22);
  assert.ok(result.cases.every((c) => c.actual.status === "error" && c.failures.some((f) => f.kind === "retrieval_error")));
});

// --- against the real retrieval, in a rolled-back transaction -----------------------------

test("against the shipped corpus: every case is answered, results are identical on repeated runs, and safety checks hold on real quotes", async () => {
  const { inRolledBackTransaction } = await import("./helpers-rag");
  const { ingestTaxCorpus } = await import("../services/tax-corpus");
  const { makeDbDeps, checkDatabaseMatchesCorpus } = await import("../lib/rag-eval/db-deps");

  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(corpus, tx);
    assert.deepEqual(await checkDatabaseMatchesCorpus(tx, corpus), [], "the preflight agrees with a freshly ingested corpus");

    const deps = makeDbDeps(tx);
    const first = await runEvaluation(dataset, corpus, deps);
    const second = await runEvaluation(dataset, corpus, deps);
    assert.deepEqual(first, second, "stable across repeated runs");
    assert.equal(formatReport(first), formatReport(second));

    assert.equal(first.cases.length, 56);
    assert.ok(first.cases.every((c) => c.actual.status === "ok" || c.actual.status === "insufficient_evidence"), "no case errored");
    assert.equal(first.corpus.version, corpus.version);
    assert.ok(first.cases.every((c) => c.actual.corpusVersion === corpus.version));

    // The retrieval layer's own contract, seen through the harness: quotes are verbatim, years are honest.
    const verbatim = first.cases.flatMap((c) => c.failures).filter((f) => f.kind === "non_verbatim_quote");
    assert.deepEqual(verbatim, [], "no fabricated or non-verbatim quote");
    assert.ok(first.cases.some((c) => c.actual.evidence.length > 0), "the harness saw real evidence");
  });
});

test("Phase 5C, on the real dataset: a wrong-year question and a statute demand are refused safely, and explicit matching years are untouched", async () => {
  const { inRolledBackTransaction } = await import("./helpers-rag");
  const { ingestTaxCorpus } = await import("../services/tax-corpus");
  const { makeDbDeps } = await import("../lib/rag-eval/db-deps");

  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(corpus, tx);
    const result = await runEvaluation(dataset, corpus, makeDbDeps(tx));
    const byId = new Map(result.cases.map((c) => [c.id, c]));
    const get = (id: string) => byId.get(id)!;

    // Year: AY 2024-25 (ayi-02) and FY 2026-27 = AY 2027-28 (ayi-03), both asked with the year 2026-27.
    for (const [id, stated] of [["ayi-02", ["2024-25"]], ["ayi-03", ["2027-28"]]] as const) {
      const c = get(id);
      assert.equal(c.actual.status, "insufficient_evidence", id);
      assert.equal(c.actual.reason, "no_corpus_for_assessment_year", id);
      assert.deepEqual(c.actual.yearMismatch, { requested: "2026-27", stated: [...stated] }, id);
      assert.deepEqual(c.actual.evidence, [], `${id}: no evidence rides along`);
      assert.deepEqual(c.failures, [], `${id}: the refusal is the expected behaviour and its label's reason`);
    }

    // Tier: "the exact wording of Section 87A from the Act" needs statute, which the corpus does not hold.
    const ins04 = get("ins-04");
    assert.equal(ins04.actual.status, "insufficient_evidence");
    assert.equal(ins04.actual.reason, "required_authority_tier_unavailable");
    assert.deepEqual(ins04.actual.authorityTier, { required: ["statute"], available: ["official_guidance"] });
    assert.deepEqual(ins04.actual.evidence, []);
    assert.equal(ins04.failures.some((f) => f.hard), false, "no hard failure");
    // Its frozen label predates the new reason (it lists no_matching_passages), so it still counts as a wrong reason. Not edited.
    assert.deepEqual(ins04.failures.map((f) => f.kind), ["wrong_reason"]);

    // Explicit years that MATCH the year requested are not refused: ins-01 (AY 2026-27), sen-02 (FY 2025-26 = AY 2026-27), eng-04 (AY 2025-26, asked for 2025-26).
    for (const id of ["ins-01", "sen-02", "eng-04"]) assert.equal(get(id).actual.yearMismatch, null, id);
    assert.equal(get("eng-04").actual.reason, "no_corpus_for_assessment_year", "eng-04 is refused because the corpus has no AY 2025-26, exactly as before");

    // Only the two named safety classes are touched: nothing else carries a safety state.
    assert.deepEqual(result.cases.filter((c) => c.actual.yearMismatch !== null).map((c) => c.id).sort(), ["ayi-02", "ayi-03"]);
    assert.deepEqual(result.cases.filter((c) => c.actual.authorityTier !== null).map((c) => c.id), ["ins-04"]);

    // The hard failures that remain: none for the year, and for the tier only the case whose QUESTION does not say what it needs.
    assert.deepEqual(result.hardFailures.filter((f) => f.kind === "wrong_assessment_year_evidence"), []);
    assert.deepEqual(result.hardFailures.map((f) => [f.id, f.kind]), [["ins-03", "higher_tier_claim_supported_only_by_guidance"]]);
  });
});

test("the preflight refuses a database whose corpus differs from the shipped one", async () => {
  const { inRolledBackTransaction } = await import("./helpers-rag");
  const { checkDatabaseMatchesCorpus } = await import("../lib/rag-eval/db-deps");
  await inRolledBackTransaction(async (tx) => {
    // Nothing ingested in this transaction beyond what the development database holds: alter the shipped corpus instead.
    const altered = structuredClone(corpus);
    altered.sources[0].chunks[0] = { ...altered.sources[0].chunks[0], textSha256: "0".repeat(64) };
    const { ingestTaxCorpus } = await import("../services/tax-corpus");
    await ingestTaxCorpus(corpus, tx);
    const issues = await checkDatabaseMatchesCorpus(tx, altered);
    assert.ok(issues.length > 0 && issues.some((i) => /chunk/i.test(i)), issues.join("; "));
  });
});
