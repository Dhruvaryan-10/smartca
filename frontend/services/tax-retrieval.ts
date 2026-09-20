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
//   - explicit about sections: a section the question names is matched to the
//     passages filed under it, to passages that name it in their text (80CCD(1B)
//     inside the 80C passage), or, for a clause, to its enclosing section. The
//     result says which (`sectionResolutions`); it never presents a passage that
//     merely cites a section as that section's text.
//   - explicit about the year and the tier the question asks for (Phase 5C). The
//     year is a parameter, so a question that itself names another year ("AY
//     2024-25", "FY 2026-27" = AY 2027-28) is refused with `yearMismatch`, never
//     answered with this year's evidence. And a question whose claim needs
//     statute or a circular is refused with `authorityTier` when the corpus holds
//     none of that tier for the year; when it does, only that tier is returned.
//     The corpus is never relabelled: official guidance stays official guidance.
//     Both are read from the question's own words (lib/rag/question-scope.ts).
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
import { requiredAuthorityTiers, statedAssessmentYears } from "@/lib/rag/question-scope";
import { resolveSectionRefs, sectionRefCore } from "@/lib/rag/section-resolution";
import type { SectionBasis } from "@/lib/rag/section-resolution";
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

/**
 * How the corpus covers a section the question named. It is about the passages, not about the law: it never says what
 * the section provides.
 *   indexed           passages are filed under exactly this section.
 *   cited_in_passage  none is filed under it, but the returned passages name it in their text (80CCD(1B) inside the
 *                     passage filed under 80C). The evidence is what the source says around the reference.
 *   parent_section    the question named a clause (115BAC(1A)) the corpus does not have; the evidence is the enclosing
 *                     section's guidance, and `clauseCovered` is false: clause-level wording is not present.
 * Whether the engine models a provision is unaffected: read `verificationStatus` on the evidence.
 */
export type SectionResolution = {
  /** The section as the question (or `sectionRef`) named it, in canonical form. */
  requested: string;
  basis: SectionBasis;
  /** The section the passages are filed under or stand in for; the requested section for `cited_in_passage`. */
  resolvedTo: string;
  /** False only for `parent_section`. */
  clauseCovered: boolean;
  /** The returned evidence this resolution accounts for. */
  evidenceIds: string[];
};

/**
 *   no_corpus_for_assessment_year        the corpus holds nothing for the year asked for, or for the year the question names.
 *   assessment_year_mismatch             the question names a year other than the one requested, and the corpus DOES hold it:
 *                                        the request contradicts itself, so neither year's evidence is returned.
 *   required_authority_tier_unavailable  the question's claim needs statute or a circular and the corpus holds none for the year.
 */
export type InsufficientReason =
  | "corpus_not_loaded"
  | "no_corpus_for_assessment_year"
  | "assessment_year_mismatch"
  | "required_authority_tier_unavailable"
  | "no_searchable_terms"
  | "section_not_in_corpus"
  | "no_matching_passages";

export type TaxRetrievalResult =
  | {
      status: "ok";
      assessmentYear: string;
      corpusVersion: string;
      evidence: TaxEvidence[];
      /** Sections the question named that the corpus does not contain in any form, so the gap is explicit. */
      unmatchedSectionRefs: string[];
      /** For each named section the corpus covers: how it is covered. Empty when the question names no section. */
      sectionResolutions: SectionResolution[];
    }
  | {
      status: "insufficient_evidence";
      reason: InsufficientReason;
      assessmentYear: string;
      corpusVersion: string | null;
      /** The section references the question named, if any. */
      sectionRefs: string[];
      /** Present when the question names an assessment year other than `requested`: what was asked for and every year the question names. */
      yearMismatch?: { requested: string; stated: string[] };
      /** Present when the claim needs statute or a circular the corpus does not hold: the tiers needed (any one) and the tiers it does hold for the year. */
      authorityTier?: { required: AuthorityTier[]; available: AuthorityTier[] };
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
const uuidArray = (items: string[]): SQL =>
  items.length === 0 ? sql`ARRAY[]::uuid[]` : sql`ARRAY[${sql.join(items.map((item) => sql`${item}`), sql`, `)}]::uuid[]`;

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

type ContextRow = { version: string | null; has_year: boolean; years: string[]; tiers: string[]; section_refs: string[]; lexemes: string[] };
type MentionRow = { chunk_id: string; text: string };
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

function readInput(input: TaxRetrievalInput): { question: string; assessmentYear: string; sectionRefs: string[]; statedYears: string[]; requiredTiers: AuthorityTier[] } {
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
  return { question, assessmentYear: input.assessmentYear, sectionRefs: refs, statedYears: statedAssessmentYears(question), requiredTiers: requiredAuthorityTiers(question) };
}

/**
 * Evidence from the authoritative corpus for a tax-law question, for one assessment year.
 *
 * `executor` defaults to the shared database; tests pass a transaction. It is not a way to select whose
 * corpus to read: the corpus is global and this takes no user id.
 */
export async function retrieveTaxLaw(input: TaxRetrievalInput, executor: SqlExecutor = db): Promise<TaxRetrievalResult> {
  const { question, assessmentYear, sectionRefs, statedYears, requiredTiers } = readInput(input);
  const insufficient = (
    reason: InsufficientReason,
    corpusVersion: string | null,
    safety: { yearMismatch?: { requested: string; stated: string[] }; authorityTier?: { required: AuthorityTier[]; available: AuthorityTier[] } } = {},
  ): TaxRetrievalResult => ({
    status: "insufficient_evidence",
    reason,
    assessmentYear,
    corpusVersion,
    sectionRefs,
    ...safety,
  });

  try {
    // 1. What the corpus holds for this year, and the question's search terms.
    const context = (
      await executor.execute<ContextRow>(sql`
        SELECT
          (SELECT version FROM tax_corpus_releases ORDER BY created_at DESC, id DESC LIMIT 1) AS version,
          EXISTS (SELECT 1 FROM tax_sources WHERE status = 'active' AND assessment_year = ${assessmentYear}) AS has_year,
          ARRAY(SELECT DISTINCT assessment_year FROM tax_sources WHERE status = 'active') AS years,
          ARRAY(SELECT DISTINCT authority_tier::text FROM tax_sources WHERE status = 'active' AND assessment_year = ${assessmentYear}) AS tiers,
          ARRAY(
            SELECT DISTINCT c.section_ref FROM tax_source_chunks c JOIN tax_sources s ON s.id = c.source_id
            WHERE s.status = 'active' AND s.assessment_year = ${assessmentYear} AND c.section_ref IS NOT NULL
          ) AS section_refs,
          ARRAY(SELECT lexeme FROM unnest(to_tsvector('english', ${question}::text))) AS lexemes
      `)
    ).rows[0];

    if (!context || context.version === null) return insufficient("corpus_not_loaded", null);
    const corpusVersion = context.version;

    // A question that itself names another assessment year is not answered from this year's corpus, and no passage is
    // searched: evidence for the wrong year must never look like support. Decided before anything else about the request.
    const otherYears = statedYears.filter((year) => year !== assessmentYear);
    if (otherYears.length > 0) {
      const held = otherYears.some((year) => context.years.includes(year));
      return insufficient(held ? "assessment_year_mismatch" : "no_corpus_for_assessment_year", corpusVersion, { yearMismatch: { requested: assessmentYear, stated: statedYears } });
    }
    if (!context.has_year) return insufficient("no_corpus_for_assessment_year", corpusVersion);

    // A claim that needs statute or a circular is not answered with guidance. If the corpus holds none of the tier for
    // this year it is refused (naming what IS held); if it does, only passages of that tier can be evidence.
    const availableTiers = (context.tiers as AuthorityTier[]).slice().sort();
    let tierFilter: AuthorityTier[] = [];
    if (requiredTiers.length > 0) {
      tierFilter = requiredTiers.filter((tier) => availableTiers.includes(tier));
      if (tierFilter.length === 0) return insufficient("required_authority_tier_unavailable", corpusVersion, { authorityTier: { required: requiredTiers, available: availableTiers } });
    }

    if (context.lexemes.length === 0 && sectionRefs.length === 0) return insufficient("no_searchable_terms", corpusVersion);

    // A named section the corpus does not contain, in any form, must not be answered with a nearby passage.
    // A section is contained if passages are filed under it, if passages name it in their text, or (for a clause)
    // if the section it belongs to is filed: see lib/rag/section-resolution.ts. Only the sections that no passage
    // is filed under need their passages' text read, and only to find the section references they name.
    const indexed = new Set(context.section_refs);
    const notIndexed = sectionRefs.filter((ref) => !indexed.has(ref));
    const mentions = new Map<string, string[]>();
    if (notIndexed.length > 0) {
      const rows = (
        await executor.execute<MentionRow>(sql`
          SELECT c.id AS chunk_id, c."text" AS text
          FROM tax_source_chunks c
          JOIN tax_sources s ON s.id = c.source_id
          WHERE s.status = 'active'
            AND s.assessment_year = ${assessmentYear}
            AND c."text" ILIKE ANY(${textArray(notIndexed.map((ref) => `%${sectionRefCore(ref)}%`))})
        `)
      ).rows;
      for (const row of rows) mentions.set(row.chunk_id, extractSectionRefs(row.text));
    }
    const { resolved, unmatched: unmatchedSectionRefs } = resolveSectionRefs(sectionRefs, indexed, mentions);
    if (sectionRefs.length > 0 && resolved.length === 0) return insufficient("section_not_in_corpus", corpusVersion);

    // The passages a resolved section points to: those filed under it (or under its parent), and those that name it.
    const filedUnder = new Set(resolved.flatMap((r) => (r.filedUnder === null ? [] : [r.filedUnder])));
    const citing = new Set(resolved.flatMap((r) => r.citingChunkIds));
    const targeted = sql`(coalesce(c.section_ref = ANY(${textArray([...filedUnder])}), false) OR c.id = ANY(${uuidArray([...citing])}))`;

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
          AND ${tierFilter.length === 0 ? sql`TRUE` : sql`s.authority_tier::text = ANY(${textArray(tierFilter)})`}
          AND (c.search_vector @@ q.orq OR ${targeted})
        ORDER BY ${targeted} DESC, text_rank DESC, s.source_key, c.chunk_index
        LIMIT ${CANDIDATE_LIMIT}
      `)
    ).rows;

    // 3. Keep passages the question actually bears on, then order by score, authority, then position.
    const scored = candidates
      .map((row) => {
        const sectionMatch = (row.section_ref !== null && filedUnder.has(row.section_ref)) || citing.has(row.chunk_id);
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
      // A passage found because it names a section is quoted around that mention as well as around the question's
      // words, so a generic question ("limit") does not quote another section's figure from the same passage.
      const cited = resolved.filter((r) => r.citingChunkIds.includes(row.chunk_id)).map((r) => r.requested);
      const quote = selectQuote(row.text, [question, ...cited].join(" "));
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

    const sectionResolutions: SectionResolution[] = resolved.map((r) => ({
      requested: r.requested,
      basis: r.basis,
      resolvedTo: r.resolvedTo,
      clauseCovered: r.clauseCovered,
      evidenceIds: evidence
        .filter((e) => (r.filedUnder !== null && e.sectionRef === r.filedUnder) || r.citingChunkIds.includes(e.chunkId))
        .map((e) => e.evidenceId),
    }));

    return { status: "ok", assessmentYear, corpusVersion, evidence, unmatchedSectionRefs, sectionResolutions };
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    // Drizzle errors carry the statement's parameters, and one of them is the question.
    const code = pgErrorCode(error);
    throw new Error(`Tax law retrieval could not be completed${code && /^[0-9A-Za-z_]{1,32}$/.test(code) ? ` (database error ${code})` : ""}.`);
  }
}
