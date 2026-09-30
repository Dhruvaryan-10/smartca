// Delete assistant run audit rows older than the configured retention (services/assistant/run-retention.ts, docs/decisions/0003).
//
//   npm run assistant:purge-runs
//
// An OPERATOR job, to be scheduled by the deployment (for example daily). It reads only ASSISTANT_RUN_RETENTION_DAYS (required; it fails
// closed without it) and DATABASE_URL, deletes run METADATA rows only, never consent rows, and prints counts only.
import "../db/load-env";
import { readRunRetentionDays } from "../services/assistant/config";
import { purgeExpiredAssistantRuns } from "../services/assistant/run-retention";

async function main() {
  const retentionDays = readRunRetentionDays(process.env);
  const { deletedRuns, cutoff } = await purgeExpiredAssistantRuns({ now: new Date(), retentionDays });
  console.log(`Deleted ${deletedRuns} assistant run rows that started before ${cutoff.toISOString()} (retention ${retentionDays} days).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // The error's class and message only: a configuration error names variables, never values.
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : "The purge failed.");
    process.exit(1);
  });
