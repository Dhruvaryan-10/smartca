// The RAG evaluation dataset: its shape, and the rules that keep it honest. PURE: no database, no file system.
//
// A dataset is three JSON files (rag-evals/<name>/): `meta.json` (version, split membership, the freeze on the test
// set), `gold-evidence.json` (what counts as the right passage) and `cases.json` (the questions). See
// rag-evals/README.md for what each field means and why.
//
// Gold evidence is identified by STABLE facts about the corpus (the source key, the heading a passage sits under, and
// verbatim anchor text inside it), never by a database chunk id or an evidence id, because those change whenever the
// corpus is re-ingested or re-versioned.
//
// Validation reports every problem at once, as the corpus validator does.
import { AUTHORITY_TIERS, canonicalJson, normalizeSectionRef, sha256Text } from "../rag/corpus";
import type { AuthorityTier, Corpus } from "../rag/corpus";
import type { SectionBasis } from "../rag/section-resolution";
import type { InsufficientReason } from "../../services/tax-retrieval";

// ---------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------

/** What the whole system should do with the question. Retrieval alone can decide only some of these. */
export const EXPECTED_BEHAVIORS = ["answer", "insufficient_evidence", "route_to_engine", "refuse_out_of_scope"] as const;
export type ExpectedBehavior = (typeof EXPECTED_BEHAVIORS)[number];

export const SPLITS = ["dev", "test"] as const;
export type Split = (typeof SPLITS)[number];

/**
 * What the retrieval layer, by itself, is expected to return.
 *   ok                    evidence (the corpus can answer).
 *   insufficient_evidence the corpus has nothing that supports the claim asked, so returning evidence is a false-ok.
 *   not_asserted          retrieval alone cannot decide: the case routes to the engine or is out of scope, or the corpus
 *                         holds only partial support so returning related guidance is legitimate. Only the safety
 *                         checks apply.
 */
export const RETRIEVAL_EXPECTATIONS = ["ok", "insufficient_evidence", "not_asserted"] as const;
export type RetrievalStatusExpectation = (typeof RETRIEVAL_EXPECTATIONS)[number];

/** Why a case is provisional. `must_review`/`low_priority` need a tax professional; `owner_decision` is a product decision. */
export const REVIEW_PRIORITIES = ["must_review", "low_priority", "owner_decision"] as const;
export type ReviewPriority = (typeof REVIEW_PRIORITIES)[number];

export const INSUFFICIENT_REASONS = [
  "corpus_not_loaded",
  "no_corpus_for_assessment_year",
  "assessment_year_mismatch",
  "required_authority_tier_unavailable",
  "no_searchable_terms",
  "section_not_in_corpus",
  "no_matching_passages",
] as const satisfies readonly InsufficientReason[];
export const SECTION_BASES = ["indexed", "cited_in_passage", "parent_section"] as const satisfies readonly SectionBasis[];

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type GoldEvidence = {
  id: string;
  description: string;
  sourceKey: string;
  /** The deepest heading above the passage. */
  heading: string;
  /** Verbatim text that must all be inside the passage; a returned quote "supports" the gold when it contains them all. */
  anchors: string[];
};

/** One thing the answer needs. It is met by ANY of the alternatives; a case with several requirements needs all of them. */
export type Requirement = { anyOf: string[] };

export type ExpectedResolution = { requested: string; basis: SectionBasis; resolvedTo: string; clauseCovered: boolean };

export type Review = { status: "gold" } | { status: "provisional"; priority: ReviewPriority; reason: string };

export type EvalCase = {
  id: string;
  category: string;
  question: string;
  /** The assessment year passed to retrieval. */
  assessmentYear: string;
  /** Years the question is actually about, when they differ from (or go beyond) `assessmentYear`. Evidence for any other year is wrong. */
  questionAssessmentYears?: string[];
  expectedBehavior: ExpectedBehavior;
  split: Split;
  review: Review;
  /** A figure in the answer must come from the deterministic tax engine, never from retrieved evidence. */
  engineRequired: boolean;
  retrieval: { expectation: RetrievalStatusExpectation; reasons?: InsufficientReason[] };
  /** Scored: answer cases only. */
  expectedEvidence: Requirement[];
  /** Passages the case cites as supporting an explanation or a partial answer. Validated against the corpus, NOT scored. */
  contextEvidence: string[];
  /** Passages that must not lead the results (a lexical false friend). */
  distractorEvidence: string[];
  /** Evidence of these tiers must never be returned for this case. */
  forbiddenAuthorityTiers: AuthorityTier[];
  /** The claim needs one of these tiers; guidance alone does not support it. */
  requiredAuthorityTiers: AuthorityTier[];
  expectedSectionResolutions: ExpectedResolution[];
  tags: string[];
  notes: string;
};

export type EvalMeta = {
  datasetVersion: string;
  corpusVersion: string;
  assessmentYear: string;
  description: string;
  provenance: string;
  splits: { dev: string[]; test: string[] };
  testFreeze: { fingerprintSha256: string; caseCount: number; frozenOn: string; rule: string };
};

export type EvalDataset = { meta: EvalMeta; goldEvidence: GoldEvidence[]; cases: EvalCase[] };

/** The files as parsed from JSON, before validation. */
export type RawEvalDataset = {
  meta: Record<string, unknown>;
  goldEvidence: Array<Record<string, unknown>>;
  cases: Array<Record<string, unknown>>;
};

export class EvalDatasetError extends Error {
  constructor(readonly issues: string[]) {
    super(`The RAG evaluation dataset is not valid:\n- ${issues.join("\n- ")}`);
    this.name = "EvalDatasetError";
  }
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const ASSESSMENT_YEAR = /^\d{4}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CASE_ID = /^[a-z][a-z0-9]{2}-\d{2}$/;
const GOLD_ID = /^[a-z0-9][a-z0-9.#-]*$/;
/** The retrieval service refuses a longer question. */
const MAX_QUESTION_LENGTH = 500;

const CASE_FIELDS = [
  "id", "category", "question", "assessmentYear", "questionAssessmentYears", "expectedBehavior", "split", "review", "engineRequired",
  "retrieval", "expectedEvidence", "contextEvidence", "distractorEvidence", "forbiddenAuthorityTiers", "requiredAuthorityTiers",
  "expectedSectionResolutions", "tags", "notes",
];

function unknownKeys(record: Record<string, unknown>, allowed: string[], where: string, issues: string[]) {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) issues.push(`${where}: unknown field "${key}".`);
}

/** Two questions are the same question if they differ only in case, spacing or punctuation. */
export const normalizeQuestion = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function tierList(value: unknown, field: string, where: string, issues: string[]): AuthorityTier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${where}: ${field} must be a list.`);
    return [];
  }
  const tiers: AuthorityTier[] = [];
  for (const tier of value) {
    if (oneOf(AUTHORITY_TIERS, tier)) tiers.push(tier);
    else issues.push(`${where}: ${field} contains unknown tier ${JSON.stringify(tier)}.`);
  }
  return tiers;
}

function parseGold(raw: unknown, index: number, issues: string[]): GoldEvidence | null {
  const where = `goldEvidence[${index}]`;
  if (!isRecord(raw)) {
    issues.push(`${where}: must be an object.`);
    return null;
  }
  unknownKeys(raw, ["id", "description", "sourceKey", "heading", "anchors"], where, issues);
  const before = issues.length;
  if (typeof raw.id !== "string" || !GOLD_ID.test(raw.id)) issues.push(`${where}: id must be lower-case letters, digits, "-", "." or "#".`);
  for (const field of ["description", "sourceKey", "heading"] as const) if (!isText(raw[field])) issues.push(`${where}: ${field} is required.`);
  if (!isStringList(raw.anchors) || raw.anchors.length === 0 || raw.anchors.some((a) => a.trim() === "" || a !== a.trim())) {
    issues.push(`${where}: anchors must be a non-empty list of trimmed, non-empty strings.`);
  }
  return issues.length > before ? null : (raw as unknown as GoldEvidence);
}

function parseCase(raw: unknown, index: number, goldIds: Set<string>, issues: string[]): EvalCase | null {
  if (!isRecord(raw)) {
    issues.push(`cases[${index}]: must be an object.`);
    return null;
  }
  const id = typeof raw.id === "string" ? raw.id : `cases[${index}]`;
  const problem = (message: string) => issues.push(`${id}: ${message}`);
  const before = issues.length;
  unknownKeys(raw, CASE_FIELDS, id, issues);

  if (typeof raw.id !== "string" || !CASE_ID.test(raw.id)) issues.push(`cases[${index}]: id must look like "slb-01".`);
  if (!isText(raw.category)) problem("category is required.");
  if (!isText(raw.question) || raw.question.length > MAX_QUESTION_LENGTH) problem(`question is required and at most ${MAX_QUESTION_LENGTH} characters.`);
  if (typeof raw.assessmentYear !== "string" || !ASSESSMENT_YEAR.test(raw.assessmentYear)) problem('assessmentYear must look like "2026-27".');
  if (raw.questionAssessmentYears !== undefined && !(isStringList(raw.questionAssessmentYears) && raw.questionAssessmentYears.length > 0 && raw.questionAssessmentYears.every((y) => ASSESSMENT_YEAR.test(y)))) {
    problem('questionAssessmentYears must be a non-empty list of years like "2026-27".');
  }
  if (!oneOf(EXPECTED_BEHAVIORS, raw.expectedBehavior)) problem(`expectedBehavior must be one of ${EXPECTED_BEHAVIORS.join(", ")}.`);
  if (!oneOf(SPLITS, raw.split)) problem('split must be "dev" or "test".');
  if (typeof raw.engineRequired !== "boolean") problem("engineRequired must be true or false.");
  if (!isText(raw.notes)) problem("notes is required: every case says why it belongs.");
  if (raw.tags !== undefined && !isStringList(raw.tags)) problem("tags must be a list of strings.");

  // Review.
  let review: Review = { status: "gold" };
  if (!isRecord(raw.review)) problem("review is required.");
  else if (raw.review.status === "gold") {
    unknownKeys(raw.review, ["status"], `${id}: review`, issues);
  } else if (raw.review.status === "provisional") {
    unknownKeys(raw.review, ["status", "priority", "reason"], `${id}: review`, issues);
    if (!oneOf(REVIEW_PRIORITIES, raw.review.priority)) problem(`review.priority must be one of ${REVIEW_PRIORITIES.join(", ")}.`);
    if (!isText(raw.review.reason)) problem("a provisional review needs a reason: say what has to be reviewed.");
    review = raw.review as unknown as Review;
  } else problem('review.status must be "gold" or "provisional".');

  // Retrieval expectation.
  let retrieval: EvalCase["retrieval"] = { expectation: "not_asserted" };
  if (!isRecord(raw.retrieval)) problem("retrieval is required.");
  else {
    unknownKeys(raw.retrieval, ["expectation", "reasons"], `${id}: retrieval`, issues);
    if (!oneOf(RETRIEVAL_EXPECTATIONS, raw.retrieval.expectation)) problem(`retrieval.expectation must be one of ${RETRIEVAL_EXPECTATIONS.join(", ")}.`);
    else retrieval = { expectation: raw.retrieval.expectation };
    if (raw.retrieval.reasons !== undefined) {
      const reasons = raw.retrieval.reasons;
      if (!Array.isArray(reasons) || reasons.length === 0 || !reasons.every((r) => oneOf(INSUFFICIENT_REASONS, r))) problem(`retrieval.reasons must be a non-empty list of ${INSUFFICIENT_REASONS.join(", ")}.`);
      else if (retrieval.expectation !== "insufficient_evidence") problem("retrieval.reasons applies only when the expected retrieval status is insufficient_evidence.");
      else retrieval.reasons = reasons as InsufficientReason[];
    }
  }

  // Evidence references.
  const requirements: Requirement[] = [];
  const expectedEvidence = raw.expectedEvidence ?? [];
  if (!Array.isArray(expectedEvidence)) problem("expectedEvidence must be a list.");
  else {
    for (const requirement of expectedEvidence) {
      if (!isRecord(requirement) || !isStringList(requirement.anyOf) || requirement.anyOf.length === 0) problem("each expectedEvidence entry must be { anyOf: [gold ids] }.");
      else {
        unknownKeys(requirement, ["anyOf"], `${id}: expectedEvidence`, issues);
        for (const ref of requirement.anyOf) if (!goldIds.has(ref)) problem(`unknown gold evidence "${ref}".`);
        requirements.push({ anyOf: requirement.anyOf });
      }
    }
  }
  const refList = (field: "contextEvidence" | "distractorEvidence"): string[] => {
    const value = raw[field] ?? [];
    if (!isStringList(value)) {
      problem(`${field} must be a list of gold evidence ids.`);
      return [];
    }
    for (const ref of value) if (!goldIds.has(ref)) problem(`unknown gold evidence "${ref}".`);
    return value;
  };
  const contextEvidence = refList("contextEvidence");
  const distractorEvidence = refList("distractorEvidence");

  const forbiddenAuthorityTiers = tierList(raw.forbiddenAuthorityTiers, "forbiddenAuthorityTiers", id, issues);
  if (raw.forbiddenAuthorityTiers === undefined) problem("forbiddenAuthorityTiers is required (an empty list if none).");
  const requiredAuthorityTiers = tierList(raw.requiredAuthorityTiers, "requiredAuthorityTiers", id, issues);

  // Section resolutions.
  const expectedSectionResolutions: ExpectedResolution[] = [];
  const resolutions = raw.expectedSectionResolutions ?? [];
  if (!Array.isArray(resolutions)) problem("expectedSectionResolutions must be a list.");
  else {
    resolutions.forEach((r, i) => {
      const at = `expectedSectionResolutions[${i}]`;
      if (!isRecord(r)) return problem(`${at} must be an object.`);
      unknownKeys(r, ["requested", "basis", "resolvedTo", "clauseCovered"], `${id}: ${at}`, issues);
      if (typeof r.requested !== "string" || normalizeSectionRef(r.requested) === null) problem(`${at}.requested ${JSON.stringify(r.requested)} is not a section reference.`);
      if (typeof r.resolvedTo !== "string" || normalizeSectionRef(r.resolvedTo) === null) problem(`${at}.resolvedTo ${JSON.stringify(r.resolvedTo)} is not a section reference.`);
      if (!oneOf(SECTION_BASES, r.basis)) problem(`${at}.basis must be one of ${SECTION_BASES.join(", ")}.`);
      if (typeof r.clauseCovered !== "boolean") problem(`${at}.clauseCovered must be true or false.`);
      expectedSectionResolutions.push(r as unknown as ExpectedResolution);
    });
  }

  // Behaviour, retrieval expectation and evidence must agree.
  const behavior = raw.expectedBehavior;
  if (behavior === "answer") {
    if (retrieval.expectation !== "ok") problem('retrieval.expectation must be "ok" for an answer case.');
    if (requirements.length === 0) problem("an answer case needs at least one expectedEvidence requirement.");
  } else {
    if (requirements.length > 0) problem("expectedEvidence must be empty unless the behaviour is answer: only answer cases carry scored gold evidence (use contextEvidence for the rest).");
  }
  if (behavior === "route_to_engine" || behavior === "refuse_out_of_scope") {
    if (retrieval.expectation !== "not_asserted") problem(`retrieval.expectation must be "not_asserted" for ${behavior} cases: retrieval cannot prove the final behaviour.`);
    if (expectedSectionResolutions.length > 0) problem(`expectedSectionResolutions must be empty for ${behavior} cases.`);
  }
  if (behavior === "route_to_engine" && raw.engineRequired !== true) problem("engineRequired must be true for route_to_engine cases.");
  if (behavior === "insufficient_evidence" && retrieval.expectation === "ok") problem('retrieval.expectation cannot be "ok" for an insufficient_evidence case.');
  if (retrieval.expectation === "insufficient_evidence" && expectedSectionResolutions.length > 0) problem("expectedSectionResolutions must be empty when retrieval is expected to return nothing.");
  for (const tier of requiredAuthorityTiers) if (forbiddenAuthorityTiers.includes(tier)) problem(`tier "${tier}" is both required and forbidden.`);
  if (behavior === "answer" && requiredAuthorityTiers.length > 0) problem("requiredAuthorityTiers on an answer case would make it unanswerable from guidance; use it on insufficient_evidence cases.");

  if (issues.length > before) return null;
  return {
    id: raw.id as string,
    category: raw.category as string,
    question: raw.question as string,
    assessmentYear: raw.assessmentYear as string,
    ...(raw.questionAssessmentYears === undefined ? {} : { questionAssessmentYears: raw.questionAssessmentYears as string[] }),
    expectedBehavior: behavior as ExpectedBehavior,
    split: raw.split as Split,
    review,
    engineRequired: raw.engineRequired as boolean,
    retrieval,
    expectedEvidence: requirements,
    contextEvidence,
    distractorEvidence,
    forbiddenAuthorityTiers,
    requiredAuthorityTiers,
    expectedSectionResolutions,
    tags: (raw.tags as string[] | undefined) ?? [],
    notes: raw.notes as string,
  };
}

function parseMeta(raw: unknown, issues: string[]): EvalMeta | null {
  if (!isRecord(raw)) {
    issues.push("meta: must be an object.");
    return null;
  }
  const before = issues.length;
  unknownKeys(raw, ["datasetVersion", "corpusVersion", "assessmentYear", "description", "provenance", "splits", "testFreeze"], "meta", issues);
  for (const field of ["datasetVersion", "corpusVersion", "description", "provenance"] as const) if (!isText(raw[field])) issues.push(`meta: ${field} is required.`);
  if (typeof raw.assessmentYear !== "string" || !ASSESSMENT_YEAR.test(raw.assessmentYear)) issues.push('meta: assessmentYear must look like "2026-27".');
  if (!isRecord(raw.splits) || !isStringList(raw.splits.dev) || !isStringList(raw.splits.test)) issues.push("meta: splits must be { dev: [ids], test: [ids] }.");
  else unknownKeys(raw.splits, ["dev", "test"], "meta.splits", issues);
  const freeze = raw.testFreeze;
  if (!isRecord(freeze) || typeof freeze.fingerprintSha256 !== "string" || !/^[0-9a-f]{64}$/.test(freeze.fingerprintSha256) || !Number.isInteger(freeze.caseCount) || typeof freeze.frozenOn !== "string" || !ISO_DATE.test(freeze.frozenOn) || !isText(freeze.rule)) {
    issues.push("meta: testFreeze must be { fingerprintSha256, caseCount, frozenOn, rule }.");
  } else unknownKeys(freeze, ["fingerprintSha256", "caseCount", "frozenOn", "rule"], "meta.testFreeze", issues);
  return issues.length > before ? null : (raw as unknown as EvalMeta);
}

/** Validates the three files and returns the dataset, or throws an EvalDatasetError listing every problem. */
export function parseEvalDataset(input: RawEvalDataset): EvalDataset {
  const issues: string[] = [];
  const meta = parseMeta(input.meta, issues);

  const goldEvidence: GoldEvidence[] = [];
  const goldIds = new Set<string>();
  if (!Array.isArray(input.goldEvidence)) issues.push("goldEvidence must be a list.");
  else {
    input.goldEvidence.forEach((raw, i) => {
      const gold = parseGold(raw, i, issues);
      if (!gold) return;
      if (goldIds.has(gold.id)) issues.push(`goldEvidence: duplicate id "${gold.id}".`);
      goldIds.add(gold.id);
      goldEvidence.push(gold);
    });
  }

  const cases: EvalCase[] = [];
  const seenIds = new Map<string, number>();
  const seenQuestions = new Map<string, string>();
  if (!Array.isArray(input.cases)) issues.push("cases must be a list.");
  else {
    input.cases.forEach((raw, i) => {
      const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : null;
      if (id !== null) {
        if (seenIds.has(id)) issues.push(`duplicate id "${id}".`);
        seenIds.set(id, i);
        const question = isRecord(raw) && typeof raw.question === "string" ? normalizeQuestion(raw.question) : null;
        if (question !== null) {
          const other = seenQuestions.get(question);
          if (other !== undefined) issues.push(`${id}: same question as ${other}.`);
          else seenQuestions.set(question, id);
        }
      }
      const parsed = parseCase(raw, i, goldIds, issues);
      if (parsed) cases.push(parsed);
    });
  }

  // Split membership: meta.splits and each case's `split` must agree, and every case must be in exactly one.
  if (meta) {
    const { dev, test } = meta.splits;
    for (const id of dev) if (test.includes(id)) issues.push(`case "${id}" is in both splits.`);
    for (const list of [dev, test]) if (new Set(list).size !== list.length) issues.push("meta.splits lists a case twice.");
    for (const c of cases) {
      const inDev = dev.includes(c.id);
      const inTest = test.includes(c.id);
      if (!inDev && !inTest) issues.push(`case "${c.id}" is not in any split.`);
      else if (inDev !== inTest && c.split !== (inDev ? "dev" : "test")) issues.push(`${c.id}: split "${c.split}" disagrees with meta.splits.`);
    }
    const ids = new Set(seenIds.keys());
    for (const id of [...dev, ...test]) if (!ids.has(id)) issues.push(`meta.splits names "${id}", which is not a case.`);
  }

  if (issues.length > 0 || !meta) throw new EvalDatasetError(issues);
  return { meta, goldEvidence, cases };
}

// ---------------------------------------------------------------------
// The freeze on the test set
// ---------------------------------------------------------------------

/**
 * A fingerprint of everything that DEFINES the test cases: each test case (except its free-text notes) and the gold
 * definitions those cases refer to. Dev cases are not part of it, because dev is what retrieval may be tuned against.
 * If this changes, the test set was edited; that needs a new dataset version, not an edit in place.
 */
export function testSetFingerprint(raw: RawEvalDataset): string {
  const without = (record: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
  const testCases = raw.cases
    .filter((c) => c.split === "test")
    .map((c) => without(c, "notes"))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const referenced = new Set<string>();
  for (const c of testCases) {
    const requirements = Array.isArray(c.expectedEvidence) ? (c.expectedEvidence as Array<{ anyOf?: string[] }>) : [];
    for (const r of requirements) for (const ref of r.anyOf ?? []) referenced.add(ref);
    for (const field of ["contextEvidence", "distractorEvidence"] as const) for (const ref of (Array.isArray(c[field]) ? (c[field] as string[]) : [])) referenced.add(ref);
  }
  const gold = raw.goldEvidence
    .filter((g) => referenced.has(String(g.id)))
    .map((g) => without(g, "description"))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  return sha256Text(canonicalJson({ cases: testCases, gold }));
}

/** Null when the test set matches the fingerprint recorded when it was frozen; otherwise what is wrong. */
export function verifyTestFreeze(raw: RawEvalDataset): string | null {
  const freeze = raw.meta.testFreeze as EvalMeta["testFreeze"] | undefined;
  if (!freeze) return "meta.testFreeze is missing.";
  const testCount = raw.cases.filter((c) => c.split === "test").length;
  if (testCount !== freeze.caseCount) return `the test set has ${testCount} cases but ${freeze.caseCount} were frozen.`;
  return testSetFingerprint(raw) === freeze.fingerprintSha256
    ? null
    : "the labels of the frozen test set changed since it was frozen. Changing a test label needs a new dataset version, not an edit in place.";
}

// ---------------------------------------------------------------------
// Against the corpus
// ---------------------------------------------------------------------

/** Whether a stored passage is the one a gold definition describes: same source, same heading, every anchor present. */
export function chunkMatchesGold(gold: GoldEvidence, chunk: { sourceKey: string; headingPath: string[]; text: string }): boolean {
  return chunk.sourceKey === gold.sourceKey && chunk.headingPath[chunk.headingPath.length - 1] === gold.heading && gold.anchors.every((anchor) => chunk.text.includes(anchor));
}

/** Every problem between the dataset and the corpus it names. Empty when the gold evidence is real and unambiguous. */
export function checkDatasetAgainstCorpus(dataset: EvalDataset, corpus: Corpus): string[] {
  const issues: string[] = [];
  if (dataset.meta.corpusVersion !== corpus.version) issues.push(`the dataset is for corpus ${dataset.meta.corpusVersion}, but the shipped corpus is ${corpus.version}.`);
  if (dataset.meta.assessmentYear !== corpus.assessmentYear) issues.push(`the dataset is for AY ${dataset.meta.assessmentYear}, but the shipped corpus is for AY ${corpus.assessmentYear}.`);

  for (const gold of dataset.goldEvidence) {
    const source = corpus.sources.find((s) => s.sourceKey === gold.sourceKey);
    if (!source) {
      issues.push(`${gold.id}: unknown source "${gold.sourceKey}".`);
      continue;
    }
    if (source.status !== "active") issues.push(`${gold.id}: source "${gold.sourceKey}" is ${source.status}, not active.`);
    const hits = source.chunks.filter((chunk) => chunkMatchesGold(gold, { sourceKey: source.sourceKey, headingPath: chunk.headingPath, text: chunk.text }));
    if (hits.length === 0) issues.push(`${gold.id}: no chunk of "${gold.sourceKey}" under the heading "${gold.heading}" contains every anchor.`);
    else if (hits.length > 1) issues.push(`${gold.id}: the anchors match more than one chunk under "${gold.heading}", so the gold is ambiguous.`);
  }
  return issues;
}
