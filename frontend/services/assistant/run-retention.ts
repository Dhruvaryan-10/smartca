// RETENTION of the assistant run audit (assistant_runs, docs/decisions/0003): the one place that deletes run rows. Server-side only; run by
// the operator's scheduled job (scripts/assistant-purge-runs.ts), never by a request.
//
// The policy:
//   - a run row is kept for ASSISTANT_RUN_RETENTION_DAYS after it STARTED, then deleted, whatever its outcome. Rows hold metadata only
//     (codes, counts, names of tools and classes, token counts, times), never a message, answer, argument, result or credential.
//   - the retention floor (one day) is at least the longest limit window, and far longer than any stale bound, so a deleted row can never
//     be one that a limit still counts: the per-user and global limits are unchanged by the job.
//   - consent rows (assistant_authorizations) are NOT deleted here. They are the record that a person agreed, kept for the life of the
//     account (a user's deletion cascades to both tables). Deleting an old revoked grant could also let an older, still-valid grant decide
//     again (the latest grant decides: authorization-store.ts), which would silently restore withdrawn consent.
// Time is always passed in, so the job is deterministic and testable.
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { assistantRuns } from "@/db/schema";
import { AssistantConfigError, RUN_RETENTION_DAYS_BOUNDS } from "./config";

const DAY_MS = 86_400_000;
export const DEFAULT_PURGE_BATCH = 1_000;

/** Delete every run row that started more than `retentionDays` before `now`, in batches. Returns how many were deleted (a count only). */
export async function purgeExpiredAssistantRuns(options: { now: Date; retentionDays: number; batchSize?: number }): Promise<{ deletedRuns: number; cutoff: Date }> {
  const { now, retentionDays } = options;
  const batchSize = options.batchSize ?? DEFAULT_PURGE_BATCH;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new RangeError("A time must be passed in as a valid Date.");
  if (!Number.isSafeInteger(retentionDays) || retentionDays < RUN_RETENTION_DAYS_BOUNDS.min || retentionDays > RUN_RETENTION_DAYS_BOUNDS.max) {
    throw new AssistantConfigError("invalid_configuration", ["ASSISTANT_RUN_RETENTION_DAYS"]);
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100_000) throw new RangeError("batchSize must be a whole number from 1 to 100000.");

  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  let deletedRuns = 0;
  for (;;) {
    // One bounded batch per statement, so a large backlog never holds one long lock.
    const result = await db.execute(sql`
      delete from ${assistantRuns}
      where ${assistantRuns.id} in (
        select ${assistantRuns.id} from ${assistantRuns} where ${assistantRuns.startedAt} < ${cutoff} limit ${batchSize}
      )`);
    const deleted = result.rowCount ?? 0;
    deletedRuns += deleted;
    if (deleted < batchSize) break;
  }
  return { deletedRuns, cutoff };
}
