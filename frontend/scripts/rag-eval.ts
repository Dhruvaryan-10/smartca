// Evaluate lexical tax-law retrieval against the RAG evaluation dataset (rag-evals/ay-2026-27-v1/).
//
//   npm run rag:eval                          human-readable report on stdout
//   npm run rag:eval -- --json out.json       also write the machine-readable result (use "-" for JSON only on stdout)
//   npm run rag:eval -- --split dev           only the dev split (this is the one to tune against)
//
// READ ONLY. It runs the real retrieval against the corpus already in the database, inside a read-only transaction,
// and writes nothing to the database. It first checks that the database holds the same corpus as the shipped
// rag-corpus/ (run `npm run rag:ingest` if it does not), and that the frozen test set is unchanged. It makes no network
// call and uses no model.
//
// It records a baseline. It sets no pass threshold and its exit code does not depend on the scores: it exits 1 only
// when the harness cannot run (invalid dataset, edited test set, corpus mismatch, database error).
import "../db/load-env";
import fs from "node:fs";
import { loadCorpusFromDisk } from "../lib/rag/load-corpus";
import { CorpusValidationError } from "../lib/rag/corpus";
import { EvalDatasetError, checkDatasetAgainstCorpus } from "../lib/rag-eval/dataset";
import { DEFAULT_EVAL_DIR, loadEvalDataset } from "../lib/rag-eval/load-dataset";
import { formatReport } from "../lib/rag-eval/report";
import { runEvaluation } from "../lib/rag-eval/run";

function option(name: string): string | null {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : null;
}

async function main() {
  const split = option("--split") ?? "all";
  if (split !== "all" && split !== "dev" && split !== "test") throw new Error('--split must be "dev", "test" or "all".');
  const jsonPath = option("--json");

  const dataset = loadEvalDataset(option("--dataset") ?? DEFAULT_EVAL_DIR);
  const corpus = loadCorpusFromDisk();
  const gold = checkDatasetAgainstCorpus(dataset, corpus);
  if (gold.length > 0) throw new EvalDatasetError(gold);

  // Imported only now, so a dataset problem is reported without needing a database.
  const { db } = await import("../db/client");
  const { sql } = await import("drizzle-orm");
  const { checkDatabaseMatchesCorpus, makeDbDeps } = await import("../lib/rag-eval/db-deps");

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const mismatches = await checkDatabaseMatchesCorpus(tx, corpus);
    if (mismatches.length > 0) throw new Error(`The database does not hold the shipped corpus:\n- ${mismatches.join("\n- ")}\nRun "npm run rag:ingest" and try again.`);
    return runEvaluation(dataset, corpus, makeDbDeps(tx), { split });
  });

  if (jsonPath === "-") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (jsonPath !== null) {
    fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(`Machine-readable result written to ${jsonPath}`);
  }
  console.log(formatReport(result));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    if (error instanceof EvalDatasetError || error instanceof CorpusValidationError) console.error(error.message);
    else console.error("Evaluation could not run:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
