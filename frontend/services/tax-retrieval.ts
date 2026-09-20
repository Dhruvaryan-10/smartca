// Tax-law retrieval: finds passages of the curated, authoritative corpus that
// bear on a question, and returns them as EVIDENCE OBJECTS. It never writes a
// sentence of its own.
//
// What this is:
//   - lexical only: PostgreSQL full-text search over the stored chunks. No
//     LLM, no embeddings, no network.
//   - read-only: it only SELECTs. The corpus is global reference data written
//     by the ingestion script; nothing here (or in any request handler) can
//     change it.
//   - honest: when the corpus does not support an answer it says so with a
//     typed `insufficient_evidence` result instead of returning the nearest
//     passage. It never falls back to another assessment year.
//
// What this is NOT:
//   - a calculator. The deterministic tax engine is the only source of tax
//     arithmetic; evidence explains and cites the law, it does not produce
//     figures.
//   - a reader of user data. It takes no user id, joins no user table, and its
//     input is the text of a LAW question. Callers must never put a user's
//     financial data in that text.
//
// The question is potentially sensitive, so unexpected database errors are
// replaced by a generic one (Drizzle errors embed bound parameters, and the
// question is one) keeping only the database error code.
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { pgErrorCode } from "@/db/pg-errors";
import { AUTHORITY_TIER_RANK, extractSectionRefs, normalizeSectionRef, sha256Text } from "@/lib/rag/corpus";
import type { AuthorityTier, VerificationStatus } from "@/lib/rag/corpus";
import { ValidationError } from "./errors";

// ---------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------

export type TaxRetrievalInput = {
  /** A tax-LAW question. Never a user's financial data. */
  question: string;
  /** For example "2026-27". Evidence is only ever from this year's corpus. */
  assessmentYear: string;
  /** Optional: a section the caller already knows is in play, for example "87A". */
  sectionRef?: string;
};

export type TaxEvidence = {
  /** Deterministic: the same corpus version, passage and quote always give the same id. */
  evidenceId: string;
  chunkId: string;
  sourceKey: string;
  title: string;
  publisher: string;
  url: string;
  authorityTier: AuthorityTier;
  sectionRef: string | null;
  /** An exact substring of the stored passage. */
  quote: string;
  assessmentYear: string;
  effectiveFrom: string | null;
  retrievedAt: string;
  corpusVersion: string;
  verificationStatus: VerificationStatus;
  /** Ranking score for ordering only. It is not a probability and not a measure of correctness. */
  score: number;
};

export type InsufficientReason =
  | "corpus_not_loaded"
  | "no_corpus_for_assessment_year"
  | "no_searchable_terms"
  | "section_not_in_corpus"
  | "no_matching_passages";

export type TaxRetrievalResult =
  | {
      status: "ok";
      assessmentYear: string;
      corpusVersion: string;
      evidence: TaxEvidence[];
      /** Sections the question named that the corpus does not contain, so the gap is explicit. */
      unmatchedSectionRefs: string[];
    }
  | {
      status: "insufficient_evidence";
      reason: InsufficientReason;
      assessmentYear: string;
      corpusVersion: string | null;
      /** The section references the question named, if any. */
      sectionRefs: string[];
    };

// ---------------------------------------------------------------------
// Tuning. These are heuristics, not measured accuracy: the tests pin them on
// a small set of cases (rag-corpus/ay-2026-27/retrieval-tests.json), nothing more.
// ---------------------------------------------------------------------

export const MAX_QUESTION_LENGTH = 500;
export const MAX_EVIDENCE = 5;
const CANDIDATE_LIMIT = 40;
/** A passage matched only by words needs at least this many of the question's terms... */
const MIN_MATCHED_TERMS = 2;
/** ...and at least this share of them. */
const MIN_TERM_COVERAGE = 0.6;
/** Weights of the two lexical signals in a passage's score: raw text rank (0 to 1) and coverage of the question's terms (0 to 1). */
const TEXT_RANK_WEIGHT = 0.4;
const COVERAGE_WEIGHT = 0.6;
/** Added when a passage's section is one the question names. Larger than any lexical score, so a named section comes first. */
const SECTION_BOOST = 1;
/** Breaks near-ties in favour of the more authoritative source. */
const TIER_BONUS: Record<AuthorityTier, number> = { statute: 0.15, notification_circular: 0.08, official_guidance: 0 };
const MAX_QUOTE_CHARS = 400;

type SqlExecutor = Pick<typeof db, "execute">;

const textArray = (items: string[]): SQL =>
  items.length === 0 ? sql`ARRAY[]::text[]` : sql`ARRAY[${sql.join(items.map((item) => sql`${item}`), sql`, `)}]::text[]`;

// ---------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------

const QUOTE_STOP_WORDS = new Set([
  "the", "and", "for", "are", "was", "what", "which", "under", "with", "from", "that", "this", "how", "does", "can", "will", "who", "when",
  "between", "applies", "apply", "there", "their", "have", "has", "been", "such", "also", "is", "of", "to", "in", "on", "an", "or", "be", "by",
]);
const stem = (word: string) => word.slice(0, 5);
const wordsOf = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !QUOTE_STOP_WORDS.has(w)).map(stem);
/** A number that appears in both the question and a line is strong evidence the line is the one asked about. */
const wordWeight = (word: string) => (/^\d+$/.test(word) ? 2 : 1);

/**
 * A short passage of the chunk that best matches the question: the line (or sentence, for a very long line)
 * that shares the most words with it, followed by the lines after it up to a length limit, so a table row
 * keeps its header. Always an exact substring of `text`.
 */
export function selectQuote(text: string, question: string): string {
  const wanted = new Set(wordsOf(question));

  // Units: each line, and each sentence within a line longer than the limit, with their offsets.
  const units: Array<{ start: number; end: number }> = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);
    if (line.trim() !== "") {
      const offset = line.length - line.trimStart().length;
      const start = lineStart + offset;
      const end = lineStart + line.trimEnd().length;
      if (end - start <= MAX_QUOTE_CHARS) units.push({ start, end });
      else {
        let from = start;
        for (const match of text.slice(start, end).matchAll(/[.!?]\s+/g)) {
          const cut = start + (match.index ?? 0) + 1;
          if (cut > from) units.push({ start: from, end: cut });
          from = start + (match.index ?? 0) + match[0].length;
        }
        if (from < end) units.push({ start: from, end });
      }
    }
    lineStart = lineEnd + 1;
  }
  if (units.length === 0) return text.slice(0, MAX_QUOTE_CHARS);

  let best = 0;
  let bestScore = -1;
  units.forEach((unit, i) => {
    // Distinct words, so a line that repeats one word does not outscore a line that has more of them.
    const score = [...new Set(wordsOf(text.slice(unit.start, unit.end)))].filter((w) => wanted.has(w)).reduce((sum, w) => sum + wordWeight(w), 0);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });

  const start = units[best].start;
  let end = units[best].end;
  for (let i = best + 1; i < units.length && units[i].end - start <= MAX_QUOTE_CHARS; i++) end = units[i].end;
  if (end - start > MAX_QUOTE_CHARS) {
    const cut = text.lastIndexOf(" ", start + MAX_QUOTE_CHARS);
    end = cut > start ? cut : start + MAX_QUOTE_CHARS;
  }
  return text.slice(start, end);
}

// ---------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------

type ContextRow = { version: string | null; has_year: boolean; section_refs: string[]; lexemes: string[] };
type CandidateRow = {
  chunk_id: string;
  chunk_index: number;
  section_ref: string | null;
  text: string;
  verification_status: VerificationStatus;
  source_key: string;
  title: string;
  publisher: string;
  url: string;
  authority_tier: AuthorityTier;
  assessment_year: string;
  effective_from: string | null;
  retrieved_at: Date;
  text_rank: number;
  matched_terms: number;
};

function readInput(input: TaxRetrievalInput): { question: string; assessmentYear: string; sectionRefs: string[] } {
  if (typeof input !== "object" || input === null) throw new ValidationError("A question and an assessment year are required.");
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question === "") throw new ValidationError("question is required.");
  if (question.length > MAX_QUESTION_LENGTH) throw new ValidationError(`question must be at most ${MAX_QUESTION_LENGTH} characters.`);
  if (typeof input.assessmentYear !== "string" || !/^\d{4}-\d{2}$/.test(input.assessmentYear)) {
    throw new ValidationError('assessmentYear is required, for example "2026-27".');
  }

  const refs: string[] = [];
  if (input.sectionRef !== undefined) {
    const explicit = typeof input.sectionRef === "string" ? normalizeSectionRef(input.sectionRef) : null;
    if (explicit === null) throw new ValidationError('sectionRef must be a section reference such as "87A" or "16(ia)".');
    refs.push(explicit);
  }
  for (const ref of extractSectionRefs(question)) if (!refs.includes(ref)) refs.push(ref);
  return { question, assessmentYear: input.assessmentYear, sectionRefs: refs };
}

/**
 * Evidence from the authoritative corpus for a tax-law question, for one assessment year.
 *
 * `executor` defaults to the shared database; tests pass a transaction. It is not a way to select whose
 * corpus to read: the corpus is global and this takes no user id.
 */
export async function retrieveTaxLaw(input: TaxRetrievalInput, executor: SqlExecutor = db): Promise<TaxRetrievalResult> {
  const { question, assessmentYear, sectionRefs } = readInput(input);
  const insufficient = (reason: InsufficientReason, corpusVersion: string | null): TaxRetrievalResult => ({
    status: "insufficient_evidence",
    reason,
    assessmentYear,
    corpusVersion,
    sectionRefs,
  });

  try {
    // 1. What the corpus holds for this year, and the question's search terms.
    const context = (
      await executor.execute<ContextRow>(sql`
        SELECT
          (SELECT version FROM tax_corpus_releases ORDER BY created_at DESC, id DESC LIMIT 1) AS version,
          EXISTS (SELECT 1 FROM tax_sources WHERE status = 'active' AND assessment_year = ${assessmentYear}) AS has_year,
          ARRAY(
            SELECT DISTINCT c.section_ref FROM tax_source_chunks c JOIN tax_sources s ON s.id = c.source_id
            WHERE s.status = 'active' AND s.assessment_year = ${assessmentYear} AND c.section_ref IS NOT NULL
          ) AS section_refs,
          ARRAY(SELECT lexeme FROM unnest(to_tsvector('english', ${question}::text))) AS lexemes
      `)
    ).rows[0];

    if (!context || context.version === null) return insufficient("corpus_not_loaded", null);
    const corpusVersion = context.version;
    if (!context.has_year) return insufficient("no_corpus_for_assessment_year", corpusVersion);
    if (context.lexemes.length === 0 && sectionRefs.length === 0) return insufficient("no_searchable_terms", corpusVersion);

    // A named section the corpus does not contain must not be answered with a nearby passage.
    const known = new Set(context.section_refs);
    const present = sectionRefs.filter((ref) => known.has(ref));
    const unmatchedSectionRefs = sectionRefs.filter((ref) => !known.has(ref));
    if (sectionRefs.length > 0 && present.length === 0) return insufficient("section_not_in_corpus", corpusVersion);

    // 2. Candidate passages: only active sources, only this assessment year.
    const candidates = (
      await executor.execute<CandidateRow>(sql`
        WITH q AS (SELECT replace(plainto_tsquery('english', ${question}::text)::text, ' & ', ' | ')::tsquery AS orq)
        SELECT
          c.id AS chunk_id, c.chunk_index, c.section_ref, c."text" AS text, c.verification_status,
          s.source_key, s.title, s.publisher, s.url, s.authority_tier, s.assessment_year,
          s.effective_from::text AS effective_from, s.retrieved_at,
          ts_rank_cd(c.search_vector, q.orq, 32) AS text_rank,
          (SELECT count(*)::int FROM unnest(c.search_vector) u WHERE u.lexeme = ANY(${textArray(context.lexemes)})) AS matched_terms
        FROM tax_source_chunks c
        JOIN tax_sources s ON s.id = c.source_id
        CROSS JOIN q
        WHERE s.status = 'active'
          AND s.assessment_year = ${assessmentYear}
          AND (c.search_vector @@ q.orq OR c.section_ref = ANY(${textArray(present)}))
        ORDER BY (c.section_ref = ANY(${textArray(present)})) DESC, text_rank DESC, s.source_key, c.chunk_index
        LIMIT ${CANDIDATE_LIMIT}
      `)
    ).rows;

    // 3. Keep passages the question actually bears on, then order by score, authority, then position.
    const scored = candidates
      .map((row) => {
        const sectionMatch = row.section_ref !== null && present.includes(row.section_ref);
        const coverage = context.lexemes.length === 0 ? 0 : row.matched_terms / context.lexemes.length;
        const relevant = sectionMatch || (row.matched_terms >= MIN_MATCHED_TERMS && coverage >= MIN_TERM_COVERAGE);
        // Coverage counts as much as text rank: raw rank alone favours long, repetitive passages.
        const score = TEXT_RANK_WEIGHT * row.text_rank + COVERAGE_WEIGHT * coverage + (sectionMatch ? SECTION_BOOST : 0) + TIER_BONUS[row.authority_tier];
        return { row, relevant, score };
      })
      .filter((c) => c.relevant)
      .sort(
        (a, b) =>
          b.score - a.score ||
          AUTHORITY_TIER_RANK[b.row.authority_tier] - AUTHORITY_TIER_RANK[a.row.authority_tier] ||
          (a.row.source_key < b.row.source_key ? -1 : a.row.source_key > b.row.source_key ? 1 : 0) ||
          a.row.chunk_index - b.row.chunk_index,
      )
      .slice(0, MAX_EVIDENCE);

    if (scored.length === 0) return insufficient("no_matching_passages", corpusVersion);

    const evidence: TaxEvidence[] = scored.map(({ row, score }) => {
      const quote = selectQuote(row.text, question);
      // The contract, checked at the source: a quote is never anything but a slice of the stored passage.
      if (!row.text.includes(quote)) throw new Error("A selected quote was not part of its passage.");
      return {
        evidenceId: `ev_${sha256Text(`${corpusVersion}|${row.source_key}|${row.chunk_index}|${quote}`).slice(0, 16)}`,
        chunkId: row.chunk_id,
        sourceKey: row.source_key,
        title: row.title,
        publisher: row.publisher,
        url: row.url,
        authorityTier: row.authority_tier,
        sectionRef: row.section_ref,
        quote,
        assessmentYear: row.assessment_year,
        effectiveFrom: row.effective_from,
        retrievedAt: new Date(row.retrieved_at).toISOString(),
        corpusVersion,
        verificationStatus: row.verification_status,
        score: Math.round(score * 10000) / 10000,
      };
    });

    return { status: "ok", assessmentYear, corpusVersion, evidence, unmatchedSectionRefs };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    // Drizzle errors carry the statement's parameters, and one of them is the question.
    const code = pgErrorCode(error);
    throw new Error(`Tax law retrieval could not be completed${code && /^[0-9A-Za-z_]{1,32}$/.test(code) ? ` (database error ${code})` : ""}.`);
  }
}
