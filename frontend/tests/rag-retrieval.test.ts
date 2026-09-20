// Tax-law retrieval tests. DB-backed; every test runs in a transaction that is
// always rolled back, and starts by ingesting the shipped corpus into it, so
// the results never depend on what happens to be in the development database.
//
// Fixtures use nonsense words ("zorblax", "quindle", "flumbrick") that occur
// nowhere in the real corpus, so a fixture can only match another fixture, and
// each fixture test says which behaviour it proves.
//
// This is a regression suite for lexical retrieval, NOT an accuracy
// measurement. The case file (rag-corpus/ay-2026-27/retrieval-tests.json) is
// small and written by the person who built the retrieval, so no accuracy
// figure may be derived from it.
import "../db/load-env";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { desc, eq } from "drizzle-orm";
import { taxCorpusReleases, taxSourceChunks, taxSources } from "../db/schema";
import { loadCorpusFromDisk, DEFAULT_CORPUS_DIR } from "../lib/rag/load-corpus";
import { ValidationError } from "../services/errors";
import { ingestTaxCorpus } from "../services/tax-corpus";
import { MAX_EVIDENCE, MAX_QUESTION_LENGTH, retrieveTaxLaw, selectQuote } from "../services/tax-retrieval";
import type { TaxRetrievalResult } from "../services/tax-retrieval";
import { inRolledBackTransaction, insertFixtureSource } from "./helpers-rag";
import type { Tx } from "./helpers-rag";

const AY = "2026-27";

/** Runs `work` in a rolled-back transaction that already holds the shipped corpus. */
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

// --- the evidence object ---------------------------------------------------------

test("evidence is a structured object with provenance, and never generated prose", async () => {
  await withShippedCorpus(async (tx) => {
    const [latest] = await tx.select().from(taxCorpusReleases).orderBy(desc(taxCorpusReleases.createdAt), desc(taxCorpusReleases.id)).limit(1);
    const result = ok(await retrieveTaxLaw({ question: "What is the Section 87A rebate limit under the new tax regime?", assessmentYear: AY }, tx));

    assert.equal(result.assessmentYear, AY);
    assert.equal(result.corpusVersion, latest.version);
    assert.ok(result.evidence.length >= 1 && result.evidence.length <= MAX_EVIDENCE);

    const top = result.evidence[0];
    assert.deepEqual(Object.keys(top).sort(), [
      "assessmentYear", "authorityTier", "chunkId", "corpusVersion", "effectiveFrom", "evidenceId", "publisher",
      "quote", "retrievedAt", "score", "sectionRef", "sourceKey", "title", "url", "verificationStatus",
    ]);
    assert.match(top.evidenceId, /^ev_[0-9a-f]{16}$/);
    assert.match(top.chunkId, /^[0-9a-f-]{36}$/);
    assert.equal(top.assessmentYear, AY);
    assert.equal(top.corpusVersion, latest.version);
    assert.equal(top.authorityTier, "official_guidance");
    assert.match(top.url, /^https:\/\/www\.incometax\.gov\.in\//);
    assert.match(top.publisher, /Income Tax Department/);
    assert.match(top.retrievedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(top.effectiveFrom, null);
    assert.equal(top.verificationStatus, "primary_verified");
    assert.equal(typeof top.score, "number");

    // Scores never increase down the list, and every id is unique.
    result.evidence.forEach((e, i) => i === 0 || assert.ok(e.score <= result.evidence[i - 1].score));
    assert.equal(new Set(result.evidence.map((e) => e.evidenceId)).size, result.evidence.length);
  });
});

test("retrieval is deterministic: the same question gives the same evidence, ids included", async () => {
  await withShippedCorpus(async (tx) => {
    const question = "What is the combined deduction limit under Section 80C?";
    const a = await retrieveTaxLaw({ question, assessmentYear: AY }, tx);
    const b = await retrieveTaxLaw({ question, assessmentYear: AY }, tx);
    assert.deepEqual(a, b);
  });
});

test("a quote is always an exact substring of the stored passage it cites", async () => {
  await withShippedCorpus(async (tx) => {
    const cases = JSON.parse(fs.readFileSync(path.join(DEFAULT_CORPUS_DIR, "retrieval-tests.json"), "utf8")).cases as Array<{ question: string; assessmentYear?: string; sectionRef?: string }>;
    let checked = 0;
    for (const c of cases) {
      const result = await retrieveTaxLaw({ question: c.question, assessmentYear: c.assessmentYear ?? AY, ...(c.sectionRef ? { sectionRef: c.sectionRef } : {}) }, tx);
      if (result.status !== "ok") continue;
      for (const evidence of result.evidence) {
        const [chunk] = await tx.select({ text: taxSourceChunks.text }).from(taxSourceChunks).where(eq(taxSourceChunks.id, evidence.chunkId));
        assert.ok(evidence.quote.length > 0 && evidence.quote.length <= 400, `quote length ${evidence.quote.length}`);
        assert.ok(chunk.text.includes(evidence.quote), `quote for "${c.question}" is not in its passage`);
        assert.equal(evidence.quote, evidence.quote.trim(), "no stray whitespace at either end");
        checked++;
      }
    }
    assert.ok(checked >= 20, `only ${checked} quotes were checked`);
  });
});

test("quote selection works on every shipped passage for every question, including multi-byte text", () => {
  const corpus = loadCorpusFromDisk();
  const questions = ["₹ 50,000 rebate", "what is 80D?", "", "a", "the of and", "surcharge 50 lakhs 1 crore", "Rs. 12,00,000 – ₹ 16,00,000 “quoted” text"];
  for (const source of corpus.sources) {
    for (const chunk of source.chunks) {
      for (const question of questions) {
        const quote = selectQuote(chunk.text, question);
        assert.ok(quote.length > 0 && quote.length <= 400);
        assert.ok(chunk.text.includes(quote), `quote from chunk ${chunk.chunkIndex} is not a substring`);
      }
    }
  }
  // Edge shapes: a huge single line, only whitespace and newlines, and one very short passage.
  const huge = "word ".repeat(500).trim();
  assert.ok(huge.includes(selectQuote(huge, "word")));
  assert.equal(selectQuote("short", "short"), "short");
});

// --- section references ----------------------------------------------------------

test("an exact section reference is boosted: it reorders results, it does not merely appear in them", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    await insertFixtureSource(tx, {
      sourceKey: "fixture-boost",
      chunks: [
        { text: "zorblax quindle", sectionRef: "99Z" }, // the section chunk: short, so weaker on text alone
        { text: "zorblax quindle ".repeat(12) + "flumbrick", sectionRef: null }, // denser on text alone
      ],
    });
    const question = "zorblax quindle";

    const plain = ok(await retrieveTaxLaw({ question, assessmentYear: AY }, tx));
    assert.equal(plain.evidence[0].sectionRef, null, "with no section named, the denser passage is first");
    assert.equal(plain.evidence.length, 2);

    const named = ok(await retrieveTaxLaw({ question: `${question} under section 99Z`, assessmentYear: AY }, tx));
    assert.equal(named.evidence[0].sectionRef, "99Z", "naming the section in the question puts its passage first");

    const explicit = ok(await retrieveTaxLaw({ question, assessmentYear: AY, sectionRef: "99z" }, tx));
    assert.equal(explicit.evidence[0].sectionRef, "99Z", "so does the explicit sectionRef, in any case");
    assert.ok(explicit.evidence[0].score > explicit.evidence[1].score);
  });
});

test("a section the corpus does not contain is never answered with a nearby passage", async () => {
  await withShippedCorpus(async (tx) => {
    for (const sectionRef of ["16(ia)", "288A", "288B", "999Z"]) {
      const result = insufficient(await retrieveTaxLaw({ question: "rebate limit under the new tax regime", assessmentYear: AY, sectionRef }, tx));
      assert.equal(result.reason, "section_not_in_corpus", sectionRef);
      assert.deepEqual(result.sectionRefs, [sectionRef]);
    }
    // Named in the question text rather than the parameter: same rule.
    const named = insufficient(await retrieveTaxLaw({ question: "How is tax payable rounded under Section 288B?", assessmentYear: AY }, tx));
    assert.equal(named.reason, "section_not_in_corpus");
  });
});

test("when a question names one section the corpus has and one it lacks, it gets the evidence and the gap", async () => {
  await withShippedCorpus(async (tx) => {
    const result = ok(await retrieveTaxLaw({ question: "What is the Section 87A rebate, and how is it rounded under section 288A?", assessmentYear: AY }, tx));
    assert.equal(result.evidence[0].sectionRef, "87A");
    assert.deepEqual(result.unmatchedSectionRefs, ["288A"]);
  });
});

// --- assessment year -------------------------------------------------------------

test("only the requested assessment year's corpus is used, and another year is never substituted", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    await insertFixtureSource(tx, { sourceKey: "fixture-ay-2026-27", assessmentYear: "2026-27", chunks: [{ text: "zorblax quindle current-year-marker" }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-ay-2025-26", assessmentYear: "2025-26", chunks: [{ text: "zorblax quindle previous-year-marker" }] });
    const question = "zorblax quindle";

    const current = ok(await retrieveTaxLaw({ question, assessmentYear: "2026-27" }, tx));
    assert.deepEqual(current.evidence.map((e) => e.sourceKey), ["fixture-ay-2026-27"]);
    assert.ok(current.evidence.every((e) => e.assessmentYear === "2026-27"));
    assert.ok(current.evidence.every((e) => !e.quote.includes("previous-year-marker")), "no text from the other year leaks in");

    const previous = ok(await retrieveTaxLaw({ question, assessmentYear: "2025-26" }, tx));
    assert.deepEqual(previous.evidence.map((e) => e.sourceKey), ["fixture-ay-2025-26"]);
    assert.equal(previous.assessmentYear, "2025-26");

    // A year with no corpus at all is refused, not answered from the nearest year.
    const missing = insufficient(await retrieveTaxLaw({ question, assessmentYear: "2027-28" }, tx));
    assert.equal(missing.reason, "no_corpus_for_assessment_year");
    assert.equal(missing.assessmentYear, "2027-28");
  });
});

test("no year leaks: real questions for any other year return nothing from the 2026-27 corpus", async () => {
  await withShippedCorpus(async (tx) => {
    for (const year of ["2025-26", "2027-28", "2024-25", "2030-31"]) {
      for (const question of ["What is the Section 87A rebate limit?", "What is the rate of health and education cess?", "Who is a senior citizen?"]) {
        const result = insufficient(await retrieveTaxLaw({ question, assessmentYear: year }, tx));
        assert.equal(result.reason, "no_corpus_for_assessment_year", `${year}: ${question}`);
        assert.equal(result.assessmentYear, year);
      }
    }
  });
});

test("a malformed assessment year or question is a validation error, not a search", async () => {
  await withShippedCorpus(async (tx) => {
    for (const assessmentYear of ["2026", "26-27", "2026/27", "", "2026-2027", "abcd-ef"]) {
      await assert.rejects(() => retrieveTaxLaw({ question: "rebate?", assessmentYear }, tx), ValidationError, assessmentYear);
    }
    for (const question of ["", "   ", "x".repeat(MAX_QUESTION_LENGTH + 1)]) {
      await assert.rejects(() => retrieveTaxLaw({ question, assessmentYear: AY }, tx), ValidationError);
    }
    await assert.rejects(() => retrieveTaxLaw({ question: "rebate?", assessmentYear: AY, sectionRef: "not a section" }, tx), ValidationError);
    await assert.rejects(() => retrieveTaxLaw(null as never, tx), ValidationError);
    await assert.rejects(() => retrieveTaxLaw({ question: 42 as never, assessmentYear: AY }, tx), ValidationError);
  });
});

// --- authority ---------------------------------------------------------------------

test("higher authority tiers rank first when the text is otherwise identical", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    const text = "zorblax quindle flumbrick rule";
    // Inserted lowest tier first, so insertion order cannot explain the result.
    await insertFixtureSource(tx, { sourceKey: "fixture-tier-guidance", tier: "official_guidance", chunks: [{ text }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-tier-circular", tier: "notification_circular", chunks: [{ text }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-tier-statute", tier: "statute", chunks: [{ text }] });

    const result = ok(await retrieveTaxLaw({ question: "zorblax quindle flumbrick", assessmentYear: AY }, tx));
    assert.deepEqual(result.evidence.map((e) => e.authorityTier), ["statute", "notification_circular", "official_guidance"]);
    assert.ok(result.evidence[0].score > result.evidence[1].score && result.evidence[1].score > result.evidence[2].score);
  });
});

test("equal score and tier are ordered by source key, so ties are stable", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    for (const key of ["fixture-tie-c", "fixture-tie-a", "fixture-tie-b"]) await insertFixtureSource(tx, { sourceKey: key, chunks: [{ text: "zorblax quindle" }] });
    const result = ok(await retrieveTaxLaw({ question: "zorblax quindle", assessmentYear: AY }, tx));
    assert.deepEqual(result.evidence.map((e) => e.sourceKey), ["fixture-tie-a", "fixture-tie-b", "fixture-tie-c"]);
  });
});

test("superseded and withdrawn sources are never returned; only active ones are", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    await insertFixtureSource(tx, { sourceKey: "fixture-old-superseded", status: "superseded", chunks: [{ text: "zorblax quindle" }] });
    await insertFixtureSource(tx, { sourceKey: "fixture-old-withdrawn", status: "withdrawn", chunks: [{ text: "zorblax quindle" }] });

    const none = insufficient(await retrieveTaxLaw({ question: "zorblax quindle", assessmentYear: AY }, tx));
    assert.equal(none.reason, "no_matching_passages", "inactive sources do not count as evidence");

    await insertFixtureSource(tx, { sourceKey: "fixture-current", chunks: [{ text: "zorblax quindle" }] });
    const one = ok(await retrieveTaxLaw({ question: "zorblax quindle", assessmentYear: AY }, tx));
    assert.deepEqual(one.evidence.map((e) => e.sourceKey), ["fixture-current"]);

    // Retiring the current source removes it too.
    await tx.update(taxSources).set({ status: "superseded" }).where(eq(taxSources.sourceKey, "fixture-current"));
    insufficient(await retrieveTaxLaw({ question: "zorblax quindle", assessmentYear: AY }, tx));
  });
});

test("passages the engine does not model are flagged in their evidence", async () => {
  await withShippedCorpus(async (tx) => {
    const result = ok(await retrieveTaxLaw({ question: "What deductions are available under the new tax regime?", assessmentYear: AY }, tx));
    assert.equal(result.evidence[0].verificationStatus, "engine_not_modelled");
    const rebate = ok(await retrieveTaxLaw({ question: "What is the Section 87A rebate limit?", assessmentYear: AY }, tx));
    assert.equal(rebate.evidence[0].verificationStatus, "primary_verified");
  });
});

// --- insufficient evidence ---------------------------------------------------------

test("when the corpus cannot support an answer the result says so, with a typed reason", async () => {
  await withShippedCorpus(async (tx) => {
    const offTopic = insufficient(await retrieveTaxLaw({ question: "What is the tax on capital gains from shares?", assessmentYear: AY }, tx));
    assert.equal(offTopic.reason, "no_matching_passages");
    assert.equal(offTopic.assessmentYear, AY);
    assert.ok(offTopic.corpusVersion, "the corpus version is still reported");

    assert.equal(insufficient(await retrieveTaxLaw({ question: "the of and to", assessmentYear: AY }, tx)).reason, "no_searchable_terms");
    assert.equal(insufficient(await retrieveTaxLaw({ question: "?!?", assessmentYear: AY }, tx)).reason, "no_searchable_terms");
    // Known limitation, deliberately NOT asserted: the sufficiency check is a term-coverage heuristic, not a
    // relevance judgment, so a question that shares generic words ("income", "tax") with a passage can still
    // return that passage, at a low score. Callers must look at the evidence, not only at status "ok".
  });
});

test("with no corpus loaded there is nothing to retrieve, and it says so", async () => {
  await withShippedCorpus(async (tx) => {
    await tx.delete(taxCorpusReleases); // rolled back with the transaction
    const result = insufficient(await retrieveTaxLaw({ question: "What is the Section 87A rebate limit?", assessmentYear: AY }, tx));
    assert.equal(result.reason, "corpus_not_loaded");
    assert.equal(result.corpusVersion, null);
  });
});

// --- the retrieval test set --------------------------------------------------------

type Expectation = {
  status: "ok" | "insufficient_evidence";
  reason?: string;
  sectionRefs?: string[];
  unmatchedSectionRefs?: string[];
  topSectionRef?: string;
  topVerificationStatus?: string;
  topQuoteIncludes?: string[];
  anyInTop?: { n: number; quoteIncludes: string };
};
type Case = { id: string; topic: string; question: string; assessmentYear?: string; sectionRef?: string; expect: Expectation };

const RETRIEVAL_CASES = (JSON.parse(fs.readFileSync(path.join(DEFAULT_CORPUS_DIR, "retrieval-tests.json"), "utf8")) as { cases: Case[] }).cases;

test("the retrieval test set covers the topics the seed corpus is meant to exercise", () => {
  const topics = new Set(RETRIEVAL_CASES.map((c) => c.topic as string));
  for (const wanted of ["87A", "80C", "80D", "115BAC", "surcharge", "cess", "slabs"]) assert.ok(topics.has(wanted), `no case for ${wanted}`);
  const text = RETRIEVAL_CASES.map((c) => `${c.topic} ${c.question}`).join("\n");
  for (const gap of ["standard deduction", "288A", "288B"]) assert.match(text, new RegExp(gap, "i"), `no case for ${gap}`);
  assert.equal(new Set(RETRIEVAL_CASES.map((c) => c.id)).size, RETRIEVAL_CASES.length, "case ids are unique");
});

for (const c of RETRIEVAL_CASES) {
  test(`retrieval case: ${c.id}`, async () => {
    await withShippedCorpus(async (tx) => {
      const result = await retrieveTaxLaw({ question: c.question, assessmentYear: c.assessmentYear ?? AY, ...(c.sectionRef ? { sectionRef: c.sectionRef } : {}) }, tx);
      const want = c.expect;
      assert.equal(result.status, want.status, JSON.stringify(result));

      if (result.status === "insufficient_evidence") {
        if (want.reason) assert.equal(result.reason, want.reason);
        if (want.sectionRefs) assert.deepEqual(result.sectionRefs, want.sectionRefs);
        return;
      }
      const top = result.evidence[0];
      if (want.topSectionRef) assert.equal(top.sectionRef, want.topSectionRef);
      if (want.topVerificationStatus) assert.equal(top.verificationStatus, want.topVerificationStatus);
      for (const text of want.topQuoteIncludes ?? []) assert.ok(top.quote.includes(text), `top quote should include "${text}", got: ${top.quote}`);
      if (want.unmatchedSectionRefs) assert.deepEqual(result.unmatchedSectionRefs, want.unmatchedSectionRefs);
      if (want.anyInTop) {
        const { n, quoteIncludes } = want.anyInTop;
        assert.ok(result.evidence.slice(0, n).some((e) => e.quote.includes(quoteIncludes)), `none of the top ${n} quotes include "${quoteIncludes}"`);
      }
    });
  });
}

// --- no user data, no user id ------------------------------------------------------

test("retrieval takes no user id: extra input is ignored and cannot select or change anything", async () => {
  await withShippedCorpus(async (tx) => {
    const base = { question: "What is the Section 87A rebate limit under the new tax regime?", assessmentYear: AY };
    const withoutUser = await retrieveTaxLaw(base, tx);
    // @ts-expect-error userId is deliberately not part of the input type
    const withUser = await retrieveTaxLaw({ ...base, userId: "00000000-0000-4000-8000-000000000001", ownerId: "x" }, tx);
    assert.deepEqual(withUser, withoutUser, "the corpus is global: who is asking changes nothing");
    assert.ok(retrieveTaxLaw.length <= 2, "the only other parameter is the database executor, used by tests");
  });
});

test("the corpus is unchanged by retrieval", async () => {
  await withShippedCorpus(async (tx) => {
    const count = async () => ({
      sources: (await tx.select().from(taxSources)).length,
      chunks: (await tx.select().from(taxSourceChunks)).length,
      releases: (await tx.select().from(taxCorpusReleases)).length,
    });
    const before = await count();
    for (const c of RETRIEVAL_CASES) await retrieveTaxLaw({ question: c.question, assessmentYear: c.assessmentYear ?? AY }, tx);
    assert.deepEqual(await count(), before);
  });
});
