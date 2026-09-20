// Test helpers for the tax-law corpus (Phase 5A). Not a test file: the test
// glob only runs *.test.ts.
//
// The corpus tables are GLOBAL, so tests must never leave rows in them. Every
// database-backed test runs inside a transaction that is always rolled back
// (`inRolledBackTransaction`), and fixtures use nonsense words ("zorblax",
// "quindle", "flumbrick") that appear nowhere in the real corpus, so a
// fixture can only ever match another fixture.
import { db } from "../db/client";
import { taxCorpusReleases, taxSourceChunks, taxSources } from "../db/schema";
import { GOVERNING_ACT_1961, sha256Text } from "../lib/rag/corpus";
import type { AuthorityTier, SourceStatus } from "../lib/rag/corpus";

export { FIXTURE_TEXT, fixtureCorpusInput } from "./helpers-corpus";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

class Rollback extends Error {}

/** Runs `work` in a transaction and ALWAYS rolls it back, returning what `work` returned. */
export async function inRolledBackTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await db.transaction(async (tx) => {
      result = await work(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return result as T;
}

// ---------------------------------------------------------------------
// Direct fixture rows (for retrieval tests that need exact control)
// ---------------------------------------------------------------------

export async function insertFixtureRelease(tx: Tx, version = "fixture-release-v1") {
  await tx.insert(taxCorpusReleases).values({ version, manifestSha256: sha256Text(`fixture|${version}`) }).onConflictDoNothing();
}

export async function insertFixtureSource(
  tx: Tx,
  spec: {
    sourceKey: string;
    tier?: AuthorityTier;
    assessmentYear?: string;
    status?: SourceStatus;
    chunks: Array<{ text: string; sectionRef?: string | null; verificationStatus?: "primary_verified" | "engine_not_modelled" }>;
  },
) {
  const [source] = await tx
    .insert(taxSources)
    .values({
      sourceKey: spec.sourceKey,
      title: `Fixture ${spec.sourceKey}`,
      publisher: "Fixture Department",
      url: "https://fixture.gov.in/x",
      authorityTier: spec.tier ?? "official_guidance",
      governingAct: GOVERNING_ACT_1961,
      assessmentYear: spec.assessmentYear ?? "2026-27",
      sourceDate: null,
      effectiveFrom: null,
      effectiveTo: null,
      retrievedAt: new Date("2026-09-19T00:00:00Z"),
      contentSha256: sha256Text(spec.sourceKey),
      status: spec.status ?? "active",
    })
    .returning({ id: taxSources.id });

  let offset = 0;
  for (const [index, chunk] of spec.chunks.entries()) {
    await tx.insert(taxSourceChunks).values({
      sourceId: source.id,
      chunkIndex: index,
      sectionRef: chunk.sectionRef ?? null,
      headingPath: ["Fixture"],
      text: chunk.text,
      textSha256: sha256Text(chunk.text),
      charStart: offset,
      charEnd: offset + chunk.text.length,
      regime: "both",
      topics: [],
      verificationStatus: chunk.verificationStatus ?? "primary_verified",
    });
    offset += chunk.text.length + 1;
  }
  return source.id;
}
