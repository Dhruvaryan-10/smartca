// Turns case scores into metrics. PURE.
//
// Every proportion is `k of n` with a Wilson interval (see stats.ts). There is deliberately NO single "accuracy"
// number: the metrics measure different things, on different subsets, and a blend would hide which one moved.
//
// What each metric counts:
//   recall@k               pooled over the gold REQUIREMENTS of answer cases: k of n requirements found in the top k.
//   full-case recall@k     answer cases where EVERY requirement was found in the top k.
//   MRR                    mean reciprocal rank of the first gold passage, over answer cases (0 when none was found).
//   quote support          of the requirements that WERE retrieved, how many quotes contain the gold anchor text.
//   false-insufficient     answer cases that retrieval called insufficient.
//   false-ok               cases whose corpus has no support (retrieval expectation insufficient_evidence) that got evidence.
//   typed-reason accuracy  cases with an expected typed reason where retrieval was insufficient AND gave that reason.
//   distractor intrusion   cases with a distractor passage where one appeared at rank 1 / in the top 3 / anywhere in the 5.
//   section-resolution     named sections resolved with the expected basis, target and clause coverage.
// route_to_engine and refuse_out_of_scope cases contribute to none of these: only to the hard-failure counts.
import { EXPECTED_BEHAVIORS } from "./dataset";
import type { ExpectedBehavior } from "./dataset";
import { HARD_FAILURE_KINDS } from "./score";
import type { CaseScore, HardFailureKind } from "./score";
import { mean, wilson } from "./stats";
import type { Rate } from "./stats";

type AtK = Record<1 | 3 | 5, Rate>;

export type MetricBlock = {
  cases: number;
  byBehavior: Record<ExpectedBehavior, number>;
  /** Cases whose retrieval status is not asserted (safety checks only). */
  safetyOnlyCases: number;
  recallAt: AtK;
  fullCaseRecallAt: AtK;
  mrr: { mean: number | null; n: number };
  quoteSupport: Rate;
  falseInsufficient: Rate;
  falseOk: Rate;
  typedReasonAccuracy: Rate;
  distractorIntrusion: { at1: Rate; at3: Rate; at5: Rate };
  sectionResolutionAccuracy: Rate;
  casesWithFailures: number;
  casesWithHardFailures: number;
  /** Cases showing each hard failure. */
  hardFailures: Record<HardFailureKind, number>;
};

const count = <T>(items: T[], predicate: (item: T) => boolean) => items.filter(predicate).length;

export function aggregate(scores: CaseScore[]): MetricBlock {
  const answers = scores.filter((s) => s.expectedBehavior === "answer");
  const requirements = answers.flatMap((s) => s.requirements);
  const retrieved = requirements.filter((r) => r.rank !== null);

  const atK = (pick: (k: number) => Rate): AtK => ({ 1: pick(1), 3: pick(3), 5: pick(5) });
  const decided = (field: "falseInsufficient" | "falseOk" | "reasonCorrect") => scores.map((s) => s[field]).filter((v): v is boolean => v !== null);
  const rate = (values: boolean[]) => wilson(count(values, Boolean), values.length);
  const distractors = scores.map((s) => s.distractor).filter((d): d is NonNullable<CaseScore["distractor"]> => d !== null);
  const resolutions = scores.flatMap((s) => s.sectionResolutions);
  const hardCounts = Object.fromEntries(HARD_FAILURE_KINDS.map((kind) => [kind, count(scores, (s) => s.failures.some((f) => f.hard && f.kind === kind))])) as Record<HardFailureKind, number>;

  return {
    cases: scores.length,
    byBehavior: Object.fromEntries(EXPECTED_BEHAVIORS.map((b) => [b, count(scores, (s) => s.expectedBehavior === b)])) as Record<ExpectedBehavior, number>,
    safetyOnlyCases: count(scores, (s) => s.retrievalExpectation === "not_asserted"),
    recallAt: atK((k) => wilson(count(requirements, (r) => r.rank !== null && r.rank <= k), requirements.length)),
    fullCaseRecallAt: atK((k) => wilson(count(answers, (s) => s.requirements.every((r) => r.rank !== null && r.rank <= k)), answers.length)),
    mrr: { mean: mean(answers.map((s) => s.reciprocalRank ?? 0)), n: answers.length },
    quoteSupport: wilson(count(retrieved, (r) => r.quoteSupported === true), retrieved.length),
    falseInsufficient: rate(decided("falseInsufficient")),
    falseOk: rate(decided("falseOk")),
    typedReasonAccuracy: rate(decided("reasonCorrect")),
    distractorIntrusion: {
      at1: wilson(count(distractors, (d) => d.at1), distractors.length),
      at3: wilson(count(distractors, (d) => d.at3), distractors.length),
      at5: wilson(count(distractors, (d) => d.at5), distractors.length),
    },
    sectionResolutionAccuracy: wilson(count(resolutions, (r) => r.correct), resolutions.length),
    casesWithFailures: count(scores, (s) => s.failures.length > 0),
    casesWithHardFailures: count(scores, (s) => s.failures.some((f) => f.hard)),
    hardFailures: hardCounts,
  };
}
