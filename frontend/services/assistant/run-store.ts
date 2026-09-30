// The AUDIT RECORD of assistant runs, and the PostgreSQL implementation of the RunLimiter (lib/assistant/run-limits.ts). Server-side only;
// every function takes the userId from the server session and every per-user query is filtered by it.
//
// Audit: one assistant_runs row per attempt by a signed-in person, METADATA ONLY: who, when, which mode, profile, recipient, model and
// authorization, which tools and data classes the run was allowed, what it called, counts, tokens, timing, and the outcome as codes.
// Never a message, an answer, a tool argument, a tool result, a key or an error's text.
//
// Limits: the counters ARE these rows, so there is no second store to drift from the audit, and no external service (such as Redis) to
// run. A run may start only if every limit allows it. The check and the insert of the new "running" row happen in ONE transaction that
// holds two PostgreSQL advisory locks, always taken in the same order (so they cannot deadlock): first the global lock of this mode, then
// the person's. The global lock makes the system-wide concurrency cap exact: two acquires on any number of server instances cannot both
// pass it, whoever they are for. It is held only for the check and one insert, never while a run executes. If anything in that
// transaction fails, it rolls back and no slot exists.
// Every attempt counts toward the window, refused ones included. Time is always passed in (never the database's or the process's own
// clock), so the behaviour is deterministic: a run started at `at` counts in every window that contains `at`; a "running" row older
// than `staleAfterMs` (a run that died without finishing) no longer counts as in progress.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { assistantRuns } from "@/db/schema";
import { AssistantRateLimitError, exceededRunLimit, isCompleteRunLimits } from "@/lib/assistant/run-limits";
import type { RunLimiter, RunLimits, RunOutcome, RunUsage } from "@/lib/assistant/run-limits";
import { toAssistantApiError } from "./api-contract";
import { ASSISTANT_LIMIT_ENV_NAMES, AssistantConfigError } from "./config";
import { NotAuthenticatedError } from "../errors";

export type RunMode = "synthetic" | "external";
export type { RunOutcome };

/** What the access plan decided, recorded once the run is authorized. Identifiers, names and classes only. */
export type RunPlanRecord = {
  authorizationId: string;
  profileId: string;
  recipient: string;
  modelId: string;
  allowedTools: readonly string[];
  visibleClasses: readonly string[];
  inventoryVersion: string;
};

const requireUser = (userId: unknown): string => {
  if (typeof userId !== "string" || userId.trim() === "") throw new NotAuthenticatedError();
  return userId;
};
const requireTime = (at: unknown): Date => {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new RangeError("A time must be passed in as a valid Date.");
  return at;
};

/**
 * How long past its run budget a "running" row still counts as in progress, before it is treated as a run that died without finishing.
 * The budget itself comes from the configuration (timeout x model rounds); this grace only covers the release write after the run ends.
 */
export const STALE_RUN_GRACE_MS = 60_000;

/**
 * What this person is using at `at`: runs started in the window, runs in progress, and tokens used in the window; and how many runs of
 * this mode are in progress across everyone (started in (at - staleAfterMs, at], so a run is in progress from its start until it is
 * released or goes stale). The global count is read through the partial index on running rows, so it stays small.
 */
async function usageAt(tx: Pick<typeof db, "execute">, userId: string, mode: RunMode, at: Date, limits: RunLimits, staleAfterMs: number): Promise<RunUsage> {
  const windowStart = new Date(at.getTime() - limits.windowSeconds * 1000);
  const staleBefore = new Date(at.getTime() - staleAfterMs);
  // Only rows that can still count are read: both filters below need started_at after the earlier of the two bounds, so this range on
  // (user_id, started_at) changes no count, and the cost of a check stays bounded by the window however long the audit history grows.
  const oldest = windowStart < staleBefore ? windowStart : staleBefore;
  const result = await tx.execute(sql`
    select
      count(*) filter (where ${assistantRuns.startedAt} > ${windowStart})::int as runs_in_window,
      count(*) filter (where ${assistantRuns.status} = 'running' and ${assistantRuns.startedAt} > ${staleBefore})::int as runs_in_progress,
      coalesce(sum(coalesce(${assistantRuns.inputTokens}, 0) + coalesce(${assistantRuns.outputTokens}, 0))
        filter (where ${assistantRuns.startedAt} > ${windowStart}), 0)::bigint as tokens_in_window
    from ${assistantRuns}
    where ${assistantRuns.userId} = ${userId} and ${assistantRuns.startedAt} > ${oldest}`);
  const row = result.rows[0] as { runs_in_window: number; runs_in_progress: number; tokens_in_window: string | number };
  const global = await tx.execute(sql`
    select count(*)::int as global_in_progress
    from ${assistantRuns}
    where ${assistantRuns.status} = 'running' and ${assistantRuns.mode} = ${mode}
      and ${assistantRuns.startedAt} > ${staleBefore} and ${assistantRuns.startedAt} <= ${at}`);
  const globalRow = global.rows[0] as { global_in_progress: number };
  return {
    runsInWindow: Number(row.runs_in_window),
    runsInProgress: Number(row.runs_in_progress),
    tokensInWindow: Number(row.tokens_in_window),
    globalRunsInProgress: Number(globalRow.global_in_progress),
  };
}

/**
 * The PostgreSQL RunLimiter. It refuses to exist without a complete set of limits (fail closed): a missing or malformed limit is an
 * AssistantConfigError naming the variables, never a silent default.
 */
export function createPostgresRunLimiter(limits: unknown, options: { mode: RunMode; staleAfterMs: number }): RunLimiter {
  if (!isCompleteRunLimits(limits)) {
    throw new AssistantConfigError("invalid_configuration", [...ASSISTANT_LIMIT_ENV_NAMES]);
  }
  if (!Number.isSafeInteger(options.staleAfterMs) || options.staleAfterMs < 1) throw new RangeError("staleAfterMs must be a whole number of milliseconds.");
  const checked: RunLimits = Object.freeze({ ...limits });

  return Object.freeze({
    async acquire(userId: string, at: Date): Promise<string> {
      const owner = requireUser(userId);
      const when = requireTime(at);
      const decision = await db.transaction(async (tx) => {
        // Both held until the transaction ends, and always taken in this order. The global lock serialises every acquire of this mode on
        // every instance (the check and one insert: milliseconds); the person's lock is kept so that per-user exclusion never depends on it.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant_runs:global:${options.mode}`}))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant_runs:${owner}`}))`);
        const exceeded = exceededRunLimit(await usageAt(tx, owner, options.mode, when, checked, options.staleAfterMs), checked);
        const [row] = await tx
          .insert(assistantRuns)
          .values(
            exceeded === null
              ? { userId: owner, mode: options.mode, status: "running", startedAt: when }
              : {
                  userId: owner, mode: options.mode, status: "rejected", startedAt: when, finishedAt: when, durationMs: 0,
                  resultCode: toAssistantApiError(new AssistantRateLimitError(exceeded)).code, failureKind: `AssistantRateLimitError:${exceeded}`,
                },
          )
          .returning({ id: assistantRuns.id });
        return { runId: row.id, exceeded };
      });
      if (decision.exceeded !== null) throw new AssistantRateLimitError(decision.exceeded);
      return decision.runId;
    },

    // Only a run that is still "running" is closed, so a second release (or a release of someone else's run) changes nothing.
    async release(runId: string, userId: string, outcome: RunOutcome): Promise<void> {
      const owner = requireUser(userId);
      await db
        .update(assistantRuns)
        .set({
          status: outcome.status,
          resultCode: outcome.resultCode,
          failureKind: outcome.failureKind,
          answerState: outcome.answerState,
          modelCalls: outcome.modelCalls,
          toolCalls: outcome.toolCalls,
          toolRefusals: outcome.toolRefusals,
          toolsCalled: [...outcome.toolsCalled],
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          finishedAt: requireTime(outcome.finishedAt),
          durationMs: Math.max(0, Math.round(outcome.durationMs)),
        })
        .where(and(eq(assistantRuns.id, runId), eq(assistantRuns.userId, owner), eq(assistantRuns.status, "running")));
    },
  });
}

/** Record an attempt refused before it could start (no consent, a bad request, a misconfigured assistant...), at `at`. */
export async function recordRejectedRun(
  userId: string,
  rejection: { mode: RunMode; resultCode: string; failureKind: string; at: Date; authorizationId?: string | null },
): Promise<string> {
  const owner = requireUser(userId);
  const when = requireTime(rejection.at);
  const [row] = await db
    .insert(assistantRuns)
    .values({
      userId: owner,
      mode: rejection.mode,
      status: "rejected",
      resultCode: rejection.resultCode,
      failureKind: rejection.failureKind,
      authorizationId: rejection.authorizationId ?? null,
      startedAt: when,
      finishedAt: when,
      durationMs: 0,
    })
    .returning({ id: assistantRuns.id });
  return row.id;
}

/** Record what the access plan allowed, once the run is authorized and before the model is called. */
export async function recordRunPlan(runId: string, userId: string, plan: RunPlanRecord): Promise<void> {
  const owner = requireUser(userId);
  await db
    .update(assistantRuns)
    .set({
      authorizationId: plan.authorizationId,
      profileId: plan.profileId,
      recipient: plan.recipient,
      modelId: plan.modelId,
      allowedTools: [...plan.allowedTools],
      visibleClasses: [...plan.visibleClasses],
      inventoryVersion: plan.inventoryVersion,
    })
    .where(and(eq(assistantRuns.id, runId), eq(assistantRuns.userId, owner)));
}
