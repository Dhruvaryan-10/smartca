// Tax-law corpus ingestion tests. DB-backed, and every test runs inside a
// transaction that is ALWAYS rolled back (tests/helpers-rag.ts), so nothing
// here can change the shared corpus tables.
//
// The contract: ingestion is idempotent (running it twice leaves the same
// logical state, with stable row ids); chunks are stored exactly as built,
// with their metadata; a corpus version is immutable; changed content updates
// in place and drops a stale tail; a source the manifest drops is withdrawn,
// never deleted; and the shipped corpus ingests cleanly.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { asc, eq } from "drizzle-orm";
import { taxCorpusReleases, taxSourceChunks, taxSources } from "../db/schema";
import { buildCorpus, sha256Text } from "../lib/rag/corpus";
import { loadCorpusFromDisk } from "../lib/rag/load-corpus";
import { ingestTaxCorpus } from "../services/tax-corpus";
import { FIXTURE_TEXT, fixtureCorpusInput, inRolledBackTransaction } from "./helpers-rag";
import type { Tx } from "./helpers-rag";

const fixture = (options: Parameters<typeof fixtureCorpusInput>[0] = {}) => {
  const { manifest, read } = fixtureCorpusInput(options);
  return buildCorpus(manifest, read);
};

/** Everything ingestion writes for the given source keys, in a stable order, ids included. */
async function snapshot(tx: Tx, sourceKeys: string[]) {
  const sources = (await tx.select().from(taxSources).orderBy(asc(taxSources.sourceKey))).filter((s) => sourceKeys.includes(s.sourceKey));
  const chunks = [];
  for (const source of sources) {
    const rows = await tx.select().from(taxSourceChunks).where(eq(taxSourceChunks.sourceId, source.id)).orderBy(asc(taxSourceChunks.chunkIndex));
    chunks.push(...rows);
  }
  const releases = await tx.select().from(taxCorpusReleases).orderBy(asc(taxCorpusReleases.version));
  return { sources, chunks, releases };
}

test("ingesting a corpus creates its sources, chunks and one release", async () => {
  await inRolledBackTransaction(async (tx) => {
    const corpus = fixture();
    const summary = await ingestTaxCorpus(corpus, tx);

    assert.deepEqual(summary.sources, { created: 1, updated: 0, unchanged: 0, withdrawn: summary.sources.withdrawn });
    assert.equal(summary.chunks, 2);
    assert.equal(summary.releaseCreated, true);
    assert.equal(summary.corpusVersion, "fixture-corpus-v1");

    const [release] = await tx.select().from(taxCorpusReleases).where(eq(taxCorpusReleases.version, "fixture-corpus-v1"));
    assert.equal(release.manifestSha256, corpus.manifestSha256);

    const [source] = await tx.select().from(taxSources).where(eq(taxSources.sourceKey, "fixture-source-zorblax"));
    assert.equal(source.governingAct, "Income-tax Act, 1961");
    assert.equal(source.assessmentYear, "2026-27");
    assert.equal(source.authorityTier, "official_guidance");
    assert.equal(source.status, "active");
    assert.equal(source.contentSha256, corpus.sources[0].contentSha256);
    assert.equal(source.retrievedAt.toISOString(), "2026-09-19T00:00:00.000Z");
    assert.equal(source.sourceDate, "2026-01-01");
  });
});

test("running ingestion twice leaves the same logical state, and the second run changes nothing", async () => {
  await inRolledBackTransaction(async (tx) => {
    const corpus = fixture();
    await ingestTaxCorpus(corpus, tx);
    const first = await snapshot(tx, ["fixture-source-zorblax"]);

    const again = await ingestTaxCorpus(corpus, tx);
    assert.deepEqual(again.sources, { created: 0, updated: 0, unchanged: 1, withdrawn: again.sources.withdrawn });
    assert.equal(again.releaseCreated, false, "the release is recorded once");

    const second = await snapshot(tx, ["fixture-source-zorblax"]);
    assert.deepEqual(second, first, "identical rows, including their ids: nothing was rewritten");
    assert.equal(second.chunks.length, 2);
  });
});

test("the shipped corpus ingests, twice, to the same state", async () => {
  await inRolledBackTransaction(async (tx) => {
    const corpus = loadCorpusFromDisk();
    const keys = corpus.sources.map((s) => s.sourceKey);

    await ingestTaxCorpus(corpus, tx);
    const first = await snapshot(tx, keys);
    const summary = await ingestTaxCorpus(corpus, tx);
    const second = await snapshot(tx, keys);

    assert.equal(summary.sources.created + summary.sources.updated, 0);
    assert.equal(summary.sources.unchanged, corpus.sources.length);
    assert.deepEqual(second, first);
    assert.equal(first.chunks.length, corpus.sources.reduce((n, s) => n + s.chunks.length, 0));
  });
});

test("chunks are stored exactly as built: text, hash, offsets, section reference, heading path and metadata", async () => {
  await inRolledBackTransaction(async (tx) => {
    const corpus = loadCorpusFromDisk();
    await ingestTaxCorpus(corpus, tx);

    for (const source of corpus.sources) {
      const [row] = await tx.select().from(taxSources).where(eq(taxSources.sourceKey, source.sourceKey));
      const stored = await tx.select().from(taxSourceChunks).where(eq(taxSourceChunks.sourceId, row.id)).orderBy(asc(taxSourceChunks.chunkIndex));
      assert.equal(stored.length, source.chunks.length);

      stored.forEach((chunk, i) => {
        const built = source.chunks[i];
        assert.equal(chunk.chunkIndex, i);
        assert.equal(chunk.text, built.text);
        assert.equal(chunk.textSha256, sha256Text(chunk.text));
        assert.equal(source.text.slice(chunk.charStart, chunk.charEnd), chunk.text, "the stored offsets point at the stored text");
        assert.equal(chunk.sectionRef, built.sectionRef);
        assert.deepEqual(chunk.headingPath, built.headingPath);
        assert.equal(chunk.regime, built.regime);
        assert.deepEqual(chunk.topics, built.topics);
        assert.equal(chunk.verificationStatus, built.verificationStatus);
        assert.ok(chunk.searchVector && chunk.searchVector.length > 0, "PostgreSQL generated the full-text vector");
      });
    }
  });
});

test("the shipped sections keep the metadata the manifest gave them", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(loadCorpusFromDisk(), tx);
    const rows = await tx.select().from(taxSourceChunks);
    const bySection = (ref: string) => rows.filter((r) => r.sectionRef === ref);

    const rebate = bySection("87A");
    assert.ok(rebate.length >= 1);
    assert.ok(rebate.every((r) => r.regime === "both" && r.topics.includes("rebate") && r.verificationStatus === "primary_verified"));

    const newRegimeDeductions = bySection("115BAC").filter((r) => r.regime === "new");
    assert.ok(newRegimeDeductions.length >= 1);
    assert.ok(newRegimeDeductions.every((r) => r.verificationStatus === "engine_not_modelled"), "provisions the engine does not model are flagged");

    assert.ok(bySection("80C").every((r) => r.regime === "old"));
    assert.ok(bySection("80D").every((r) => r.regime === "old"));
  });
});

test("a corpus version is immutable: the same version with a different manifest is refused", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(fixture(), tx);
    const changed = fixture({ text: FIXTURE_TEXT.replace("zorblax", "zorblax!") });
    await assert.rejects(() => ingestTaxCorpus(changed, tx), /already ingested with a different manifest/);
  });
});

test("changed content under a new version updates the source in place and drops the stale tail", async () => {
  await inRolledBackTransaction(async (tx) => {
    await ingestTaxCorpus(fixture(), tx);
    const [before] = await tx.select().from(taxSources).where(eq(taxSources.sourceKey, "fixture-source-zorblax"));
    const chunksBefore = await tx.select().from(taxSourceChunks).where(eq(taxSourceChunks.sourceId, before.id)).orderBy(asc(taxSourceChunks.chunkIndex));
    assert.equal(chunksBefore.length, 2);

    // Version 2 of the source has only its first passage, reworded.
    const shorter = "# Fixture Source\n\n## Zorblax rules\nQuindle flumbrick text about zorblax, revised.\n";
    const summary = await ingestTaxCorpus(fixture({ version: "fixture-corpus-v2", text: shorter }), tx);
    assert.equal(summary.sources.updated, 1);
    assert.equal(summary.releaseCreated, true);

    const [after] = await tx.select().from(taxSources).where(eq(taxSources.sourceKey, "fixture-source-zorblax"));
    assert.equal(after.id, before.id, "same source row");
    assert.notEqual(after.contentSha256, before.contentSha256);
    const chunksAfter = await tx.select().from(taxSourceChunks).where(eq(taxSourceChunks.sourceId, after.id)).orderBy(asc(taxSourceChunks.chunkIndex));
    assert.equal(chunksAfter.length, 1, "the second passage is gone");
    assert.equal(chunksAfter[0].id, chunksBefore[0].id, "the first passage kept its row");
    assert.match(chunksAfter[0].text, /revised/);

    const releases = await tx.select().from(taxCorpusReleases);
    assert.ok(releases.some((r) => r.version === "fixture-corpus-v1") && releases.some((r) => r.version === "fixture-corpus-v2"), "both releases are kept");
  });
});

test("a source the manifest no longer lists is withdrawn for that year, not deleted", async () => {
  await inRolledBackTransaction(async (tx) => {
    const other = fixtureCorpusInput({ sourceKey: "fixture-source-other", file: "sources/other.txt" });
    const withBoth = buildCorpus(
      { ...fixtureCorpusInput().manifest, sources: [fixtureCorpusInput().manifest.sources[0], other.manifest.sources[0]] },
      (file) => (file === "sources/other.txt" ? other.files[file] : fixtureCorpusInput().files[file]),
    );
    await ingestTaxCorpus(withBoth, tx);

    const summary = await ingestTaxCorpus(fixture({ version: "fixture-corpus-v2" }), tx);
    assert.ok(summary.sources.withdrawn >= 1);

    const [gone] = await tx.select().from(taxSources).where(eq(taxSources.sourceKey, "fixture-source-other"));
    assert.equal(gone.status, "withdrawn", "kept, but no longer retrievable");
    const chunks = await tx.select().from(taxSourceChunks).where(eq(taxSourceChunks.sourceId, gone.id));
    assert.ok(chunks.length > 0, "its chunks are still there");
    const [kept] = await tx.select().from(taxSources).where(eq(taxSources.sourceKey, "fixture-source-zorblax"));
    assert.equal(kept.status, "active");
  });
});
