// Scores ONE evaluation case against what retrieval returned. PURE: no database, no file system.
//
// The scorer never decides what is right; the dataset does. It compares what retrieval returned with the case's gold
// evidence (matched by source key, heading and anchor text, never by id), its expected retrieval status and reasons,
// and its expected section resolutions, and it checks the hard safety properties.
//
// For route_to_engine and refuse_out_of_scope cases retrieval cannot prove the final behaviour, so ONLY the safety
// properties are checked for them. Cases whose retrieval expectation is `not_asserted` (partial-support cases too) are
// checked for safety and for distractors, never for a right or wrong status.
import { normalizeSectionRef } from "../rag/corpus";
import type { EvalCase, ExpectedBehavior, GoldEvidence, ExpectedResolution, ReviewPriority, RetrievalStatusExpectation, Split } from "./dataset";
import { chunkMatchesGold } from "./dataset";
import type { InsufficientReason, SectionResolution, TaxEvidence, TaxRetrievalResult } from "../../services/tax-retrieval";

/** A stored passage, looked up by the chunk id retrieval returned. Only the harness reads it; evidence carries no heading or text. */
export type ChunkInfo = { sourceKey: string; headingPath: string[]; chunkIndex: number; text: string };

export type RunOutcome = { kind: "result"; result: TaxRetrievalResult } | { kind: "error"; message: string };

// The safety properties. Each is a hard failure, reported explicitly wherever it occurs (provisional cases included).
export const HARD_FAILURE_KINDS = [
  "wrong_assessment_year_evidence",
  "non_verbatim_quote",
  "forbidden_authority_tier_evidence",
  "higher_tier_claim_supported_only_by_guidance",
  "answerable_case_unsupported_by_section_resolution",
  "engine_required_numeric_answer_from_evidence",
] as const;
export type HardFailureKind = (typeof HARD_FAILURE_KINDS)[number];

export const SOFT_FAILURE_KINDS = [
  "gold_not_retrieved",
  "quote_does_not_support_gold",
  "false_insufficient",
  "false_ok",
  "wrong_reason",
  "distractor_in_top3",
  "section_resolution_mismatch",
  "retrieval_error",
] as const;
export type SoftFailureKind = (typeof SOFT_FAILURE_KINDS)[number];

export type Failure = { kind: HardFailureKind | SoftFailureKind; hard: boolean; detail: string };

export type EvidenceView = {
  rank: number;
  sourceKey: string;
  heading: string | null;
  chunkIndex: number | null;
  sectionRef: string | null;
  authorityTier: string;
  verificationStatus: string;
  assessmentYear: string;
  score: number;
  quote: string;
  /** Gold definitions (of this case) whose passage this evidence is. */
  matchesGold: string[];
};

export type RequirementScore = { index: number; anyOf: string[]; satisfiedBy: string | null; rank: number | null; quoteSupported: boolean | null };
export type ResolutionScore = { requested: string; expected: ExpectedResolution; actual: { basis: string; resolvedTo: string; clauseCovered: boolean } | null; correct: boolean };

export type CaseScore = {
  id: string;
  category: string;
  question: string;
  split: Split;
  reviewStatus: "gold" | "provisional";
  reviewPriority: ReviewPriority | null;
  expectedBehavior: ExpectedBehavior;
  engineRequired: boolean;
  retrievalExpectation: RetrievalStatusExpectation;
  actual: {
    status: "ok" | "insufficient_evidence" | "error";
    reason: string | null;
    corpusVersion: string | null;
    evidence: EvidenceView[];
    unmatchedSectionRefs: string[];
    resolutions: SectionResolution[];
    /** Phase 5C safe state: the question named a year other than the one requested, and retrieval refused. */
    yearMismatch: { requested: string; stated: string[] } | null;
    /** Phase 5C safe state: the claim needed statute or a circular the corpus does not hold, and retrieval refused. */
    authorityTier: { required: string[]; available: string[] } | null;
    error: string | null;
  };
  requirements: RequirementScore[];
  firstGoldRank: number | null;
  reciprocalRank: number | null;
  falseInsufficient: boolean | null;
  falseOk: boolean | null;
  reasonCorrect: boolean | null;
  distractor: { at1: boolean; at3: boolean; at5: boolean; ids: string[] } | null;
  sectionResolutions: ResolutionScore[];
  failures: Failure[];
};

/** What retrieval is allowed to put in a result: evidence and its provenance. Anything else could be an answer or an amount. */
const OK_RESULT_KEYS = ["status", "assessmentYear", "corpusVersion", "evidence", "unmatchedSectionRefs", "sectionResolutions"];
const INSUFFICIENT_RESULT_KEYS = ["status", "reason", "assessmentYear", "corpusVersion", "sectionRefs", "yearMismatch", "authorityTier"];
const EVIDENCE_KEYS = [
  "evidenceId", "chunkId", "sourceKey", "title", "publisher", "url", "authorityTier", "sectionRef", "quote", "assessmentYear",
  "effectiveFrom", "retrievedAt", "corpusVersion", "verificationStatus", "score",
];
/** The retrieval contract's limit on a quote. */
const MAX_QUOTE_CHARS = 400;

const TOP = 3;

function unexpectedFields(result: TaxRetrievalResult): string[] {
  const stray = Object.keys(result).filter((k) => !(result.status === "ok" ? OK_RESULT_KEYS : INSUFFICIENT_RESULT_KEYS).includes(k));
  if (result.status === "ok") for (const e of result.evidence) stray.push(...Object.keys(e).filter((k) => !EVIDENCE_KEYS.includes(k)).map((k) => `evidence.${k}`));
  return [...new Set(stray)];
}

export function scoreCase(
  c: EvalCase,
  outcome: RunOutcome,
  gold: ReadonlyMap<string, GoldEvidence>,
  chunks: ReadonlyMap<string, ChunkInfo>,
): CaseScore {
  const failures: Failure[] = [];
  const soft = (kind: SoftFailureKind, detail: string) => failures.push({ kind, hard: false, detail });
  const hard = (kind: HardFailureKind, detail: string) => failures.push({ kind, hard: true, detail });

  const result = outcome.kind === "result" ? outcome.result : null;
  const status: CaseScore["actual"]["status"] = result === null ? "error" : result.status;
  const evidence: TaxEvidence[] = result?.status === "ok" ? result.evidence : [];
  const reason = result?.status === "insufficient_evidence" ? result.reason : null;

  const behavior = c.expectedBehavior;
  const retrievalScored = behavior === "answer" || behavior === "insufficient_evidence";

  // Which of this case's gold passages each returned evidence is.
  const caseGold = [...new Set([...c.expectedEvidence.flatMap((r) => r.anyOf), ...c.contextEvidence, ...c.distractorEvidence])]
    .map((id) => gold.get(id))
    .filter((g): g is GoldEvidence => g !== undefined);
  const chunkOf = (e: TaxEvidence) => chunks.get(e.chunkId) ?? null;
  const goldMatches = (e: TaxEvidence): GoldEvidence[] => {
    const chunk = chunkOf(e);
    return chunk === null ? [] : caseGold.filter((g) => chunkMatchesGold(g, chunk));
  };
  const views: EvidenceView[] = evidence.map((e, i) => {
    const chunk = chunkOf(e);
    return {
      rank: i + 1,
      sourceKey: e.sourceKey,
      heading: chunk ? (chunk.headingPath[chunk.headingPath.length - 1] ?? null) : null,
      chunkIndex: chunk ? chunk.chunkIndex : null,
      sectionRef: e.sectionRef,
      authorityTier: e.authorityTier,
      verificationStatus: e.verificationStatus,
      assessmentYear: e.assessmentYear,
      score: e.score,
      quote: e.quote,
      matchesGold: goldMatches(e).map((g) => g.id),
    };
  });

  if (outcome.kind === "error") soft("retrieval_error", `retrieval threw: ${outcome.message}`);

  // --- gold recall, reciprocal rank and quote support (answer cases) -----------------------------------
  const requirements: RequirementScore[] = [];
  let firstGoldRank: number | null = null;
  let reciprocalRank: number | null = null;
  if (behavior === "answer") {
    c.expectedEvidence.forEach((requirement, index) => {
      let found: RequirementScore = { index, anyOf: requirement.anyOf, satisfiedBy: null, rank: null, quoteSupported: null };
      for (const [i, e] of evidence.entries()) {
        const hit = requirement.anyOf.map((id) => gold.get(id)).find((g): g is GoldEvidence => g !== undefined && goldMatches(e).some((m) => m.id === g.id));
        if (hit) {
          found = { index, anyOf: requirement.anyOf, satisfiedBy: hit.id, rank: i + 1, quoteSupported: hit.anchors.every((a) => e.quote.includes(a)) };
          break;
        }
      }
      requirements.push(found);
    });
    const ranks = requirements.map((r) => r.rank).filter((r): r is number => r !== null);
    firstGoldRank = ranks.length > 0 ? Math.min(...ranks) : null;
    reciprocalRank = firstGoldRank === null ? 0 : Math.round((1 / firstGoldRank) * 10000) / 10000;

    const missing = requirements.filter((r) => r.rank === null);
    if (missing.length > 0) soft("gold_not_retrieved", `missing: ${missing.map((r) => r.anyOf.join(" | ")).join("; ")}`);
    const unsupported = requirements.filter((r) => r.quoteSupported === false);
    if (unsupported.length > 0) soft("quote_does_not_support_gold", `quote at rank ${unsupported.map((r) => r.rank).join(", ")} lacks the anchor of ${unsupported.map((r) => r.satisfiedBy).join(", ")}`);
  }

  // --- status expectations -----------------------------------------------------------------------------
  const falseInsufficient = behavior === "answer" && status !== "error" ? status === "insufficient_evidence" : null;
  if (falseInsufficient) soft("false_insufficient", `the corpus can answer this, but retrieval returned insufficient_evidence (${reason})`);

  const expectsInsufficient = c.retrieval.expectation === "insufficient_evidence";
  const falseOk = expectsInsufficient && status !== "error" ? status === "ok" : null;
  if (falseOk) soft("false_ok", `the corpus does not support this, but retrieval returned ${evidence.length} evidence item(s)`);

  let reasonCorrect: boolean | null = null;
  if (c.retrieval.reasons && status !== "error") {
    reasonCorrect = status === "insufficient_evidence" && c.retrieval.reasons.includes(reason as InsufficientReason);
    if (status === "insufficient_evidence" && !reasonCorrect) soft("wrong_reason", `expected ${c.retrieval.reasons.join(" or ")}, got ${reason}`);
  }

  // --- distractors -------------------------------------------------------------------------------------
  let distractor: CaseScore["distractor"] = null;
  if (retrievalScored && c.distractorEvidence.length > 0) {
    const hits = views.filter((v) => v.matchesGold.some((id) => c.distractorEvidence.includes(id)));
    distractor = {
      at1: hits.some((v) => v.rank <= 1),
      at3: hits.some((v) => v.rank <= TOP),
      at5: hits.length > 0,
      ids: [...new Set(hits.flatMap((v) => v.matchesGold.filter((id) => c.distractorEvidence.includes(id))))].sort(),
    };
    if (distractor.at3) soft("distractor_in_top3", `distractor evidence in the top ${TOP}: ${distractor.ids.join(", ")}`);
  }

  // --- section resolution ------------------------------------------------------------------------------
  const sectionResolutions: ResolutionScore[] = c.expectedSectionResolutions.map((expected) => {
    const requested = normalizeSectionRef(expected.requested) ?? expected.requested;
    const found = result?.status === "ok" ? result.sectionResolutions.find((r) => r.requested === requested) : undefined;
    const actual = found ? { basis: found.basis, resolvedTo: found.resolvedTo, clauseCovered: found.clauseCovered } : null;
    const correct = actual !== null && actual.basis === expected.basis && actual.resolvedTo === (normalizeSectionRef(expected.resolvedTo) ?? expected.resolvedTo) && actual.clauseCovered === expected.clauseCovered;
    return { requested, expected, actual, correct };
  });
  const wrongResolutions = sectionResolutions.filter((r) => !r.correct);
  if (wrongResolutions.length > 0) {
    soft(
      "section_resolution_mismatch",
      wrongResolutions.map((r) => `${r.requested}: expected ${r.expected.basis}/${r.expected.resolvedTo}/clauseCovered=${r.expected.clauseCovered}, got ${r.actual ? `${r.actual.basis}/${r.actual.resolvedTo}/clauseCovered=${r.actual.clauseCovered}` : `no resolution (${status === "ok" ? "not resolved" : (reason ?? status)})`}`).join("; "),
    );
  }

  // --- hard safety failures (every behaviour) ----------------------------------------------------------
  const wrongYear = evidence.filter((e) => e.assessmentYear !== c.assessmentYear || (c.questionAssessmentYears !== undefined && !c.questionAssessmentYears.includes(e.assessmentYear)));
  if (wrongYear.length > 0) {
    const about = c.questionAssessmentYears ? `the question is about AY ${c.questionAssessmentYears.join(", ")}` : `AY ${c.assessmentYear} was asked for`;
    hard("wrong_assessment_year_evidence", `${about}, but evidence is for AY ${[...new Set(wrongYear.map((e) => e.assessmentYear))].join(", ")}`);
  }

  const badQuotes: string[] = [];
  evidence.forEach((e, i) => {
    const chunk = chunkOf(e);
    if (chunk === null) badQuotes.push(`#${i + 1}: its passage could not be found, so the quote cannot be verified`);
    else if (chunk.sourceKey !== e.sourceKey) badQuotes.push(`#${i + 1}: names source ${e.sourceKey} but the passage belongs to ${chunk.sourceKey}`);
    else if (e.quote.trim() === "" || e.quote.length > MAX_QUOTE_CHARS) badQuotes.push(`#${i + 1}: quote is empty or longer than ${MAX_QUOTE_CHARS} characters`);
    else if (!chunk.text.includes(e.quote)) badQuotes.push(`#${i + 1}: quote is not a verbatim slice of its stored passage`);
  });
  if (badQuotes.length > 0) hard("non_verbatim_quote", badQuotes.join("; "));

  const forbidden = evidence.filter((e) => c.forbiddenAuthorityTiers.includes(e.authorityTier));
  if (forbidden.length > 0) hard("forbidden_authority_tier_evidence", `evidence from a forbidden tier: ${[...new Set(forbidden.map((e) => e.authorityTier))].join(", ")}`);

  if (c.requiredAuthorityTiers.length > 0 && status === "ok" && !evidence.some((e) => c.requiredAuthorityTiers.includes(e.authorityTier))) {
    hard(
      "higher_tier_claim_supported_only_by_guidance",
      `the claim needs ${c.requiredAuthorityTiers.join(" or ")}, but the evidence returned is only ${[...new Set(evidence.map((e) => e.authorityTier))].join(", ")}`,
    );
  }

  if (behavior === "answer" && reason === "section_not_in_corpus") {
    hard("answerable_case_unsupported_by_section_resolution", "an answerable case was classed as unsupported because a named section was not resolved");
  }

  if (c.engineRequired && result !== null) {
    const stray = unexpectedFields(result);
    if (stray.length > 0) hard("engine_required_numeric_answer_from_evidence", `an engine-required case's retrieval result carries more than evidence: ${stray.join(", ")}`);
  }

  return {
    id: c.id,
    category: c.category,
    question: c.question,
    split: c.split,
    reviewStatus: c.review.status,
    reviewPriority: c.review.status === "provisional" ? c.review.priority : null,
    expectedBehavior: behavior,
    engineRequired: c.engineRequired,
    retrievalExpectation: c.retrieval.expectation,
    actual: {
      status,
      reason,
      corpusVersion: result === null ? null : result.corpusVersion,
      evidence: views,
      unmatchedSectionRefs: result?.status === "ok" ? result.unmatchedSectionRefs : [],
      resolutions: result?.status === "ok" ? result.sectionResolutions : [],
      yearMismatch: result?.status === "insufficient_evidence" ? (result.yearMismatch ?? null) : null,
      authorityTier: result?.status === "insufficient_evidence" ? (result.authorityTier ?? null) : null,
      error: outcome.kind === "error" ? outcome.message : null,
    },
    requirements,
    firstGoldRank,
    reciprocalRank,
    falseInsufficient,
    falseOk,
    reasonCorrect,
    distractor,
    sectionResolutions,
    failures,
  };
}
