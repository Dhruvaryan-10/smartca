// The database side of the RAG evaluation: real retrieval, the lookup of stored passages behind returned evidence, and a
// preflight that the database holds the same corpus the dataset was written against.
//
// READ ONLY. Every statement here is a SELECT. The evaluation reads the corpus tables and changes nothing; it cannot
// ingest, and it never fetches anything. It is used by scripts/rag-eval.ts and by tests, not by any request handler.
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { db } from "../../db/client";
import { retrieveTaxLaw } from "../../services/tax-retrieval";
import type { Corpus } from "../rag/corpus";
import type { EvalDeps } from "./run";
import type { ChunkInfo } from "./score";

type SqlExecutor = Pick<typeof db, "execute">;

const uuidArray = (ids: string[]): SQL => sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;

type ChunkRow = { chunk_id: string; source_key: string; chunk_index: number; heading_path: string[]; text: string };

export function makeDbDeps(executor: SqlExecutor): EvalDeps {
  return {
    retrieve: (input) => retrieveTaxLaw(input, executor),
    lookupChunks: async (chunkIds) => {
      const found = new Map<string, ChunkInfo>();
      if (chunkIds.length === 0) return found;
      const rows = (
        await executor.execute<ChunkRow>(sql`
          SELECT c.id::text AS chunk_id, s.source_key, c.chunk_index, c.heading_path, c."text" AS text
          FROM tax_source_chunks c
          JOIN tax_sources s ON s.id = c.source_id
          WHERE c.id = ANY(${uuidArray([...new Set(chunkIds)])})
        `)
      ).rows;
      for (const row of rows) found.set(row.chunk_id, { sourceKey: row.source_key, headingPath: row.heading_path, chunkIndex: row.chunk_index, text: row.text });
      return found;
    },
  };
}

type ReleaseRow = { version: string; manifest_sha256: string };
type StoredChunkRow = { source_key: string; status: string; chunk_index: number | null; text_sha256: string | null };

/**
 * Every way the database's corpus differs from the shipped corpus, or an empty list when they are the same. The
 * evaluation is only meaningful against the corpus its gold evidence was written for, so the CLI refuses to run
 * otherwise (the fix is `npm run rag:ingest`).
 */
export async function checkDatabaseMatchesCorpus(executor: SqlExecutor, corpus: Corpus): Promise<string[]> {
  const issues: string[] = [];

  const release = (await executor.execute<ReleaseRow>(sql`SELECT version, manifest_sha256 FROM tax_corpus_releases ORDER BY created_at DESC, id DESC LIMIT 1`)).rows[0];
  if (!release) return ["the database holds no corpus release."];
  if (release.version !== corpus.version) issues.push(`the database's latest corpus release is ${release.version}, but the shipped corpus is ${corpus.version}.`);
  else if (release.manifest_sha256 !== corpus.manifestSha256) issues.push(`the database's release ${release.version} has a different manifest hash from the shipped corpus.`);

  const rows = (
    await executor.execute<StoredChunkRow>(sql`
      SELECT s.source_key, s.status::text AS status, c.chunk_index, c.text_sha256
      FROM tax_sources s
      LEFT JOIN tax_source_chunks c ON c.source_id = s.id
      WHERE s.assessment_year = ${corpus.assessmentYear}
    `)
  ).rows;
  const stored = new Map<string, { status: string; chunks: Map<number, string> }>();
  for (const row of rows) {
    const entry = stored.get(row.source_key) ?? { status: row.status, chunks: new Map<number, string>() };
    if (row.chunk_index !== null && row.text_sha256 !== null) entry.chunks.set(row.chunk_index, row.text_sha256);
    stored.set(row.source_key, entry);
  }

  for (const source of corpus.sources) {
    const entry = stored.get(source.sourceKey);
    if (!entry) {
      issues.push(`source ${source.sourceKey} is not in the database.`);
      continue;
    }
    if (entry.status !== source.status) issues.push(`source ${source.sourceKey} is ${entry.status} in the database but ${source.status} in the shipped corpus.`);
    if (entry.chunks.size !== source.chunks.length) issues.push(`source ${source.sourceKey} has ${entry.chunks.size} chunks in the database but ${source.chunks.length} in the shipped corpus.`);
    for (const chunk of source.chunks) {
      if (entry.chunks.get(chunk.chunkIndex) !== chunk.textSha256) issues.push(`chunk ${chunk.chunkIndex} of source ${source.sourceKey} differs from the shipped corpus.`);
    }
  }
  for (const [key, entry] of stored) {
    if (entry.status === "active" && !corpus.sources.some((s) => s.sourceKey === key)) issues.push(`the database has an active source (${key}) that is not in the shipped corpus.`);
  }
  return issues;
}
