// Seeds reference data that isn't part of the migration itself:
// the AY 2026-27 assessment year row. Idempotent — safe to re-run.
// Run with: npm run db:seed
import "./load-env";

import { db } from "./client";
import { assessmentYears } from "./schema";
import { sql } from "drizzle-orm";

async function main() {
  await db
    .insert(assessmentYears)
    .values({
      label: "2026-27",
      // AY 2026-27 corresponds to FY 2025-26 (India: 1 Apr 2025 – 31 Mar 2026).
      startDate: "2025-04-01",
      endDate: "2026-03-31",
    })
    .onConflictDoNothing({ target: assessmentYears.label });

  const rows = await db.execute(sql`select label, start_date, end_date from assessment_years order by label`);
  console.log("assessment_years now contains:", rows.rows);

  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
