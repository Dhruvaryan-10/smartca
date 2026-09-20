// What a question ASKS FOR, read from its own words: which assessment year(s) it is about, and which authority tier of
// evidence its claim needs. PURE: no database, no file system, no network.
//
// Retrieval takes the year as a parameter and never looked at the question's text, so "What was the 87A rebate in AY
// 2024-25?" asked with the year 2026-27 got AY 2026-27 guidance back as if it answered. And the corpus is official
// guidance, so "Give me the exact wording of Section 87A from the Act" got a guidance passage that a caller could pass
// off as statute. These two functions let the retrieval contract refuse both, explicitly (see services/tax-retrieval.ts).
//
// Both are deliberately NARROW. Each fires only on an explicit signal, so an ordinary question about what the official
// guidance says is never touched, and nothing is guessed from an arbitrary number ("₹12 lakh", "2026", "12-13").
import { AUTHORITY_TIERS } from "./corpus";
import type { AuthorityTier } from "./corpus";

// ---------------------------------------------------------------------
// Assessment years
// ---------------------------------------------------------------------

// A marker, then the year span. Markers are what make a span a year: "AY", "A.Y.", "assessment year" name an assessment
// year; "FY", "F.Y.", "financial year", "previous year" name the financial year, whose assessment year is the NEXT one
// (FY 2025-26 is AY 2026-27). A span with no marker ("in 2024-25") is not read: it could be either, so it is not guessed.
const SPAN = String.raw`\s*:?\s*(\d{4})\s*[-–—/]\s*(\d{4}|\d{2})(?!\d)`;
const AY_MARKER = new RegExp(String.raw`(?<![A-Za-z0-9])(?:a\.?\s?y\.?|assessment\s+year)${SPAN}`, "gi");
const FY_MARKER = new RegExp(String.raw`(?<![A-Za-z0-9])(?:f\.?\s?y\.?|(?:financial|previous)\s+year)${SPAN}`, "gi");

const pad2 = (n: number) => String(n % 100).padStart(2, "0");

/** "2025", "26" or "2026" -> the span 2025-26 if the second year really follows the first, else null. */
function consecutive(first: string, second: string): number | null {
  const start = Number(first);
  const ok = second.length === 4 ? Number(second) === start + 1 : Number(second) === (start + 1) % 100;
  return ok ? start : null;
}

/**
 * The assessment years a question explicitly names, in order and without repeats, each as "2026-27". A financial year is
 * converted to its assessment year. Only "AY ..." / "FY ..." style markers count; a span that is not a real year
 * ("AY 2026-30") is ignored.
 */
export function statedAssessmentYears(question: string): string[] {
  const found: Array<{ index: number; year: string }> = [];
  for (const [pattern, shift] of [[AY_MARKER, 0], [FY_MARKER, 1]] as const) {
    for (const match of question.matchAll(pattern)) {
      const start = consecutive(match[1], match[2]);
      if (start !== null) found.push({ index: match.index ?? 0, year: `${start + shift}-${pad2(start + shift + 1)}` });
    }
  }
  return [...new Set(found.sort((a, b) => a.index - b.index).map((f) => f.year))];
}

// ---------------------------------------------------------------------
// Authority tiers
// ---------------------------------------------------------------------

const ACT = String.raw`(?:income[\s-]?tax\s+)?act(?:,?\s*(?:1961|2025))?`;
// Naming a notification or a circular: the claim needs a circular.
const CIRCULAR = /\b(?:notification|circular)s?\b/i;
// Asking for the words of a legal text.
const WORDING = new RegExp(
  String.raw`\b(?:exact|verbatim|precise|literal|actual|original)\s+(?:wording|words|text|language)\b|\bverbatim\b|\b(?:wording|text|words|language)\s+of\s+(?:the\s+)?(?:section|sec\b\.?|s\.|${ACT}\b)`,
  "i",
);
// Asking what the Act (or the statute) says, or asking for the statute itself.
const STATUTE_SAYS = [
  new RegExp(String.raw`\b(?:what|how)\s+(?:does|do|did)\s+(?:the\s+)?${ACT}\s+(?:say|state|provide|prescribe|define|read|lay\s+down)\b`, "i"),
  new RegExp(String.raw`\bwhat\s+(?:the\s+)?${ACT}\s+(?:says|states|provides|prescribes|defines|reads)\b`, "i"),
  new RegExp(String.raw`\b(?:according\s+to|as\s+per|as\s+stated\s+in|as\s+provided\s+(?:in|by)|as\s+defined\s+in|as\s+written\s+in)\s+(?:the\s+)?${ACT}\b`, "i"),
  /\bstatute\b|\bstatutory\s+(?:text|wording|language|provisions?|definition)s?\b|\bbare\s+act\b/i,
];

/**
 * The authority tiers a question's claim needs, in AUTHORITY_TIERS order; an empty list means an ordinary question that
 * official guidance can answer. Any ONE of the returned tiers would do.
 *   statute                 the wording of the Act, or what the Act / the statute says.
 *   notification_circular   a notification or a circular is named. (Naming one also means "exact wording" is about that
 *                           circular, not about the Act.)
 * It reads the question only: a claim that merely happens to rest on a circular is not detectable from the question.
 */
export function requiredAuthorityTiers(question: string): AuthorityTier[] {
  const needs = new Set<AuthorityTier>();
  const circular = CIRCULAR.test(question);
  if (circular) needs.add("notification_circular");
  if (STATUTE_SAYS.some((pattern) => pattern.test(question)) || (!circular && WORDING.test(question))) needs.add("statute");
  return AUTHORITY_TIERS.filter((tier) => needs.has(tier));
}
