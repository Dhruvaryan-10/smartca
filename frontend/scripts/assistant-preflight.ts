// Check that this deployment's environment and database are ready for the assistant's external mode, without enabling it
// (services/assistant/preflight.ts, docs/decisions/0004).
//
//   npm run assistant:preflight
//
// An OPERATOR check: it reads the environment (DATABASE_URL and every assistant variable), asks the database how many migrations are
// applied and whether the assistant tables exist, contacts no model provider, and prints check names, codes, counts and variable NAMES
// only, never a value. Exit code 0 when every check passes, 1 otherwise.
import "../db/load-env";
import fs from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { ASSISTANT_TABLES, runAssistantPreflight } from "../services/assistant/preflight";

async function probeDatabase() {
  const journal = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "drizzle", "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
  const applied = await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  const missingTables: string[] = [];
  for (const table of ASSISTANT_TABLES) {
    const found = await db.execute(sql`select to_regclass(${`public.${table}`}) is not null as present`);
    if (found.rows[0]?.present !== true) missingTables.push(table);
  }
  return { migrationsApplied: Number(applied.rows[0]?.n ?? 0), migrationsExpected: journal.entries.length, missingTables };
}

async function main() {
  const report = await runAssistantPreflight(process.env, probeDatabase);
  for (const check of report.checks) console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  console.log(report.ready ? "Ready: the configuration and database support external mode (still gated, see above)." : "Not ready.");
  return report.ready;
}

main()
  .then((ready) => process.exit(ready ? 0 : 1))
  .catch((err) => {
    // The class name only: nothing that could carry a value.
    console.error(err instanceof Error ? `${err.name}: the preflight could not run.` : "The preflight could not run.");
    process.exit(1);
  });
