// Runs an evaluation dataset through retrieval and scores it. Retrieval is injected (`EvalDeps`), so the same code runs
// against the real database (rag-eval CLI, DB-backed tests) and against fakes (pure tests).
//
// The result is plain JSON with no timestamp, so two runs over the same dataset and corpus serialise identically.
import { canonicalJson, sha256Text } from "../rag/corpus";
import type { Corpus } from "../rag/corpus";
import type { TaxRetrievalResult } from "../../services/tax-retrieval";
import { aggregate } from "./aggregate";
import type { MetricBlock } from "./aggregate";
import type { EvalDataset, Split } from "./dataset";
import { scoreCase } from "./score";
import type { CaseScore, ChunkInfo, HardFailureKind, RunOutcome, Failure } from "./score";

export type EvalDeps = {
  /** Lexical retrieval for one question. */
  retrieve(input: { question: string; assessmentYear: string }): Promise<TaxRetrievalResult>;
  /** The stored passages behind returned chunk ids, so quotes can be checked against them. */
  lookupChunks(chunkIds: string[]): Promise<Map<string, ChunkInfo>>;
};

export type RunOptions = {
  /** Which split to run. Tune against "dev"; "test" is for looking, not for tuning. Default: both. */
  split?: Split | "all";
};

export type SplitMetrics = { dev: MetricBlock; test: MetricBlock };

export type EvalResult = {
  schemaVersion: 1;
  dataset: {
    version: string;
    sha256: string;
    /** Cases in the dataset, whatever was run. */
    caseCount: number;
    /** Which split this run covered. */
    ran: Split | "all";
    provisionalCaseCount: number;
    goldCaseCount: number;
  };
  corpus: { version: string; manifestSha256: string };
  metrics: {
    /** Gold (reviewed) cases only. This is the primary score. */
    primary: MetricBlock;
    bySplit: SplitMetrics;
    byCategory: Record<string, MetricBlock>;
    /** Provisional / tax-professional-review cases: reported on their own, never mixed into `primary`. */
    provisional: MetricBlock;
    provisionalBySplit: SplitMetrics;
  };
  /** Every hard safety failure, across all cases, provisional included. */
  hardFailures: Array<{ id: string; split: Split; review: "gold" | "provisional"; kind: HardFailureKind; detail: string }>;
  cases: CaseScore[];
};

export async function runEvaluation(dataset: EvalDataset, corpus: Corpus, deps: EvalDeps, options: RunOptions = {}): Promise<EvalResult> {
  const ran = options.split ?? "all";
  const gold = new Map(dataset.goldEvidence.map((g) => [g.id, g]));
  const selected = dataset.cases.filter((c) => ran === "all" || c.split === ran);

  const scores: CaseScore[] = [];
  for (const c of selected) {
    let outcome: RunOutcome;
    try {
      outcome = { kind: "result", result: await deps.retrieve({ question: c.question, assessmentYear: c.assessmentYear }) };
    } catch (error) {
      outcome = { kind: "error", message: error instanceof Error ? error.message : "retrieval failed" };
    }
    const chunkIds = outcome.kind === "result" && outcome.result.status === "ok" ? outcome.result.evidence.map((e) => e.chunkId) : [];
    scores.push(scoreCase(c, outcome, gold, chunkIds.length > 0 ? await deps.lookupChunks(chunkIds) : new Map()));
  }

  const primary = scores.filter((s) => s.reviewStatus === "gold");
  const provisional = scores.filter((s) => s.reviewStatus === "provisional");
  const bySplit = (list: CaseScore[]): SplitMetrics => ({
    dev: aggregate(list.filter((s) => s.split === "dev")),
    test: aggregate(list.filter((s) => s.split === "test")),
  });
  const categories = [...new Set(primary.map((s) => s.category))].sort();

  return {
    schemaVersion: 1,
    dataset: {
      version: dataset.meta.datasetVersion,
      sha256: sha256Text(canonicalJson({ meta: dataset.meta, goldEvidence: dataset.goldEvidence, cases: dataset.cases })),
      caseCount: dataset.cases.length,
      ran,
      provisionalCaseCount: dataset.cases.filter((c) => c.review.status === "provisional").length,
      goldCaseCount: dataset.cases.filter((c) => c.review.status === "gold").length,
    },
    corpus: { version: corpus.version, manifestSha256: corpus.manifestSha256 },
    metrics: {
      primary: aggregate(primary),
      bySplit: bySplit(primary),
      byCategory: Object.fromEntries(categories.map((category) => [category, aggregate(primary.filter((s) => s.category === category))])),
      provisional: aggregate(provisional),
      provisionalBySplit: bySplit(provisional),
    },
    hardFailures: scores.flatMap((s) =>
      s.failures.filter((f): f is Failure & { kind: HardFailureKind } => f.hard).map((f) => ({ id: s.id, split: s.split, review: s.reviewStatus, kind: f.kind, detail: f.detail })),
    ),
    cases: scores,
  };
}
