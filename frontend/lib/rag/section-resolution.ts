// How a section reference named in a question is matched to the corpus. PURE: no database, no file system,
// no network.
//
// The corpus indexes a passage under ONE section reference (its `section_ref`), but a passage often speaks of
// more: the passage filed under 80C also holds 80CCC, 80CCD(1) and 80CCD(1B); the one filed under 115BAC also
// holds 24(b), 80CCD(2) and 80CCH. Matching a question only against the index therefore said "not in the
// corpus" for text the corpus does contain.
//
// A named reference is resolved, in this order, to the first basis that holds:
//
//   indexed           a passage is filed under exactly this reference. (Unchanged from Phase 5A.)
//   cited_in_passage  no passage is filed under it, but a passage NAMES it as a section reference in its text
//                     (see extractSectionRefs: a keyword such as "section" / "u/s", or a row label like "80CCC |";
//                     never a bare number). A reference with no clause also matches a passage that names one of
//                     its clauses: 80CCD matches 80CCD(1B).
//   parent_section    the reference is a clause ("115BAC(1a)") and the section it belongs to ("115BAC") is
//                     indexed. The enclosing section's passages stand in for it, and the result says the clause
//                     itself is not covered.
//
// Anything else is a gap, and stays one. In particular a sibling clause is not evidence for a clause the text never
// names: 80CCD(3) is not resolved by 80CCD(1B), and 139(2) is not resolved by 139(1).
//
// This module decides only WHICH passages a reference points to. It never says what a section provides: a passage
// that cites a section is evidence of what the source says around it, and the resolution says so.

export type SectionBasis = "indexed" | "cited_in_passage" | "parent_section";

export type ResolvedSection = {
  /** The reference as it was named, in canonical form. */
  requested: string;
  basis: SectionBasis;
  /** The section the passages are filed under or stand in for; the requested reference itself for `cited_in_passage`. */
  resolvedTo: string;
  /** False only for `parent_section`: the clause is not in the corpus, so clause-level wording is absent. */
  clauseCovered: boolean;
  /** Passages filed under this section (`indexed`, `parent_section`), else null. */
  filedUnder: string | null;
  /** Passages that name it (`cited_in_passage`), sorted; else empty. */
  citingChunkIds: string[];
};

const TRAILING_CLAUSE = /\([^()]*\)$/;

/** "115BAC(1a)" -> "115BAC"; null when there is no clause to take off. */
export function sectionRefParent(ref: string): string | null {
  return TRAILING_CLAUSE.test(ref) ? ref.replace(TRAILING_CLAUSE, "") : null;
}

/** The number and letters without any clause: "80CCD(1b)" -> "80CCD". */
export function sectionRefCore(ref: string): string {
  return /^\d{1,3}[A-Z]{0,4}/.exec(ref)?.[0] ?? ref;
}

/** Whether a reference named in a passage is the requested one (or, for a clause-less request, one of its clauses). */
function names(mentioned: string, requested: string): boolean {
  return mentioned === requested || (!requested.includes("(") && mentioned.startsWith(`${requested}(`));
}

/** The nearest enclosing section that is indexed: "10(13a)(x)" tries "10(13a)", then "10". */
function indexedParent(ref: string, indexed: ReadonlySet<string>): string | null {
  for (let parent = sectionRefParent(ref); parent !== null; parent = sectionRefParent(parent)) {
    if (indexed.has(parent)) return parent;
  }
  return null;
}

/**
 * @param named     the canonical references the question named
 * @param indexed   every `section_ref` a passage of the corpus is filed under
 * @param mentions  for each candidate passage (chunk id), the canonical references its text names
 */
export function resolveSectionRefs(
  named: readonly string[],
  indexed: ReadonlySet<string>,
  mentions: ReadonlyMap<string, readonly string[]>,
): { resolved: ResolvedSection[]; unmatched: string[] } {
  const resolved: ResolvedSection[] = [];
  const unmatched: string[] = [];

  for (const requested of named) {
    if (indexed.has(requested)) {
      resolved.push({ requested, basis: "indexed", resolvedTo: requested, clauseCovered: true, filedUnder: requested, citingChunkIds: [] });
      continue;
    }

    const citing = [...mentions].filter(([, refs]) => refs.some((ref) => names(ref, requested))).map(([id]) => id).sort();
    if (citing.length > 0) {
      resolved.push({ requested, basis: "cited_in_passage", resolvedTo: requested, clauseCovered: true, filedUnder: null, citingChunkIds: citing });
      continue;
    }

    const parent = indexedParent(requested, indexed);
    if (parent !== null) {
      resolved.push({ requested, basis: "parent_section", resolvedTo: parent, clauseCovered: false, filedUnder: parent, citingChunkIds: [] });
      continue;
    }

    unmatched.push(requested);
  }
  return { resolved, unmatched };
}
