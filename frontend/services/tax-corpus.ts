// Tax-law corpus ingestion: writes a validated Corpus (lib/rag/corpus.ts) into
// the tax_sources / tax_source_chunks / tax_corpus_releases tables.
//
// THIS IS NOT A REQUEST-HANDLER SERVICE. It is imported by
// scripts/rag-ingest.ts and by tests, and by nothing under app/. Request
// handlers only read the corpus (services/tax-retrieval.ts); a test pins that
// nothing under app/api can reach this module.
//
// Idempotent: ingesting the same corpus again changes nothing. Sources are
// upserted on their stable key, chunks on (source, chunk index), and a chunk
// or source whose content is unchanged is not rewritten, so row ids are
// stable across runs. The whole ingestion is one transaction.
//
// A corpus version is immutable: the same version with a different manifest
// is refused, so a release always means exactly one set of sources.
//
// The corpus contains only public, authoritative text, so errors here are not
// sanitised the way request-path errors are; a developer running the script
// needs the real message.
import { and, eq, gte, notInArray } from "drizzle-orm";
import { db } from "@/db/client";
import { taxCorpusReleases, taxSourceChunks, taxSources } from "@/db/schema";
import { canonicalJson } from "@/lib/rag/corpus";
import type { Corpus, CorpusChunk, CorpusSource } from "@/lib/rag/corpus";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type IngestSummary = {
  corpusVersion: string;
  manifestSha256: string;
  /** False when this exact release was already recorded. */
  releaseCreated: boolean;
  sources: { created: number; updated: number; unchanged: number; withdrawn: number };
  chunks: number;
};

const sourceValues = (source: CorpusSource) => ({
  sourceKey: source.sourceKey,
  title: source.title,
  publisher: source.publisher,
  url: source.url,
  authorityTier: source.authorityTier,
  governingAct: source.governingAct,
  assessmentYear: source.assessmentYear,
  sourceDate: source.sourceDate,
  effectiveFrom: source.effectiveFrom,
  effectiveTo: source.effectiveTo,
  retrievedAt: new Date(source.retrievedAt),
  contentSha256: source.contentSha256,
  status: source.status,
});

const chunkValues = (sourceId: string, chunk: CorpusChunk) => ({
  sourceId,
  chunkIndex: chunk.chunkIndex,
  sectionRef: chunk.sectionRef,
  headingPath: chunk.headingPath,
  text: chunk.text,
  textSha256: chunk.textSha256,
  charStart: chunk.charStart,
  charEnd: chunk.charEnd,
  regime: chunk.regime,
  topics: chunk.topics,
  verificationStatus: chunk.verificationStatus,
});

// Equal as data: dates compare as ISO strings and key order does not matter.
const same = (a: unknown, b: unknown) => canonicalJson(JSON.parse(JSON.stringify(a))) === canonicalJson(JSON.parse(JSON.stringify(b)));

/** A copy of the row without the named columns (its id, and the generated search vector, are not content). */
function without<T extends object>(row: T, ...keys: Array<keyof T>): Partial<T> {
  const copy = { ...row };
  for (const key of keys) delete copy[key];
  return copy;
}

async function ingestSource(tx: Tx, source: CorpusSource): Promise<"created" | "updated" | "unchanged"> {
  const [existing] = await tx.select().from(taxSources).where(eq(taxSources.sourceKey, source.sourceKey));
  const wanted = sourceValues(source);

  if (existing) {
    const stored = await tx.select().from(taxSourceChunks).where(eq(taxSourceChunks.sourceId, existing.id)).orderBy(taxSourceChunks.chunkIndex);
    const sourceSame = same(without(existing, "id"), wanted);
    const chunksSame = same(
      stored.map((chunk) => without(chunk, "id", "searchVector")),
      source.chunks.map((c) => chunkValues(existing.id, c)),
    );
    if (sourceSame && chunksSame) return "unchanged";
  }

  const [row] = await tx
    .insert(taxSources)
    .values(wanted)
    .onConflictDoUpdate({ target: taxSources.sourceKey, set: wanted })
    .returning({ id: taxSources.id });

  for (const chunk of source.chunks) {
    const values = chunkValues(row.id, chunk);
    await tx
      .insert(taxSourceChunks)
      .values(values)
      .onConflictDoUpdate({ target: [taxSourceChunks.sourceId, taxSourceChunks.chunkIndex], set: values });
  }
  // A source that now has fewer chunks must not keep the old tail.
  await tx.delete(taxSourceChunks).where(and(eq(taxSourceChunks.sourceId, row.id), gte(taxSourceChunks.chunkIndex, source.chunks.length)));

  return existing ? "updated" : "created";
}

async function run(tx: Tx, corpus: Corpus): Promise<IngestSummary> {
  // A version names one manifest for good.
  const [release] = await tx.select().from(taxCorpusReleases).where(eq(taxCorpusReleases.version, corpus.version));
  if (release && release.manifestSha256 !== corpus.manifestSha256) {
    throw new Error(`Corpus version "${corpus.version}" was already ingested with a different manifest. Change corpusVersion when the corpus changes.`);
  }

  const counts = { created: 0, updated: 0, unchanged: 0, withdrawn: 0 };
  for (const source of corpus.sources) counts[await ingestSource(tx, source)]++;

  // Sources for this assessment year that the manifest no longer lists are withdrawn, never deleted:
  // retrieval ignores them and the history stays.
  const withdrawn = await tx
    .update(taxSources)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(taxSources.assessmentYear, corpus.assessmentYear),
        eq(taxSources.status, "active"),
        notInArray(taxSources.sourceKey, corpus.sources.map((s) => s.sourceKey)),
      ),
    )
    .returning({ id: taxSources.id });
  counts.withdrawn = withdrawn.length;

  const [created] = await tx
    .insert(taxCorpusReleases)
    .values({ version: corpus.version, manifestSha256: corpus.manifestSha256 })
    .onConflictDoNothing({ target: taxCorpusReleases.version })
    .returning({ id: taxCorpusReleases.id });

  return {
    corpusVersion: corpus.version,
    manifestSha256: corpus.manifestSha256,
    releaseCreated: created !== undefined,
    sources: counts,
    chunks: corpus.sources.reduce((sum, s) => sum + s.chunks.length, 0),
  };
}

/** Ingest a corpus. Pass a transaction to run inside it (tests do, and roll it back); otherwise it opens its own. */
export async function ingestTaxCorpus(corpus: Corpus, executor?: Tx): Promise<IngestSummary> {
  return executor ? run(executor, corpus) : db.transaction((tx) => run(tx, corpus));
}
