// Tax-law corpus tests: normalisation and hashing, section references,
// deterministic chunking, manifest validation, and the shipped seed corpus.
// PURE: no database. (Ingestion and retrieval are in rag-ingest.test.ts and
// rag-retrieval.test.ts.)
//
// What must hold: the same source always hashes and chunks the same way, on
// any operating system; a chunk is an exact slice of its source; a manifest
// that mixes legislation, names a non-official host, or does not match its
// files is refused with every problem listed; and the shipped corpus is
// governed by the Income-tax Act, 1961, for AY 2026-27 only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORITY_TIERS,
  CorpusValidationError,
  GOVERNING_ACT_1961,
  MAX_CHUNK_CHARS,
  buildCorpus,
  canonicalJson,
  chunkSource,
  extractSectionRefs,
  normalizeSectionRef,
  normalizeSourceText,
  parseBlocks,
  sha256Text,
} from "../lib/rag/corpus";
import type { ManifestSection } from "../lib/rag/corpus";
import { loadCorpusFromDisk } from "../lib/rag/load-corpus";
import { FIXTURE_TEXT, fixtureCorpusInput } from "./helpers-corpus";

const rule = (heading: string, over: Partial<ManifestSection> = {}): ManifestSection => ({
  heading,
  sectionRef: null,
  regime: "both",
  topics: [],
  verificationStatus: "primary_verified",
  ...over,
});

const build = (options: Parameters<typeof fixtureCorpusInput>[0] = {}) => {
  const { manifest, read } = fixtureCorpusInput(options);
  return buildCorpus(manifest, read);
};
const issuesOf = (options: Parameters<typeof fixtureCorpusInput>[0]) => {
  try {
    build(options);
  } catch (error) {
    assert.ok(error instanceof CorpusValidationError, String(error));
    return error.issues.join("\n");
  }
  assert.fail("expected the corpus to be refused");
};

// --- hashing and normalisation ---------------------------------------------

test("source text is normalised before hashing, so line endings and a BOM never change a hash", () => {
  const lf = "# A\n\nBody line one\nBody line two\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const bom = "﻿" + lf;
  const noTrailingNewline = lf.trimEnd();
  const manyTrailingNewlines = lf + "\n\n\n";

  const expected = sha256Text(normalizeSourceText(lf));
  for (const variant of [crlf, bom, noTrailingNewline, manyTrailingNewlines, "# A\r\rBody"]) {
    assert.equal(normalizeSourceText(variant).includes("\r"), false);
  }
  assert.equal(sha256Text(normalizeSourceText(crlf)), expected, "CRLF (a Windows checkout) hashes the same");
  assert.equal(sha256Text(normalizeSourceText(bom)), expected);
  assert.equal(sha256Text(normalizeSourceText(noTrailingNewline)), expected);
  assert.equal(sha256Text(normalizeSourceText(manyTrailingNewlines)), expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
});

test("hashing is deterministic and sensitive to content", () => {
  assert.equal(sha256Text("abc"), sha256Text("abc"));
  assert.notEqual(sha256Text("abc"), sha256Text("abd"));
  // A known value pins the algorithm (SHA-256 of "abc").
  assert.equal(sha256Text("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("canonical JSON does not depend on key order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, 2], c: null } }), canonicalJson({ a: { c: null, d: [1, 2] }, b: 1 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }), "array order still matters");
});

// --- section references -----------------------------------------------------

test("a section reference has one canonical form", () => {
  assert.equal(normalizeSectionRef("87A"), "87A");
  assert.equal(normalizeSectionRef("87a"), "87A");
  assert.equal(normalizeSectionRef("Section 80 D"), "80D");
  assert.equal(normalizeSectionRef("u/s 115bac"), "115BAC");
  assert.equal(normalizeSectionRef("16(IA)"), "16(ia)");
  assert.equal(normalizeSectionRef("80CCD (1B)"), "80CCD(1b)");
  for (const bad of ["", "abc", "87A!", "Section", "12345A", "8 7 A x"]) assert.equal(normalizeSectionRef(bad), null, bad);
});

test("sections are found in a question, with or without a prefix, and units and ordinals are not sections", () => {
  assert.deepEqual(extractSectionRefs("What is the Section 87A rebate?"), ["87A"]);
  assert.deepEqual(extractSectionRefs("Compare 80C and 80D limits"), ["80C", "80D"]);
  assert.deepEqual(extractSectionRefs("Is u/s 115BAC the default? See section 16(ia) too"), ["115BAC", "16(ia)"]);
  assert.deepEqual(extractSectionRefs("How is it rounded under section 288A and 288B?"), ["288A", "288B"]);
  assert.deepEqual(extractSectionRefs("Surcharge on ₹50L or 2Cr income in the 1st and 2nd slab"), [], "lakh/crore shorthand and ordinals are not sections");
  assert.deepEqual(extractSectionRefs("What is the cess rate?"), []);
  assert.deepEqual(extractSectionRefs("87A rebate and again section 87A"), ["87A"], "each reference once");
});

// --- chunking ---------------------------------------------------------------

const normalized = normalizeSourceText(FIXTURE_TEXT);

test("headings are parsed into a hierarchy and bodies into blocks", () => {
  const { blocks, headings } = parseBlocks(normalizeSourceText("# Top\n\nintro\n\n## Mid\n\n### Deep\nbody\n\n## Mid two\nlast"));
  assert.deepEqual([...headings], ["Top", "Mid", "Deep", "Mid two"]);
  assert.deepEqual(blocks.map((b) => b.headingPath), [["Top"], ["Top", "Mid", "Deep"], ["Top", "Mid two"]]);
});

test("a chunk is an exact slice of its source, with correct offsets, a heading path and a hash", () => {
  const chunks = chunkSource(normalized, [rule("Zorblax rules", { sectionRef: "99Z", topics: ["fixture"] })]);
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.equal(normalized.slice(chunk.charStart, chunk.charEnd), chunk.text, "text is exactly the slice");
    assert.equal(chunk.textSha256, sha256Text(chunk.text));
    assert.ok(chunk.text === chunk.text.trim() && chunk.text.length > 0);
  }
  assert.deepEqual(chunks.map((c) => c.chunkIndex), [0, 1]);
  assert.deepEqual(chunks[0].headingPath, ["Fixture Source", "Zorblax rules"]);
  assert.deepEqual(chunks[1].headingPath, ["Fixture Source", "Second heading"]);
});

test("metadata comes from the manifest rule for the heading, and a chunk under no rule gets neutral defaults", () => {
  const chunks = chunkSource(normalized, [rule("Zorblax rules", { sectionRef: "99Z", regime: "old", topics: ["a", "b"], verificationStatus: "engine_not_modelled" })]);
  assert.equal(chunks[0].sectionRef, "99Z");
  assert.equal(chunks[0].regime, "old");
  assert.deepEqual(chunks[0].topics, ["a", "b"]);
  assert.equal(chunks[0].verificationStatus, "engine_not_modelled");
  assert.equal(chunks[1].sectionRef, null);
  assert.equal(chunks[1].regime, "both");
  assert.deepEqual(chunks[1].topics, []);
  assert.equal(chunks[1].verificationStatus, "primary_verified");
});

test("the deepest heading with a rule decides, and rules are inherited by deeper headings", () => {
  const text = normalizeSourceText("# Top\n\n## Outer\n\n### Inner\nbody\n");
  const outerOnly = chunkSource(text, [rule("Outer", { sectionRef: "10" })]);
  assert.equal(outerOnly[0].sectionRef, "10", "inherited from the ancestor heading");
  const both = chunkSource(text, [rule("Outer", { sectionRef: "10" }), rule("Inner", { sectionRef: "20" })]);
  assert.equal(both[0].sectionRef, "20", "the deeper rule wins");
});

test("chunking is deterministic, and long text is split without losing or changing any of it", () => {
  const paragraph = (n: number) => `Sentence number ${n} says something fairly ordinary about a rule. `.repeat(6).trim();
  const body = Array.from({ length: 12 }, (_, i) => paragraph(i)).join("\n\n");
  const longLine = "Word ".repeat(900).trim(); // a single 4,500-character line with no sentence ends
  const text = normalizeSourceText(`# Doc\n\n## Long\n${body}\n\n## Line\n${longLine}\n`);

  const once = chunkSource(text, []);
  const twice = chunkSource(text, []);
  assert.deepEqual(once, twice, "same input, same chunks");
  assert.ok(once.length > 4);
  for (const chunk of once) {
    assert.ok(chunk.text.length <= MAX_CHUNK_CHARS, `chunk ${chunk.chunkIndex} is ${chunk.text.length} characters`);
    assert.equal(text.slice(chunk.charStart, chunk.charEnd), chunk.text);
  }
  // Nothing is lost: the chunks of each block, with whitespace ignored, add up to the block's text.
  const squash = (s: string) => s.replace(/\s+/g, "");
  for (const heading of ["Long", "Line"]) {
    const joined = once.filter((c) => c.headingPath.at(-1) === heading).map((c) => c.text).join("");
    assert.equal(squash(joined), squash(heading === "Long" ? body : longLine));
  }
  // Offsets increase, so chunks are in document order and never overlap.
  for (let i = 1; i < once.length; i++) assert.ok(once[i].charStart >= once[i - 1].charEnd);
});

// --- manifest validation ----------------------------------------------------

test("a valid manifest builds a corpus with hashed sources and chunks", () => {
  const corpus = build();
  assert.equal(corpus.version, "fixture-corpus-v1");
  assert.equal(corpus.governingAct, GOVERNING_ACT_1961);
  assert.equal(corpus.assessmentYear, "2026-27");
  assert.equal(corpus.sources.length, 1);
  assert.equal(corpus.sources[0].contentSha256, sha256Text(normalized));
  assert.equal(corpus.sources[0].chunks.length, 2);
  assert.match(corpus.manifestSha256, /^[0-9a-f]{64}$/);
});

test("the manifest hash is deterministic, ignores key order, and changes when any reviewable thing changes", () => {
  const a = build();
  assert.equal(build().manifestSha256, a.manifestSha256);

  // Same content, keys written in another order.
  const input = fixtureCorpusInput();
  const reordered = Object.fromEntries(Object.entries(input.manifest).reverse());
  assert.equal(buildCorpus(reordered, input.read).manifestSha256, a.manifestSha256);

  const changedText = build({ text: FIXTURE_TEXT.replace("zorblax", "zorblax!") });
  assert.notEqual(changedText.manifestSha256, a.manifestSha256, "source text is part of the hash");
  assert.notEqual(build({ version: "fixture-corpus-v2" }).manifestSha256, a.manifestSha256, "so is the version");
  assert.notEqual(build({ sourceOverrides: { title: "Another title" } }).manifestSha256, a.manifestSha256, "and metadata");
});

test("a source read with Windows line endings builds the same corpus", () => {
  const input = fixtureCorpusInput();
  const crlf = buildCorpus(input.manifest, (file) => input.read(file).replace(/\n/g, "\r\n"));
  assert.equal(crlf.manifestSha256, build().manifestSha256);
  assert.deepEqual(crlf.sources[0].chunks, build().sources[0].chunks);
});

test("a manifest for the wrong legislation is refused: the Income-tax Act, 2025 must not be mixed into AY 2026-27", () => {
  for (const act of ["Income-tax Act, 2025", "Income Tax Act, 1961", "Income-tax Act, 1961 (as amended)", ""]) {
    assert.match(issuesOf({ governingAct: act }), /governingAct must be exactly "Income-tax Act, 1961"/, act || "(empty)");
  }
  assert.match(issuesOf({ governingAct: "Income-tax Act, 2025" }), /Income-tax Act, 2025 must not be mixed/);
});

test("only supported assessment years are accepted", () => {
  for (const year of ["2025-26", "2027-28", "2026", ""]) assert.match(issuesOf({ assessmentYear: year }), /assessmentYear must be one the tax engine supports/, year);
});

test("only official sources are accepted: a non-official host or an unknown tier is refused", () => {
  for (const url of ["http://fixture.gov.in/x", "https://example.com/tax", "https://taxblog.in/87a", "https://gov.in.evil.com/x", "not a url"]) {
    assert.match(issuesOf({ sourceOverrides: { url } }), /official host/, url);
  }
  for (const tier of ["secondary", "blog", "", "STATUTE"]) assert.match(issuesOf({ sourceOverrides: { authorityTier: tier } }), /authorityTier must be one of/, tier);
  for (const tier of AUTHORITY_TIERS) assert.doesNotThrow(() => build({ sourceOverrides: { authorityTier: tier } }), tier);
  assert.doesNotThrow(() => build({ sourceOverrides: { url: "https://www.indiacode.nic.in/x" } }));
});

test("a source file that does not match its pinned hash is refused", () => {
  const input = fixtureCorpusInput();
  const tampered = () => buildCorpus(input.manifest, (file) => input.read(file).replace("zorblax", "zorblaxx"));
  assert.throws(tampered, (e: unknown) => e instanceof CorpusValidationError && /sha256 does not match the file/.test(e.issues.join("\n")));
});

test("every problem is reported at once, not just the first", () => {
  const issues = issuesOf({
    governingAct: "Income-tax Act, 2025",
    assessmentYear: "2030-31",
    sourceOverrides: { url: "https://example.com/x", authorityTier: "blog", status: "gone", retrievedAt: "yesterday", sha256: "abc" },
  });
  for (const expected of ["governingAct", "assessmentYear", "official host", "authorityTier", "status", "retrievedAt", "sha256"]) assert.match(issues, new RegExp(expected));
});

test("bad section rules, duplicate sources, unknown fields and unreadable files are refused", () => {
  assert.match(issuesOf({ sections: [{ heading: "No such heading", sectionRef: null, regime: "both", topics: [], verificationStatus: "primary_verified" }] }), /no heading "No such heading"/);
  assert.match(issuesOf({ sections: [{ heading: "Zorblax rules", sectionRef: "not-a-section", regime: "both", topics: [], verificationStatus: "primary_verified" }] }), /sectionRef must be null or a section reference/);
  assert.match(issuesOf({ sections: [{ heading: "Zorblax rules", sectionRef: null, regime: "sideways", topics: [], verificationStatus: "primary_verified" }] }), /regime must be one of/);
  assert.match(issuesOf({ sections: [{ heading: "Zorblax rules", sectionRef: null, regime: "both", topics: [], verificationStatus: "verified?" }] }), /verificationStatus must be one of/);
  const dup = fixtureCorpusInput({ sourceKey: "same-key" }).manifest.sources[0];
  assert.match(issuesOf({ sourceKey: "same-key", extraSources: [dup] }), /duplicate sourceKey/);
  assert.match(issuesOf({ sourceOverrides: { surprise: true } }), /unknown field "surprise"/);
  assert.match(issuesOf({ manifestOverrides: { extra: 1 } }), /unknown field "extra"/);
  assert.match(issuesOf({ sourceOverrides: { file: "../../etc/passwd" } }), /file must be a path like sources\/name\.txt/);
  assert.match(issuesOf({ sourceOverrides: { sourceKey: "BAD KEY" } }), /sourceKey must be lower-case/);
  assert.match(issuesOf({ sourceOverrides: { effectiveFrom: "2026-05-01", effectiveTo: "2026-01-01" } }), /effectiveFrom is after effectiveTo/);
  assert.match(issuesOf({ sourceOverrides: { sourceDate: "2026-02-30" } }), /sourceDate must be null or a real/);
  assert.match(issuesOf({ manifestOverrides: { sources: [] } }), /sources must be a non-empty list/);
  assert.throws(() => buildCorpus(null, () => ""), CorpusValidationError);
  assert.throws(() => buildCorpus(fixtureCorpusInput().manifest, () => { throw new Error("boom"); }), (e: unknown) => e instanceof CorpusValidationError && /could not be read/.test(e.issues.join("\n")));
});

// --- the shipped corpus -----------------------------------------------------

test("the shipped AY 2026-27 corpus is valid, governed by the 1961 Act, and only for AY 2026-27", () => {
  const corpus = loadCorpusFromDisk(); // validates every field, hash and heading
  assert.equal(corpus.governingAct, "Income-tax Act, 1961");
  assert.equal(corpus.assessmentYear, "2026-27");
  assert.ok(corpus.sources.length >= 2);
  const haystack = corpus.sources.map((s) => `${s.text}\n${s.title}\n${s.governingAct}`).join("\n");
  assert.doesNotMatch(haystack, /Income[- ]tax Act,? 2025/i, "no text from the Income-tax Act, 2025 has been mixed in");
  for (const source of corpus.sources) {
    assert.equal(source.governingAct, "Income-tax Act, 1961");
    assert.equal(source.assessmentYear, "2026-27");
    assert.match(source.url, /^https:\/\/[^/]+\.(gov|nic)\.in\//);
    assert.ok(AUTHORITY_TIERS.includes(source.authorityTier));
    assert.equal(source.status, "active");
    assert.match(source.retrievedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.ok(source.chunks.length > 0);
    for (const chunk of source.chunks) {
      assert.equal(source.text.slice(chunk.charStart, chunk.charEnd), chunk.text, "every shipped chunk is an exact slice");
      assert.ok(chunk.text.length <= MAX_CHUNK_CHARS);
    }
  }
});

test("the shipped corpus covers the sections it claims to, and says plainly which it does not", () => {
  const corpus = loadCorpusFromDisk();
  const covered = new Set(corpus.sources.flatMap((s) => s.chunks.map((c) => c.sectionRef)).filter(Boolean));
  for (const ref of ["87A", "115BAC", "80C", "80D"]) assert.ok(covered.has(ref), `Section ${ref} is in the corpus`);

  const topics = new Set(corpus.sources.flatMap((s) => s.chunks.flatMap((c) => c.topics)));
  for (const topic of ["surcharge", "cess", "slabs", "rebate"]) assert.ok(topics.has(topic), `the ${topic} topic is in the corpus`);

  // Sections with no safely obtainable official source are listed as gaps, and are genuinely absent.
  const gaps = corpus.knownGaps.map((g) => g.sectionRef).sort();
  assert.deepEqual(gaps, ["16(ia)", "288A", "288B"]);
  for (const gap of gaps) assert.equal(covered.has(gap), false, `Section ${gap} is a known gap, so no chunk may claim it`);
  for (const gap of corpus.knownGaps) assert.match(gap.reason, /No official source could be safely obtained/);
});

test("the shipped source text is copied from the official page, not composed here", () => {
  const corpus = loadCorpusFromDisk();
  const text = corpus.sources.map((s) => s.text).join("\n");
  // Distinctive phrases from the Department's own wording (spot checks; the full text is reviewed in the repository).
  for (const phrase of [
    "Applicable Rebate u/s 87A of Income Tax Act,1961: Resident Individuals are also eligible for a Rebate of up to 100% of income tax",
    "Health & Education cess @ 4% to be paid on the amount of income tax plus Surcharge (if any) in both the regimes.",
    "Combined deduction limit of ₹ 1,50,000",
    "₹ 25,000 (₹ 50,000 if any person is a Senior Citizen)",
  ]) assert.ok(text.includes(phrase), phrase);
});
