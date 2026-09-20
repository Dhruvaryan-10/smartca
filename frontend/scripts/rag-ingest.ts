// Ingest the curated tax-law corpus (rag-corpus/ay-2026-27/) into PostgreSQL.
//
//   npm run rag:ingest            validate, then write the corpus (idempotent)
//   npm run rag:ingest -- --check validate only; touches no database
//
// This is a MANUAL, developer-run script. It reads committed local files and
// never fetches anything from the internet. It is deliberately not reachable
// from any API route: the corpus is global, read-only reference data for
// request handlers, and only this script writes it.
//
// Running it twice leaves the database in the same logical state.
import "../db/load-env";
import { loadCorpusFromDisk } from "../lib/rag/load-corpus";
import { CorpusValidationError } from "../lib/rag/corpus";

async function main() {
  const checkOnly = process.argv.includes("--check");
  const corpus = loadCorpusFromDisk();

  console.log(`Corpus ${corpus.version} (${corpus.governingAct}, AY ${corpus.assessmentYear}); manifest ${corpus.manifestSha256.slice(0, 16)}…`);
  for (const source of corpus.sources) {
    console.log(`  ${source.sourceKey}: ${source.chunks.length} chunks, ${source.authorityTier}, content ${source.contentSha256.slice(0, 12)}…`);
  }
  for (const gap of corpus.knownGaps) console.log(`  gap: Section ${gap.sectionRef} (${gap.title}) is not in the corpus`);

  if (checkOnly) {
    console.log("Corpus is valid. Nothing was written (--check).");
    return;
  }

  // Imported only now, so `--check` needs no database configuration.
  const { ingestTaxCorpus } = await import("../services/tax-corpus");
  const summary = await ingestTaxCorpus(corpus);
  console.log(
    `Ingested. Sources: ${summary.sources.created} created, ${summary.sources.updated} updated, ` +
      `${summary.sources.unchanged} unchanged, ${summary.sources.withdrawn} withdrawn. Chunks in corpus: ${summary.chunks}. ` +
      `Release ${summary.releaseCreated ? "recorded" : "already recorded"}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    if (error instanceof CorpusValidationError) console.error(error.message);
    else console.error("Ingestion failed:", error);
    process.exit(1);
  });
