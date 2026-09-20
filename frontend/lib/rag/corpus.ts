// The tax-law corpus, as data: manifest validation, text normalisation and
// hashing, and deterministic chunking. PURE: no database, no file system, no
// network, no framework. Reading files and writing rows live elsewhere
// (lib/rag/load-corpus.ts, services/tax-corpus.ts).
//
// What the corpus is. A small, curated, versioned set of AUTHORITATIVE
// sources for one assessment year, stored as reviewable text files plus a
// manifest. It is global (no user data of any kind) and it is only ever
// changed by the ingestion script, never by a request handler.
//
// What it must never be:
//   - a source of tax ARITHMETIC. Only the deterministic engine computes tax.
//   - generated or paraphrased text. Chunks are exact slices of the source
//     files; a retrieved quote is an exact substring of a chunk.
//   - a mix of legislation. For AY 2026-27 (FY 2025-26) the governing act is
//     the Income-tax Act, 1961. Text and section numbers from the Income-tax
//     Act, 2025 must not enter this corpus, and the manifest is refused if it
//     says otherwise.
import { createHash } from "node:crypto";
import { getSupportedAssessmentYearLabels } from "../../tax-engine";

// ---------------------------------------------------------------------
// Vocabulary (mirrors the database enums in db/schema.ts)
// ---------------------------------------------------------------------

/** Highest first. Only official sources are accepted; there is deliberately no tier for commentary. */
export const AUTHORITY_TIERS = ["statute", "notification_circular", "official_guidance"] as const;
export type AuthorityTier = (typeof AUTHORITY_TIERS)[number];
export const AUTHORITY_TIER_RANK: Record<AuthorityTier, number> = { statute: 3, notification_circular: 2, official_guidance: 1 };

export const CHUNK_REGIMES = ["old", "new", "both"] as const;
export type ChunkRegime = (typeof CHUNK_REGIMES)[number];

/**
 * primary_verified: taken verbatim from the official source named in the manifest, as retrieved.
 * engine_not_modelled: also verbatim from an official source, but the deterministic engine does not model
 *   this provision, so retrieval may cite it and must never imply the engine computes it.
 */
export const VERIFICATION_STATUSES = ["primary_verified", "engine_not_modelled"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const SOURCE_STATUSES = ["active", "superseded", "withdrawn"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** The only governing act accepted for AY 2026-27. */
export const GOVERNING_ACT_1961 = "Income-tax Act, 1961";

/** A chunk is at most this many characters (a single very long line is split at a sentence or space). */
export const MAX_CHUNK_CHARS = 1400;
const MIN_SPLIT_PROGRESS = 200;

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type ManifestSection = {
  /** Exact text of a heading in the source file. Chunks under it (or under a deeper heading) inherit the rest. */
  heading: string;
  sectionRef: string | null;
  regime: ChunkRegime;
  topics: string[];
  verificationStatus: VerificationStatus;
};

export type ManifestSource = {
  sourceKey: string;
  title: string;
  publisher: string;
  url: string;
  authorityTier: AuthorityTier;
  sourceDate: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  retrievedAt: string;
  status: SourceStatus;
  /** Relative to the corpus directory, under sources/. */
  file: string;
  /** SHA-256 of the NORMALISED source text, pinned so an accidental edit is caught. */
  sha256: string;
  notes: string | null;
  sections: ManifestSection[];
};

export type KnownGap = { sectionRef: string; title: string; reason: string };

export type CorpusManifest = {
  corpusVersion: string;
  governingAct: string;
  assessmentYear: string;
  description: string;
  knownGaps: KnownGap[];
  sources: ManifestSource[];
};

export type CorpusChunk = {
  chunkIndex: number;
  sectionRef: string | null;
  headingPath: string[];
  text: string;
  textSha256: string;
  /** Offsets into the normalised source text; `text` equals that slice exactly. */
  charStart: number;
  charEnd: number;
  regime: ChunkRegime;
  topics: string[];
  verificationStatus: VerificationStatus;
};

export type CorpusSource = Omit<ManifestSource, "sections" | "sha256" | "file"> & {
  governingAct: string;
  assessmentYear: string;
  contentSha256: string;
  text: string;
  chunks: CorpusChunk[];
};

export type Corpus = {
  version: string;
  governingAct: string;
  assessmentYear: string;
  /** Hash over the canonical manifest and every source's content hash: changes if anything reviewable changes. */
  manifestSha256: string;
  knownGaps: KnownGap[];
  sources: CorpusSource[];
};

export class CorpusValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`The tax corpus is not valid:\n- ${issues.join("\n- ")}`);
    this.name = "CorpusValidationError";
  }
}

// ---------------------------------------------------------------------
// Normalisation and hashing
// ---------------------------------------------------------------------

/**
 * The single form every source is hashed and chunked in: no byte-order mark,
 * LF line endings, exactly one trailing newline. Git on Windows may check the
 * same file out with CRLF; normalising keeps every hash and offset stable.
 */
export function normalizeSourceText(raw: string): string {
  return raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "") + "\n";
}

export const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** JSON with keys sorted at every level, so a hash does not depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------
// Section references
// ---------------------------------------------------------------------

/**
 * "Section 87A" / "87a" / "u/s 80 D" -> "87A" / "87A" / "80D". The number and letters are upper case; a
 * parenthesised clause is lower case ("16(ia)"), so a reference has one canonical form. Null if it is not
 * shaped like a section reference.
 */
export function normalizeSectionRef(input: string): string | null {
  const stripped = input.trim().replace(/^(?:section|sec\.?|u\/s|s\.|§)\s*/i, "");
  // Spaces are allowed only between the number and its letters ("80 D") and before a clause ("80CCD (1B)").
  const match = /^(\d{1,3})\s?([A-Za-z]{0,4})((?:\s*\([A-Za-z0-9]{1,4}\))*)$/.exec(stripped);
  if (!match) return null;
  return match[1] + match[2].toUpperCase() + match[3].replace(/\s+/g, "").toLowerCase();
}

// "50L" (lakh), "2Cr", "1st"... look like section references and are not.
const NOT_SECTION_SUFFIXES = new Set(["L", "CR", "K", "M", "LAC", "LAKH", "LAKHS", "CRORE", "CRORES", "ST", "ND", "RD", "TH"]);

/**
 * The section references a question names, in order, canonical, unique. Two shapes count: an explicit
 * "section"/"sec."/"u/s" prefix, or a bare upper-case reference such as 87A, 80C, 115BAC.
 */
export function extractSectionRefs(question: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const ref = normalizeSectionRef(raw);
    if (ref && !found.includes(ref)) found.push(ref);
  };

  const prefixed = /\b(?:section|sec\.?|u\/s|s\.)\s*(\d{1,3}\s?[A-Za-z]{0,4}(?:\s*\([A-Za-z0-9]{1,4}\))*)/gi;
  const bare = /(?<![\w.])(\d{1,3}[A-Z]{1,4}(?:\([A-Za-z0-9]{1,4}\))*)(?!\w)/g;

  const tokens: Array<{ index: number; raw: string }> = [];
  for (const m of question.matchAll(prefixed)) tokens.push({ index: m.index ?? 0, raw: m[1] });
  for (const m of question.matchAll(bare)) {
    const suffix = /^\d+([A-Z]+)/.exec(m[1])?.[1] ?? "";
    if (!NOT_SECTION_SUFFIXES.has(suffix)) tokens.push({ index: m.index ?? 0, raw: m[1] });
  }
  tokens.sort((a, b) => a.index - b.index).forEach((t) => add(t.raw));
  return found;
}

// ---------------------------------------------------------------------
// Headings and chunking
// ---------------------------------------------------------------------

type Block = { headingPath: string[]; start: number; end: number };

/**
 * Splits normalised text into body blocks under their headings. A heading is a line of 1 to 6 `#`
 * followed by its text. `start` and `end` bound the block's body, trimmed at both ends.
 */
export function parseBlocks(text: string): { blocks: Block[]; headings: Set<string> } {
  const blocks: Block[] = [];
  const headings = new Set<string>();
  const stack: Array<{ level: number; text: string }> = [];
  let current: { start: number; end: number } | null = null;

  const flush = () => {
    if (current) blocks.push({ headingPath: stack.map((h) => h.text), start: current.start, end: current.end });
    current = null;
  };

  let lineStart = 0;
  while (lineStart < text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd < 0) lineEnd = text.length;
    const line = text.slice(lineStart, lineEnd);

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: heading[2] });
      headings.add(heading[2]);
    } else if (line.trim() !== "") {
      const start = lineStart + (line.length - line.trimStart().length);
      const end = lineStart + line.trimEnd().length;
      current = current ? { start: current.start, end } : { start, end };
    }
    lineStart = lineEnd + 1;
  }
  flush();
  return { blocks, headings };
}

/** Where to cut a body that is too long: the last paragraph, line, sentence or word break that still makes progress. */
function findCut(text: string, start: number, limit: number): number {
  const floor = start + MIN_SPLIT_PROGRESS;
  for (const separator of ["\n\n", "\n", ". ", " "]) {
    const at = text.lastIndexOf(separator, limit);
    if (at >= floor) return separator === ". " ? at + 1 : at;
  }
  return limit;
}

/** Splits [start, end) into pieces of at most MAX_CHUNK_CHARS, each trimmed. Deterministic. */
function splitRange(text: string, start: number, end: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let s = start;
  while (end - s > MAX_CHUNK_CHARS) {
    const cut = findCut(text, s, s + MAX_CHUNK_CHARS);
    let pieceEnd = cut;
    while (pieceEnd > s && /\s/.test(text[pieceEnd - 1])) pieceEnd--;
    if (pieceEnd > s) pieces.push([s, pieceEnd]);
    s = cut;
    while (s < end && /\s/.test(text[s])) s++;
  }
  if (s < end) pieces.push([s, end]);
  return pieces;
}

/** Chunks a normalised source: one chunk per block, longer blocks split; metadata from the manifest rules. */
export function chunkSource(text: string, sections: ManifestSection[]): CorpusChunk[] {
  const byHeading = new Map(sections.map((rule) => [rule.heading, rule]));
  const chunks: CorpusChunk[] = [];

  for (const block of parseBlocks(text).blocks) {
    // The deepest heading with a rule decides; a chunk under no rule gets neutral defaults.
    let rule: ManifestSection | undefined;
    for (let i = block.headingPath.length - 1; i >= 0 && !rule; i--) rule = byHeading.get(block.headingPath[i]);

    for (const [charStart, charEnd] of splitRange(text, block.start, block.end)) {
      const chunkText = text.slice(charStart, charEnd);
      chunks.push({
        chunkIndex: chunks.length,
        sectionRef: rule?.sectionRef ?? null,
        headingPath: block.headingPath,
        text: chunkText,
        textSha256: sha256Text(chunkText),
        charStart,
        charEnd,
        regime: rule?.regime ?? "both",
        topics: rule ? [...rule.topics] : [],
        verificationStatus: rule?.verificationStatus ?? "primary_verified",
      });
    }
  }
  return chunks;
}

// ---------------------------------------------------------------------
// Manifest validation and corpus building
// ---------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const isRealDate = (v: string) => ISO_DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function unknownKeys(record: Record<string, unknown>, allowed: string[], where: string, issues: string[]) {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) issues.push(`${where}: unknown field "${key}".`);
}

/** Official hosts only: the corpus is for authoritative sources, so a commentary site is refused outright. */
function isOfficialUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname.endsWith(".gov.in") || parsed.hostname.endsWith(".nic.in"));
  } catch {
    return false;
  }
}

/**
 * Validate a manifest and build the corpus from it. `readSource` returns the raw text of a source file
 * (relative to the corpus directory). Every problem found is reported at once, not just the first.
 */
export function buildCorpus(manifestInput: unknown, readSource: (file: string) => string): Corpus {
  const issues: string[] = [];
  if (!isRecord(manifestInput)) throw new CorpusValidationError(["The manifest must be a JSON object."]);
  const m = manifestInput;
  unknownKeys(m, ["corpusVersion", "governingAct", "assessmentYear", "description", "knownGaps", "sources"], "manifest", issues);

  if (!isText(m.corpusVersion) || !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(m.corpusVersion)) issues.push("corpusVersion is required (letters, digits, . _ -; 3 to 64 characters).");
  if (m.governingAct !== GOVERNING_ACT_1961) {
    issues.push(
      `governingAct must be exactly "${GOVERNING_ACT_1961}". AY 2026-27 (FY 2025-26) is governed by the 1961 Act; the Income-tax Act, 2025 must not be mixed into this corpus.`,
    );
  }
  if (!isText(m.assessmentYear) || !getSupportedAssessmentYearLabels().includes(m.assessmentYear)) {
    issues.push(`assessmentYear must be one the tax engine supports (${getSupportedAssessmentYearLabels().join(", ")}).`);
  }
  if (!isText(m.description)) issues.push("description is required.");

  const knownGaps: KnownGap[] = [];
  if (!Array.isArray(m.knownGaps)) issues.push("knownGaps must be a list (it may be empty).");
  else {
    m.knownGaps.forEach((gap, i) => {
      if (!isRecord(gap) || !isText(gap.sectionRef) || !isText(gap.title) || !isText(gap.reason)) issues.push(`knownGaps[${i}] needs sectionRef, title and reason.`);
      else knownGaps.push({ sectionRef: gap.sectionRef, title: gap.title, reason: gap.reason });
    });
  }

  if (!Array.isArray(m.sources) || m.sources.length === 0) {
    issues.push("sources must be a non-empty list.");
    throw new CorpusValidationError(issues);
  }

  const seenKeys = new Set<string>();
  const sources: CorpusSource[] = [];
  const manifestSources: unknown[] = [];

  m.sources.forEach((entry, index) => {
    const where = `sources[${index}]`;
    if (!isRecord(entry)) {
      issues.push(`${where} must be an object.`);
      return;
    }
    unknownKeys(
      entry,
      ["sourceKey", "title", "publisher", "url", "authorityTier", "sourceDate", "effectiveFrom", "effectiveTo", "retrievedAt", "status", "file", "sha256", "notes", "sections"],
      where,
      issues,
    );

    const label = isText(entry.sourceKey) ? `source "${entry.sourceKey}"` : where;
    if (!isText(entry.sourceKey) || !/^[a-z0-9][a-z0-9-]{2,79}$/.test(entry.sourceKey)) issues.push(`${label}: sourceKey must be lower-case letters, digits and hyphens.`);
    else if (seenKeys.has(entry.sourceKey)) issues.push(`${label}: duplicate sourceKey.`);
    else seenKeys.add(entry.sourceKey);

    if (!isText(entry.title)) issues.push(`${label}: title is required.`);
    if (!isText(entry.publisher)) issues.push(`${label}: publisher is required.`);
    if (!isText(entry.url) || !isOfficialUrl(entry.url)) issues.push(`${label}: url must be an https URL on an official host (.gov.in or .nic.in).`);
    if (!AUTHORITY_TIERS.includes(entry.authorityTier as AuthorityTier)) issues.push(`${label}: authorityTier must be one of ${AUTHORITY_TIERS.join(", ")}.`);
    if (!SOURCE_STATUSES.includes(entry.status as SourceStatus)) issues.push(`${label}: status must be one of ${SOURCE_STATUSES.join(", ")}.`);

    for (const field of ["sourceDate", "effectiveFrom", "effectiveTo"] as const) {
      const value = entry[field];
      if (value !== null && !(typeof value === "string" && isRealDate(value))) issues.push(`${label}: ${field} must be null or a real YYYY-MM-DD date.`);
    }
    if (typeof entry.effectiveFrom === "string" && typeof entry.effectiveTo === "string" && entry.effectiveFrom > entry.effectiveTo) issues.push(`${label}: effectiveFrom is after effectiveTo.`);
    if (!isText(entry.retrievedAt) || !ISO_INSTANT.test(entry.retrievedAt)) issues.push(`${label}: retrievedAt must be a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ).`);
    if (entry.notes !== null && !isText(entry.notes)) issues.push(`${label}: notes must be null or text.`);

    const fileOk = isText(entry.file) && /^sources\/[a-z0-9][a-z0-9._-]*\.txt$/.test(entry.file);
    if (!fileOk) issues.push(`${label}: file must be a path like sources/name.txt.`);
    if (!isText(entry.sha256) || !/^[0-9a-f]{64}$/.test(entry.sha256)) issues.push(`${label}: sha256 must be a 64-character hex digest.`);

    const rules: ManifestSection[] = [];
    if (!Array.isArray(entry.sections)) issues.push(`${label}: sections must be a list.`);
    else {
      entry.sections.forEach((rule, i) => {
        const ruleWhere = `${label}: sections[${i}]`;
        if (!isRecord(rule)) {
          issues.push(`${ruleWhere} must be an object.`);
          return;
        }
        unknownKeys(rule, ["heading", "sectionRef", "regime", "topics", "verificationStatus"], ruleWhere, issues);
        const ref = rule.sectionRef === null ? null : isText(rule.sectionRef) ? normalizeSectionRef(rule.sectionRef) : undefined;
        if (!isText(rule.heading)) issues.push(`${ruleWhere}: heading is required.`);
        if (ref === undefined || (rule.sectionRef !== null && ref === null)) issues.push(`${ruleWhere}: sectionRef must be null or a section reference such as 87A or 16(ia).`);
        if (!CHUNK_REGIMES.includes(rule.regime as ChunkRegime)) issues.push(`${ruleWhere}: regime must be one of ${CHUNK_REGIMES.join(", ")}.`);
        if (!VERIFICATION_STATUSES.includes(rule.verificationStatus as VerificationStatus)) issues.push(`${ruleWhere}: verificationStatus must be one of ${VERIFICATION_STATUSES.join(", ")}.`);
        if (!Array.isArray(rule.topics) || !rule.topics.every((t) => isText(t))) issues.push(`${ruleWhere}: topics must be a list of text.`);
        if (isText(rule.heading) && rules.some((r) => r.heading === rule.heading)) issues.push(`${ruleWhere}: heading "${rule.heading}" already has a rule.`);
        if (isText(rule.heading)) {
          rules.push({
            heading: rule.heading,
            sectionRef: typeof ref === "string" ? ref : null,
            regime: rule.regime as ChunkRegime,
            topics: Array.isArray(rule.topics) ? (rule.topics as string[]) : [],
            verificationStatus: rule.verificationStatus as VerificationStatus,
          });
        }
      });
    }

    // Read, normalise and check the source file itself.
    if (!fileOk || !isText(entry.sourceKey)) return;
    let raw: string;
    try {
      raw = readSource(entry.file as string);
    } catch {
      issues.push(`${label}: the source file ${entry.file} could not be read.`);
      return;
    }
    const text = normalizeSourceText(raw);
    const contentSha256 = sha256Text(text);
    if (typeof entry.sha256 === "string" && entry.sha256 !== contentSha256) {
      issues.push(`${label}: sha256 does not match the file (expected ${contentSha256}). The file changed; review it and update the manifest.`);
    }
    const { headings } = parseBlocks(text);
    for (const rule of rules) if (!headings.has(rule.heading)) issues.push(`${label}: no heading "${rule.heading}" in ${entry.file}.`);

    const chunks = chunkSource(text, rules);
    if (chunks.length === 0) issues.push(`${label}: the source produced no chunks.`);

    manifestSources.push({ ...entry, sections: rules, contentSha256 });
    sources.push({
      sourceKey: entry.sourceKey,
      title: entry.title as string,
      publisher: entry.publisher as string,
      url: entry.url as string,
      authorityTier: entry.authorityTier as AuthorityTier,
      sourceDate: (entry.sourceDate as string | null) ?? null,
      effectiveFrom: (entry.effectiveFrom as string | null) ?? null,
      effectiveTo: (entry.effectiveTo as string | null) ?? null,
      retrievedAt: entry.retrievedAt as string,
      status: entry.status as SourceStatus,
      notes: (entry.notes as string | null) ?? null,
      governingAct: m.governingAct as string,
      assessmentYear: m.assessmentYear as string,
      contentSha256,
      text,
      chunks,
    });
  });

  if (issues.length > 0) throw new CorpusValidationError(issues);

  const manifestSha256 = sha256Text(
    canonicalJson({
      corpusVersion: m.corpusVersion,
      governingAct: m.governingAct,
      assessmentYear: m.assessmentYear,
      description: m.description,
      knownGaps,
      sources: manifestSources,
    }),
  );
  return {
    version: m.corpusVersion as string,
    governingAct: m.governingAct as string,
    assessmentYear: m.assessmentYear as string,
    manifestSha256,
    knownGaps,
    sources,
  };
}
