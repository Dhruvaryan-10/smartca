// Section-reference handling in tax-law retrieval (Phase 5B fix).
//
// The bug: a passage is filed under ONE section reference, but its text names more (the 80C passage holds 80CCC,
// 80CCD(1) and 80CCD(1B); the 115BAC passage holds 24(b), 80CCD(2) and 80CCH). A question naming one of those
// got `section_not_in_corpus` even though the corpus contains the text.
//
// What these tests pin:
//   - each such reference now finds the passage that names it, and the result says it was CITED, not indexed;
//   - a clause the corpus lacks (115BAC(1A)) resolves to its enclosing section and is flagged as not covered;
//   - the distinctions survive: evidence that exists, evidence the engine does not model (verificationStatus),
//     and evidence that does not exist at all, which is still `section_not_in_corpus`;
//   - nothing resolves by numeric coincidence, from a sibling clause, from another year, or from an inactive source;
//   - the sections that were already supported behave as before.
//
// DB-backed tests run in a transaction that is always rolled back, on the shipped corpus. This is a regression
// suite, not an accuracy measurement.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { taxSourceChunks } from "../db/schema";
import { loadCorpusFromDisk } from "../lib/rag/load-corpus";
import { resolveSectionRefs, sectionRefCore, sectionRefParent } from "../lib/rag/section-resolution";
import { ingestTaxCorpus } from "../services/tax-corpus";
import { retrieveTaxLaw } from "../services/tax-retrieval";
import type { SectionResolution, TaxEvidence, TaxRetrievalResult } from "../services/tax-retrieval";
import { inRolledBackTransaction, insertFixtureSource } from "./helpers-rag";
import type { Tx } from "./helpers-rag";

const AY = "2026-27";
const SALARIED = "itd-efiling-salaried-individuals-ay-2026-27";

const withShippedCorpus = <T>(work: (tx: Tx) => Promise<T>) =>
  inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    return work(tx);
  });

function ok(result: TaxRetrievalResult) {
  assert.equal(result.status, "ok", JSON.stringify(result));
  if (result.status !== "ok") throw new Error("unreachable");
  return result;
}
function insufficient(result: TaxRetrievalResult) {
  assert.equal(result.status, "insufficient_evidence", JSON.stringify(result));
  if (result.status !== "insufficient_evidence") throw new Error("unreachable");
  return result;
}
const chunkText = async (tx: Tx, chunkId: string) => (await tx.select({ text: taxSourceChunks.text }).from(taxSourceChunks).where(eq(taxSourceChunks.id, chunkId)))[0].text;

/** The resolution for one named section, and the returned evidence it accounts for. */
function resolutionFor(result: Extract<TaxRetrievalResult, { status: "ok" }>, requested: string): { resolution: SectionResolution; accounted: TaxEvidence[] } {
  const resolution = result.sectionResolutions.find((r) => r.requested === requested);
  assert.ok(resolution, `no resolution for ${requested}: ${JSON.stringify(result.sectionResolutions)}`);
  return { resolution, accounted: result.evidence.filter((e) => resolution.evidenceIds.includes(e.evidenceId)) };
}

// --- the pure resolution rules --------------------------------------------------------

test("a section reference is split into its number-and-letters core and its enclosing section", () => {
  assert.equal(sectionRefCore("80CCD(1b)"), "80CCD");
  assert.equal(sectionRefCore("24(b)"), "24");
  assert.equal(sectionRefCore("115BAC"), "115BAC");
  assert.equal(sectionRefParent("115BAC(1a)"), "115BAC");
  assert.equal(sectionRefParent("10(13a)(x)"), "10(13a)");
  assert.equal(sectionRefParent("87A"), null);
});

test("resolution picks the first basis that holds: indexed, then cited in a passage, then the enclosing section", () => {
  const indexed = new Set(["80C", "115BAC"]);
  const mentions = new Map<string, string[]>([
    ["chunk-b", ["80CCC", "80CCD(1)", "80CCD(1b)"]],
    ["chunk-a", ["80CCD(1b)", "24(b)"]],
  ]);
  const { resolved, unmatched } = resolveSectionRefs(["80C", "80CCD(1b)", "115BAC(1a)", "24(b)", "80CCD(3)", "16(ia)"], indexed, mentions);

  assert.deepEqual(resolved.map((r) => [r.requested, r.basis, r.resolvedTo, r.clauseCovered]), [
    ["80C", "indexed", "80C", true],
    ["80CCD(1b)", "cited_in_passage", "80CCD(1b)", true],
    ["115BAC(1a)", "parent_section", "115BAC", false],
    ["24(b)", "cited_in_passage", "24(b)", true],
  ]);
  assert.deepEqual(resolved[1].citingChunkIds, ["chunk-a", "chunk-b"], "sorted, so the result does not depend on row order");
  assert.equal(resolved[2].filedUnder, "115BAC");
  assert.deepEqual(unmatched, ["80CCD(3)", "16(ia)"], "a sibling clause is not evidence for a clause the text never names");
});

test("a reference with no clause matches a passage that names one of its clauses, and only its own", () => {
  const mentions = new Map<string, string[]>([["c", ["80CCD(1)", "80CCD(1b)", "80CCDX"]]]);
  const { resolved, unmatched } = resolveSectionRefs(["80CCD", "80CC"], new Set(), mentions);
  assert.deepEqual(resolved.map((r) => r.requested), ["80CCD"]);
  assert.deepEqual(unmatched, ["80CC"], "a shorter number-and-letters string is a different section");
});

test("a passage that names the exact clause beats the enclosing section", () => {
  const { resolved } = resolveSectionRefs(["80C(2)"], new Set(["80C"]), new Map([["c", ["80C(2)"]]]));
  assert.equal(resolved[0].basis, "cited_in_passage");
  const walk = resolveSectionRefs(["10(13a)(x)"], new Set(["10"]), new Map());
  assert.equal(walk.resolved[0].resolvedTo, "10", "the nearest indexed ancestor is used");
});

// --- the reported cases, against the shipped corpus -------------------------------------

type Cited = {
  question: string;
  requested: string;
  /** The section the accounted passages are filed under (null: the passage is not tied to one section). */
  filedUnder: string | null;
  /** Text the accounted passage(s) must actually hold: the evidence exists in the corpus. */
  chunkIncludes: string[];
  /** Text of the reference as the source writes it, which must be in the quote itself. */
  quoteIncludes: string;
  /** Set where the corpus flags the passage as one the engine does not model. */
  engineNotModelled?: true;
  passages?: number;
};

const CITED: Cited[] = [
  {
    question: "What is the deduction limit under Section 80CCD(1B)?",
    requested: "80CCD(1b)",
    filedUnder: "80C",
    chunkIncludes: ["Section 80CCD(1B)", "excluding deduction claimed under 80CCD (1)", "Deduction limit of ₹ 50,000"],
    quoteIncludes: "80CCD(1B)",
  },
  {
    question: "What is the limit on employer contributions under Section 80CCD(2)?",
    requested: "80CCD(2)",
    filedUnder: "115BAC",
    chunkIncludes: ["Section 80CCD (2)", "Deduction limit of 14% of salary"],
    quoteIncludes: "80CCD (2)",
    engineNotModelled: true,
  },
  {
    question: "What does section 80CCC cover?",
    requested: "80CCC",
    filedUnder: "80C",
    chunkIncludes: ["Section 80C, 80CCC, 80CCD (1)", "80CCC | Annuity plan of LIC or another insurer"],
    quoteIncludes: "80CCC",
  },
  {
    question: "What does section 80CCH cover?",
    requested: "80CCH",
    filedUnder: "115BAC",
    chunkIncludes: ["Section 80CCH", "Agnipath Scheme"],
    quoteIncludes: "80CCH",
    engineNotModelled: true,
  },
  {
    question: "For a let-out house, is the interest deduction under section 24(b) allowed in the new regime?",
    requested: "24(b)",
    filedUnder: "115BAC",
    chunkIncludes: ["Section 24(b)", "Let Out", "Actual value without any limit"],
    quoteIncludes: "24(b)",
    engineNotModelled: true,
  },
  {
    question: "What does section 139(1) say?",
    requested: "139(1)",
    filedUnder: "115BAC",
    chunkIncludes: ["139(1)"],
    quoteIncludes: "139(1)",
    passages: 2, // the non-business and the business passage both name it
  },
  ...["111A", "112", "112A"].map((section) => ({
    question: `Is the enhanced surcharge levied on income under section ${section}?`,
    requested: section,
    filedUnder: null,
    chunkIncludes: ["sections 111A, 112, 112A and Dividend Income", "the maximum rate of surcharge on tax payable on such incomes shall be 15%"],
    quoteIncludes: "111A, 112, 112A",
  })),
];

for (const c of CITED) {
  test(`${c.requested}: named in a passage filed under ${c.filedUnder ?? "no section"}, so it is found, and reported as cited rather than indexed`, async () => {
    await withShippedCorpus(async (tx) => {
      const result = ok(await retrieveTaxLaw({ question: c.question, assessmentYear: AY }, tx));
      assert.deepEqual(result.unmatchedSectionRefs, [], "the corpus contains this reference, so no gap is reported");

      const { resolution, accounted } = resolutionFor(result, c.requested);
      assert.equal(resolution.basis, "cited_in_passage");
      assert.equal(resolution.resolvedTo, c.requested);
      assert.equal(resolution.clauseCovered, true);
      assert.equal(accounted.length, c.passages ?? 1);
      assert.ok(accounted.every((e) => result.evidence.slice(0, accounted.length).includes(e)), "the passages that name the section rank first");

      for (const evidence of accounted) {
        assert.equal(evidence.sourceKey, SALARIED);
        assert.equal(evidence.sectionRef, c.filedUnder, "the passage keeps its own filing: no section metadata is invented for it");
        assert.equal(evidence.authorityTier, "official_guidance");
        assert.ok(evidence.quote.includes(c.quoteIncludes), `the quote should show the reference: ${evidence.quote}`);
        if (c.engineNotModelled) assert.equal(evidence.verificationStatus, "engine_not_modelled", "evidence the engine does not model stays flagged");
        const text = await chunkText(tx, evidence.chunkId);
        assert.ok(text.includes(evidence.quote), "the quote is still an exact slice of its passage");
      }
      // Every required phrase is held by the accounted passages, together.
      const held = (await Promise.all(accounted.map((e) => chunkText(tx, e.chunkId)))).join("\n");
      for (const phrase of c.chunkIncludes) assert.ok(held.includes(phrase), `the retrieved passage should hold "${phrase}"`);
    });
  });
}

test("115BAC(1A) resolves to the 115BAC guidance and says clause-level wording is not in the corpus", async () => {
  await withShippedCorpus(async (tx) => {
    for (const input of [
      { question: "What does section 115BAC(1A) say?", assessmentYear: AY },
      { question: "regime", assessmentYear: AY, sectionRef: "115BAC(1A)" },
    ]) {
      const result = ok(await retrieveTaxLaw(input, tx));
      assert.deepEqual(result.unmatchedSectionRefs, []);

      const { resolution, accounted } = resolutionFor(result, "115BAC(1a)");
      assert.equal(resolution.basis, "parent_section");
      assert.equal(resolution.resolvedTo, "115BAC");
      assert.equal(resolution.clauseCovered, false, "the clause itself is not covered");
      assert.ok(accounted.length >= 1);
      assert.ok(accounted.every((e) => e.sectionRef === "115BAC" && e.authorityTier === "official_guidance"));
      assert.deepEqual(accounted.map((e) => e.evidenceId), result.evidence.map((e) => e.evidenceId), "everything returned is the parent's guidance");

      for (const evidence of accounted) {
        const text = await chunkText(tx, evidence.chunkId);
        assert.doesNotMatch(text, /115BAC\s*\(\s*1A\s*\)/i, "no passage holds text for the clause: none is claimed");
      }
      assert.ok(result.evidence.some((e) => e.verificationStatus === "engine_not_modelled") && result.evidence.some((e) => e.verificationStatus === "primary_verified"), "each passage keeps its own verification status");
    }
  });
});

test("80CCD, named without a clause, finds the passages that name its clauses", async () => {
  await withShippedCorpus(async (tx) => {
    const result = ok(await retrieveTaxLaw({ question: "What does section 80CCD say?", assessmentYear: AY }, tx));
    const { resolution, accounted } = resolutionFor(result, "80CCD");
    assert.equal(resolution.basis, "cited_in_passage");
    assert.deepEqual([...new Set(accounted.map((e) => e.sectionRef))].sort(), ["115BAC", "80C"], "80CCD(1) and 80CCD(1B) sit under 80C, 80CCD(2) under 115BAC");
  });
});

test("a question that names an explicit section parameter resolves it the same way", async () => {
  await withShippedCorpus(async (tx) => {
    const result = ok(await retrieveTaxLaw({ question: "limit", assessmentYear: AY, sectionRef: "80CCD(1B)" }, tx));
    assert.equal(resolutionFor(result, "80CCD(1b)").resolution.basis, "cited_in_passage");
    assert.equal(result.evidence[0].sectionRef, "80C");
    // A generic question ("limit") must not quote the 80C row's ₹1,50,000 from the same passage: the quote is
    // taken around the section that was named.
    const { quote } = result.evidence[0];
    assert.ok(quote.includes("80CCD(1B)") && quote.includes("Deduction limit of ₹ 50,000"), quote);
    assert.ok(!quote.includes("1,50,000"), quote);
    assert.ok((await chunkText(tx, result.evidence[0].chunkId)).includes("Section 80CCD(1B)"));
  });
});

// --- what is still, correctly, not in the corpus ---------------------------------------

test("a clause the corpus never names stays a gap, even when its siblings are in the corpus", async () => {
  await withShippedCorpus(async (tx) => {
    for (const [question, ref] of [
      ["What is section 80CCD(3)?", "80CCD(3)"], // 80CCD(1), (1B) and (2) are named
      ["What does section 139(2) say?", "139(2)"], // 139(1) is named
      ["Is section 24(c) relevant?", "24(c)"], // 24(b) is named
    ] as const) {
      const result = insufficient(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
      assert.equal(result.reason, "section_not_in_corpus", question);
      assert.deepEqual(result.sectionRefs, [ref]);
    }
  });
});

test("a number that merely occurs in the text is not a section: nothing resolves by numeric coincidence", async () => {
  await withShippedCorpus(async (tx) => {
    // "12" is in 12,00,000; "50" is in 50 lakhs; "10" is in 10,00,000; "87" is a prefix of 87A, which is not 87.
    for (const [question, ref] of [
      ["What is section 12?", "12"],
      ["What is section 50?", "50"],
      ["What does section 10(13A) provide?", "10(13a)"],
      ["Section 87 rebate", "87"],
      ["What is section 5 about?", "5"],
    ] as const) {
      const result = insufficient(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
      assert.equal(result.reason, "section_not_in_corpus", question);
      assert.deepEqual(result.sectionRefs, [ref], question);
    }
  });
});

test("the known gaps are unchanged: 16(ia), 288A and 288B are still not in the corpus", async () => {
  await withShippedCorpus(async (tx) => {
    const result = insufficient(await retrieveTaxLaw({ question: "What are sections 16(ia), 288A and 288B?", assessmentYear: AY }, tx));
    assert.equal(result.reason, "section_not_in_corpus");
    assert.deepEqual(result.sectionRefs, ["16(ia)", "288A", "288B"]);
  });
});

test("when a question names a section the corpus holds and one it lacks, it gets the evidence and the gap", async () => {
  await withShippedCorpus(async (tx) => {
    for (const question of ["What is Sec. 80CCD (1B) and section 16(ia)?", "80CCD(1B) and section 16(ia)"]) {
      const result = ok(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
      assert.deepEqual(result.unmatchedSectionRefs, ["16(ia)"], question);
      assert.deepEqual(result.sectionResolutions.map((r) => r.requested), ["80CCD(1b)"], "no stray reference such as a bare clause");
      assert.equal(result.evidence[0].sectionRef, "80C");
    }
  });
});

// --- the sections that were already supported behave as before --------------------------

test("80C, 80D, 87A and 115BAC are still indexed matches, first in the results, with no gap", async () => {
  await withShippedCorpus(async (tx) => {
    for (const [question, ref] of [
      ["What is the combined deduction limit under Section 80C?", "80C"],
      ["What is the health insurance deduction limit under Section 80D for parents?", "80D"],
      ["What is the Section 87A rebate limit under the new tax regime?", "87A"],
      ["Under section 115BAC, is the new tax regime the default regime?", "115BAC"],
    ] as const) {
      const result = ok(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
      assert.deepEqual(result.unmatchedSectionRefs, [], ref);
      assert.deepEqual(result.sectionResolutions.map((r) => [r.requested, r.basis, r.resolvedTo, r.clauseCovered]), [[ref, "indexed", ref, true]]);
      assert.equal(result.evidence[0].sectionRef, ref);
      assert.ok(result.evidence.filter((e) => e.sectionRef === ref).every((e) => result.sectionResolutions[0].evidenceIds.includes(e.evidenceId)), "every passage filed under the section is accounted for");
    }
  });
});

test("a question that names no section has no section resolutions", async () => {
  await withShippedCorpus(async (tx) => {
    const result = ok(await retrieveTaxLaw({ question: "What is the rate of health and education cess?", assessmentYear: AY }, tx));
    assert.deepEqual(result.sectionResolutions, []);
    assert.deepEqual(result.unmatchedSectionRefs, []);
  });
});

test("section resolution is deterministic", async () => {
  await withShippedCorpus(async (tx) => {
    const question = "What does section 139(1) say, and what is Section 80CCD(1B)?";
    assert.deepEqual(await retrieveTaxLaw({ question, assessmentYear: AY }, tx), await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
  });
});

// --- only active sources of the requested year count --------------------------------------

test("a section named only by a withdrawn or superseded source, or by another year's source, is not in the corpus", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    await insertFixtureSource(tx, { sourceKey: "fixture-withdrawn", status: "withdrawn", chunks: [{ text: "zorblax: see section 71Q for the flumbrick rule." }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-superseded", status: "superseded", chunks: [{ text: "zorblax: see section 71Q for the flumbrick rule." }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-other-year", assessmentYear: "2025-26", chunks: [{ text: "zorblax: see section 71Q for the flumbrick rule." }] });

    const none = insufficient(await retrieveTaxLaw({ question: "What does section 71Q say?", assessmentYear: AY }, tx));
    assert.equal(none.reason, "section_not_in_corpus");

    await insertFixtureSource(tx, { sourceKey: "fixture-active", chunks: [{ text: "zorblax: see section 71Q for the flumbrick rule." }] });
    const found = ok(await retrieveTaxLaw({ question: "What does section 71Q say?", assessmentYear: AY }, tx));
    assert.deepEqual(found.evidence.map((e) => e.sourceKey), ["fixture-active"]);
    assert.equal(resolutionFor(found, "71Q").resolution.basis, "cited_in_passage");

    // The other year's source answers for its own year only.
    const previous = ok(await retrieveTaxLaw({ question: "What does section 71Q say?", assessmentYear: "2025-26" }, tx));
    assert.deepEqual(previous.evidence.map((e) => e.sourceKey), ["fixture-other-year"]);
  });
});

test("a bare number in a passage is a section only where the passage visibly cites it as one", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    await insertFixtureSource(tx, {
      sourceKey: "fixture-lists",
      chunks: [
        { text: "zorblax: not levied under sections 71A, 72 and 73A." }, // 72 is cited, in a list
        { text: "zorblax: an amount of ₹72,000 and 74 lakhs and a 75th item." }, // 72 and 74 and 75 are only numbers
      ],
    });
    const cited = ok(await retrieveTaxLaw({ question: "Is section 72 relevant?", assessmentYear: AY }, tx));
    assert.equal(resolutionFor(cited, "72").resolution.basis, "cited_in_passage");
    assert.equal(cited.evidence[0].quote.includes("71A, 72 and 73A"), true);

    for (const ref of ["74", "75"]) {
      const result = insufficient(await retrieveTaxLaw({ question: `Is section ${ref} relevant?`, assessmentYear: AY }, tx));
      assert.equal(result.reason, "section_not_in_corpus", ref);
    }
  });
});
