// Phase 5C: evidence safety at the retrieval contract. Two classes of mistake the Phase 5B baseline exposed:
//
//   1. Assessment-year mismatch. The year is a parameter, so a question that explicitly asks about ANOTHER year
//      ("AY 2024-25", "FY 2026-27") still got AY 2026-27 evidence back, as if it answered. It must not.
//   2. Authority-tier mismatch. The corpus is official e-filing guidance, not statute text and not circulars. A question
//      that explicitly demands the wording of the Act, or a notification or circular, must not be answered with guidance
//      that could then be passed off as statute or circular evidence.
//
// The detectors are pure and tested first. The retrieval tests are DB-backed, in transactions that are always rolled
// back, and use nonsense-word fixtures wherever another year or tier has to EXIST in the corpus.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredAuthorityTiers, statedAssessmentYears } from "../lib/rag/question-scope";
import { loadCorpusFromDisk } from "../lib/rag/load-corpus";
import { ingestTaxCorpus } from "../services/tax-corpus";
import { retrieveTaxLaw } from "../services/tax-retrieval";
import type { TaxRetrievalResult } from "../services/tax-retrieval";
import { inRolledBackTransaction, insertFixtureSource } from "./helpers-rag";
import type { Tx } from "./helpers-rag";

const AY = "2026-27";
const withShippedCorpus = <T>(work: (tx: Tx) => Promise<T>) =>
  inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    return work(tx);
  });

function insufficient(result: TaxRetrievalResult) {
  assert.equal(result.status, "insufficient_evidence", JSON.stringify(result));
  if (result.status !== "insufficient_evidence") throw new Error("unreachable");
  return result;
}
function ok(result: TaxRetrievalResult) {
  assert.equal(result.status, "ok", JSON.stringify(result));
  if (result.status !== "ok") throw new Error("unreachable");
  return result;
}

// --- the year detector ---------------------------------------------------------------

test("a year is read only when an AY or FY marker says so, and an FY is converted to its assessment year", () => {
  assert.deepEqual(statedAssessmentYears("What was the Section 87A rebate limit in AY 2024-25?"), ["2024-25"]);
  assert.deepEqual(statedAssessmentYears("What are the tax slabs for FY 2026-27?"), ["2027-28"], "FY 2026-27 is AY 2027-28");
  assert.deepEqual(statedAssessmentYears("What is the rebate for AY 2026-27?"), ["2026-27"]);
  assert.deepEqual(statedAssessmentYears("Do I get it for the whole of FY 2025-26?"), ["2026-27"], "FY 2025-26 is AY 2026-27");
});

test("the usual spellings of a marker and of the year are all read", () => {
  for (const [text, year] of [
    ["A.Y. 2025-26", "2025-26"], ["a.y 2025-26", "2025-26"], ["AY2025-26", "2025-26"], ["assessment year 2025-26", "2025-26"],
    ["Assessment Year: 2025-26", "2025-26"], ["AY 2025-2026", "2025-26"], ["AY 2025–26", "2025-26"], ["AY 2025/26", "2025-26"],
    ["F.Y. 2024-25", "2025-26"], ["FY2024-25", "2025-26"], ["financial year 2024-25", "2025-26"], ["previous year 2024-25", "2025-26"],
    ["AY 1999-00", "1999-00"],
  ] as const) {
    assert.deepEqual(statedAssessmentYears(`What is the limit for ${text}?`), [year], text);
  }
});

test("both spellings of the same year agree, several years are all reported, and each appears once", () => {
  assert.deepEqual(statedAssessmentYears("The rebate for AY 2026-27 (FY 2025-26)"), ["2026-27"]);
  assert.deepEqual(statedAssessmentYears("Compare AY 2025-26 with AY 2026-27"), ["2025-26", "2026-27"]);
  assert.deepEqual(statedAssessmentYears("AY 2025-26, again AY 2025-26"), ["2025-26"]);
});

test("no year is invented: amounts, dates, sections and a bare year span are not years", () => {
  for (const question of [
    "What is the Section 87A rebate limit?",
    "Is income above ₹12 lakh taxed at 10%?",
    "What is the tax on ₹12,00,000 to ₹16,00,000?",
    "Is 2026 a leap year?",
    "Does section 80C allow ₹1,50,000 in 2026?",
    "Can I claim 12-13 lakh under 80D?",
    "How much did the limit go up compared with last year?",
    "What about AY?",
    "the rebate in 2024-25",
    "AY 2026-30",
    "AY 2026-28",
  ]) assert.deepEqual(statedAssessmentYears(question), [], question);
});

// --- the authority-tier detector -----------------------------------------------------

test("an ordinary question about what the official guidance says needs no particular tier", () => {
  for (const question of [
    "What is the Section 87A rebate limit under the new tax regime?",
    "What does the official guidance say about Section 87A?",
    "What does the e-filing portal say about the rebate?",
    "Is the new tax regime the default under section 115BAC?",
    "Which section of the Act is the rebate in?",
    "How is cess calculated?",
    "Who is a senior citizen?",
    "What is the combined deduction limit under Section 80C?",
  ]) assert.deepEqual(requiredAuthorityTiers(question), [], question);
});

test("a demand for the wording of the Act, or for what the Act says, needs statute", () => {
  for (const question of [
    "Give me the exact wording of Section 87A from the Act.",
    "What is the verbatim text of section 80C?",
    "Quote the precise language of section 112A.",
    "What does the Income-tax Act say about Section 80C?",
    "What does the Income Tax Act, 1961 provide for the rebate?",
    "What the Act says about the standard deduction, please.",
    "According to the Act, what is the rebate limit?",
    "As per the Income-tax Act, who is a senior citizen?",
    "Cite the statute for the standard deduction.",
    "Show me the statutory text of 87A.",
  ]) assert.deepEqual(requiredAuthorityTiers(question), ["statute"], question);
});

test("a demand for a notification or circular needs notification_circular, and naming one wins over 'exact wording'", () => {
  for (const question of [
    "Which CBDT circular applies the rebate to capital gains?",
    "Is there a notification that changed the rebate limit?",
    "What does Circular 13/2025 say?",
    "Give me the exact wording of the CBDT circular on the rebate.",
  ]) assert.deepEqual(requiredAuthorityTiers(question), ["notification_circular"], question);
  assert.deepEqual(requiredAuthorityTiers("Does the circular follow what the Act says about 87A?"), ["statute", "notification_circular"]);
});

// --- retrieval: assessment-year safety -----------------------------------------------

test("a question about AY 2024-25 is not answered with AY 2026-27 evidence: typed mismatch, no evidence", async () => {
  await withShippedCorpus(async (tx) => {
    const result = insufficient(await retrieveTaxLaw({ question: "What was the Section 87A rebate limit in AY 2024-25?", assessmentYear: AY }, tx));
    assert.equal(result.reason, "no_corpus_for_assessment_year", "the corpus holds nothing for the year the question is about");
    assert.deepEqual(result.yearMismatch, { requested: AY, stated: ["2024-25"] });
    assert.equal(result.assessmentYear, AY);
    assert.ok(!("evidence" in result), "not a shred of evidence rides along");
    assert.equal(result.authorityTier, undefined);
  });
});

test("a question about FY 2026-27 (which is AY 2027-28) is not answered with AY 2026-27 evidence", async () => {
  await withShippedCorpus(async (tx) => {
    const result = insufficient(await retrieveTaxLaw({ question: "What are the tax slabs for FY 2026-27?", assessmentYear: AY }, tx));
    assert.equal(result.reason, "no_corpus_for_assessment_year");
    assert.deepEqual(result.yearMismatch, { requested: AY, stated: ["2027-28"] });
  });
});

test("a question that names the requested year is answered as before, whichever way it names it", async () => {
  await withShippedCorpus(async (tx) => {
    for (const question of [
      "What is the Section 87A rebate limit for AY 2026-27?",
      "What is the Section 87A rebate limit in assessment year 2026-27?",
      "What is the Section 87A rebate limit for FY 2025-26?",
      "What is the Section 87A rebate limit for AY 2026-27 (FY 2025-26)?",
    ]) {
      const result = ok(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
      assert.ok(result.evidence.length > 0 && result.evidence.every((e) => e.assessmentYear === AY), question);
      assert.ok(!("yearMismatch" in result), question);
    }
  });
});

test("questions that name no year, or only amounts, behave exactly as before", async () => {
  await withShippedCorpus(async (tx) => {
    for (const question of ["What is the Section 87A rebate limit?", "What is the Section 87A rebate limit for taxable income of ₹12 lakh or ₹12,00,000?", "What is the rate of health and education cess?"]) {
      const result = ok(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
      assert.ok(result.evidence.length > 0, question);
    }
    // And a question with no year for a year the corpus lacks still gets the original reason, with no mismatch field.
    const other = insufficient(await retrieveTaxLaw({ question: "What is the Section 87A rebate limit?", assessmentYear: "2025-26" }, tx));
    assert.equal(other.reason, "no_corpus_for_assessment_year");
    assert.equal(other.yearMismatch, undefined);
  });
});

test("when the corpus DOES hold the year the question names, the answer is a typed mismatch, never either year's evidence", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    await insertFixtureSource(tx, { sourceKey: "fixture-ay-2024-25", assessmentYear: "2024-25", chunks: [{ text: "zorblax quindle AY 2024-25 earlier-year-marker" }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-ay-2026-27", assessmentYear: "2026-27", chunks: [{ text: "zorblax quindle AY 2024-25 current-year-marker" }] });
    const question = "zorblax quindle AY 2024-25";

    const mismatch = insufficient(await retrieveTaxLaw({ question, assessmentYear: "2026-27" }, tx));
    assert.equal(mismatch.reason, "assessment_year_mismatch");
    assert.deepEqual(mismatch.yearMismatch, { requested: "2026-27", stated: ["2024-25"] });
    assert.ok(!("evidence" in mismatch));

    // Asked for the year it names, it answers from that year, and only that year.
    const matched = ok(await retrieveTaxLaw({ question, assessmentYear: "2024-25" }, tx));
    assert.deepEqual(matched.evidence.map((e) => e.sourceKey), ["fixture-ay-2024-25"]);
  });
});

test("a year mismatch is decided before any search: the stronger the lexical match, the same refusal", async () => {
  await withShippedCorpus(async (tx) => {
    const result = insufficient(await retrieveTaxLaw({ question: "Section 87A rebate limit 60,000 new tax regime AY 2027-28", assessmentYear: AY }, tx));
    assert.deepEqual(result.yearMismatch, { requested: AY, stated: ["2027-28"] });
  });
});

// --- retrieval: authority-tier safety ------------------------------------------------

test("an ordinary question about what the official guidance says is allowed, and its evidence says it is guidance", async () => {
  await withShippedCorpus(async (tx) => {
    const result = ok(await retrieveTaxLaw({ question: "What does the official guidance say about the Section 87A rebate limit?", assessmentYear: AY }, tx));
    assert.ok(result.evidence.length > 0);
    assert.ok(result.evidence.every((e) => e.authorityTier === "official_guidance"));
  });
});

test("'the exact wording of Section 87A from the Act' is refused: the corpus has no statute text, and guidance is not offered as it", async () => {
  await withShippedCorpus(async (tx) => {
    const result = insufficient(await retrieveTaxLaw({ question: "Give me the exact wording of Section 87A from the Act.", assessmentYear: AY }, tx));
    assert.equal(result.reason, "required_authority_tier_unavailable");
    assert.deepEqual(result.authorityTier, { required: ["statute"], available: ["official_guidance"] });
    assert.ok(!("evidence" in result));
    assert.deepEqual(result.sectionRefs, ["87A"], "the section it named is still reported");
    assert.equal(result.yearMismatch, undefined);
  });
});

test("a question that requires a notification or circular is refused for the same reason", async () => {
  await withShippedCorpus(async (tx) => {
    const result = insufficient(await retrieveTaxLaw({ question: "Which CBDT circular applies the 87A rebate to capital gains?", assessmentYear: AY }, tx));
    assert.equal(result.reason, "required_authority_tier_unavailable");
    assert.deepEqual(result.authorityTier, { required: ["notification_circular"], available: ["official_guidance"] });
  });
});

test("a question that requires what the Income-tax Act says is refused for the same reason", async () => {
  await withShippedCorpus(async (tx) => {
    for (const question of ["What does the Income-tax Act say about Section 80C?", "According to the Act, what is the rebate limit?", "Cite the statute for the standard deduction."]) {
      const result = insufficient(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
      assert.equal(result.reason, "required_authority_tier_unavailable", question);
      assert.deepEqual(result.authorityTier?.required, ["statute"], question);
    }
  });
});

test("the shipped corpus is not relabelled: it is still official guidance, and a tier check reads it as such", async () => {
  await withShippedCorpus(async (tx) => {
    const result = ok(await retrieveTaxLaw({ question: "What is the Section 87A rebate limit under the new tax regime?", assessmentYear: AY }, tx));
    assert.ok(result.evidence.every((e) => e.authorityTier === "official_guidance"));
    const refused = insufficient(await retrieveTaxLaw({ question: "Give me the exact wording of Section 87A from the Act.", assessmentYear: AY }, tx));
    assert.deepEqual(refused.authorityTier?.available, ["official_guidance"]);
  });
});

test("when the corpus does hold the required tier, only that tier is returned: guidance never fills in for statute", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    const text = "statute zorblax quindle flumbrick rule";
    await insertFixtureSource(tx, { sourceKey: "fixture-guidance", tier: "official_guidance", chunks: [{ text }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-statute", tier: "statute", chunks: [{ text }] });

    // The question demands statute, so the guidance passage with identical text is not evidence for it.
    const demanding = ok(await retrieveTaxLaw({ question: "Cite the statute: zorblax quindle flumbrick", assessmentYear: AY }, tx));
    assert.deepEqual(demanding.evidence.map((e) => [e.sourceKey, e.authorityTier]), [["fixture-statute", "statute"]]);

    // An ordinary question over the same passages is untouched.
    const ordinary = ok(await retrieveTaxLaw({ question: "zorblax quindle flumbrick", assessmentYear: AY }, tx));
    assert.deepEqual(ordinary.evidence.map((e) => e.authorityTier).sort(), ["official_guidance", "statute"]);

    // Asking for a circular when only statute and guidance exist is still a refusal, and says what IS available.
    const circular = insufficient(await retrieveTaxLaw({ question: "Which notification covers zorblax quindle?", assessmentYear: AY }, tx));
    assert.equal(circular.reason, "required_authority_tier_unavailable");
    assert.deepEqual(circular.authorityTier, { required: ["notification_circular"], available: ["official_guidance", "statute"] });
  });
});

test("a tier requirement never reaches into another year's sources", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    await insertFixtureSource(tx, { sourceKey: "fixture-old-statute", tier: "statute", assessmentYear: "2025-26", chunks: [{ text: "statute zorblax quindle flumbrick rule" }] });
    const result = insufficient(await retrieveTaxLaw({ question: "Cite the statute: zorblax quindle flumbrick", assessmentYear: AY }, tx));
    assert.equal(result.reason, "required_authority_tier_unavailable");
    assert.deepEqual(result.authorityTier?.available, ["official_guidance"], "the statute source is for AY 2025-26");
  });
});

// --- precedence ----------------------------------------------------------------------

test("a year mismatch is reported ahead of a tier problem, and a year with no corpus ahead of both", async () => {
  await withShippedCorpus(async (tx) => {
    const both = insufficient(await retrieveTaxLaw({ question: "Give me the exact wording of Section 87A from the Act for AY 2024-25.", assessmentYear: AY }, tx));
    assert.equal(both.reason, "no_corpus_for_assessment_year");
    assert.deepEqual(both.yearMismatch, { requested: AY, stated: ["2024-25"] });
    assert.equal(both.authorityTier, undefined);

    const noYear = insufficient(await retrieveTaxLaw({ question: "Give me the exact wording of Section 87A from the Act.", assessmentYear: "2025-26" }, tx));
    assert.equal(noYear.reason, "no_corpus_for_assessment_year");
    assert.equal(noYear.authorityTier, undefined);
  });
});

test("the safe states are read-only and deterministic: the same question gives the same refusal", async () => {
  await withShippedCorpus(async (tx) => {
    for (const question of ["What was the Section 87A rebate limit in AY 2024-25?", "Give me the exact wording of Section 87A from the Act."]) {
      assert.deepEqual(await retrieveTaxLaw({ question, assessmentYear: AY }, tx), await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
    }
  });
});
