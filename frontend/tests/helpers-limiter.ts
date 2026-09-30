// An IN-MEMORY RunLimiter for tests, and the limiter CONTRACT that every RunLimiter must satisfy. TEST-ONLY and PURE: it imports only
// lib/assistant/run-limits.ts (the hermetic test lists it as a pure helper). The in-memory limiter uses the same decision function
// (exceededRunLimit) and the same rules as the PostgreSQL limiter (services/assistant/run-store.ts): every attempt counts toward the
// window; a run counts as in progress (for its owner and for the global cap) from its start until released or until it is older than
// staleAfterMs; release closes only the owner's still-running run. It is atomic because it never awaits between reading usage and
// recording the attempt.
//
// LIMITER_CONTRACT is run against both implementations (assistant-run-limiter-contract.test.ts for memory, assistant-stores.db.test.ts
// for PostgreSQL), so the two are proven to behave the same.
import assert from "node:assert/strict";
import { AssistantRateLimitError, exceededRunLimit, isCompleteRunLimits } from "../lib/assistant/run-limits";
import type { RunLimiter, RunLimits, RunOutcome } from "../lib/assistant/run-limits";

type Row = { id: string; userId: string; status: "running" | "rejected" | "succeeded" | "failed"; startedAt: number; tokens: number };

export function createMemoryRunLimiter(limits: unknown, staleAfterMs: number): RunLimiter {
  if (!isCompleteRunLimits(limits)) throw new RangeError("incomplete limits");
  const rows: Row[] = [];
  let next = 0;
  return {
    async acquire(userId, at) {
      const now = at.getTime();
      if (!Number.isFinite(now)) throw new RangeError("invalid time");
      const own = rows.filter((r) => r.userId === userId);
      const live = (r: Row) => r.status === "running" && r.startedAt > now - staleAfterMs && r.startedAt <= now;
      const inWindow = own.filter((r) => r.startedAt > now - limits.windowSeconds * 1000);
      const exceeded = exceededRunLimit(
        {
          runsInWindow: inWindow.length,
          runsInProgress: own.filter((r) => r.status === "running" && r.startedAt > now - staleAfterMs).length,
          tokensInWindow: inWindow.reduce((sum, r) => sum + r.tokens, 0),
          globalRunsInProgress: rows.filter(live).length,
        },
        limits,
      );
      const id = `run-${++next}`;
      rows.push({ id, userId, status: exceeded === null ? "running" : "rejected", startedAt: now, tokens: 0 });
      if (exceeded !== null) throw new AssistantRateLimitError(exceeded);
      return id;
    },
    async release(runId, userId, outcome: RunOutcome) {
      if (!Number.isFinite(outcome.finishedAt.getTime())) throw new RangeError("invalid time");
      const row = rows.find((r) => r.id === runId && r.userId === userId && r.status === "running");
      if (row === undefined) return;
      row.status = outcome.status;
      row.tokens = (outcome.inputTokens ?? 0) + (outcome.outputTokens ?? 0);
    },
  };
}

export const CONTRACT_LIMITS: RunLimits = { windowSeconds: 600, maxRunsPerWindow: 3, maxConcurrentRuns: 1, maxTokensPerWindow: 1000, maxGlobalConcurrentRuns: 10 };
export const CONTRACT_STALE_MS = 60_000;

/** What each contract case gets: a limiter factory (with optional limit overrides), two distinct users, and a start time of its own. */
export type ContractContext = { make: (over?: Partial<RunLimits>) => RunLimiter; users: [string, string]; t: number };

const at = (t: number, seconds = 0) => new Date(t + seconds * 1000);
const done = (finishedAt: Date, tokens = 0, status: "succeeded" | "failed" = "succeeded"): RunOutcome => ({
  status, resultCode: null, failureKind: null, answerState: null, modelCalls: 1, toolCalls: 0, toolRefusals: 0, toolsCalled: [],
  inputTokens: tokens, outputTokens: 0, durationMs: 1, finishedAt,
});
const refused = (code: string) => (e: unknown) => e instanceof AssistantRateLimitError && e.code === code;

export const LIMITER_CONTRACT: Array<[string, (ctx: ContractContext) => Promise<void>]> = [
  ["the first request is admitted", async ({ make, users: [a], t }) => {
    assert.equal(typeof (await make().acquire(a, at(t))), "string");
  }],
  ["concurrency: a second run is refused while the first is in progress; release after success frees it", async ({ make, users: [a], t }) => {
    const l = make();
    const run = await l.acquire(a, at(t));
    await assert.rejects(l.acquire(a, at(t, 1)), refused("concurrent_runs"));
    await l.release(run, a, done(at(t, 2)));
    await l.acquire(a, at(t, 3));
  }],
  ["release after failure frees the slot too", async ({ make, users: [a], t }) => {
    const l = make();
    await l.release(await l.acquire(a, at(t)), a, done(at(t, 1), 0, "failed"));
    await l.acquire(a, at(t, 2));
  }],
  ["no negative concurrency: releasing twice frees one slot, not two", async ({ make, users: [a], t }) => {
    const l = make({ maxConcurrentRuns: 1, maxRunsPerWindow: 10 });
    const run = await l.acquire(a, at(t));
    await l.release(run, a, done(at(t, 1)));
    await l.release(run, a, done(at(t, 2)));
    await l.acquire(a, at(t, 3));
    await assert.rejects(l.acquire(a, at(t, 4)), refused("concurrent_runs"));
  }],
  ["simultaneous admissions: only the allowed number succeed", async ({ make, users: [a], t }) => {
    const l = make({ maxConcurrentRuns: 1, maxRunsPerWindow: 50 });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => l.acquire(a, at(t))));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.ok(results.filter((r) => r.status === "rejected").every((r) => refused("concurrent_runs")((r as PromiseRejectedResult).reason)));
  }],
  ["the request limit is enforced, and admits again once the window has passed", async ({ make, users: [a], t }) => {
    const l = make({ maxRunsPerWindow: 2, maxConcurrentRuns: 5 });
    await l.acquire(a, at(t));
    await l.acquire(a, at(t, 1));
    await assert.rejects(l.acquire(a, at(t, 599)), refused("runs_per_window"));
    await l.acquire(a, at(t, 601 + 599)); // every earlier attempt is now more than 600 s old
  }],
  ["the window boundary is exact: a run counts until exactly windowSeconds after its start, and no longer", async ({ make, users: [a, b], t }) => {
    const l = make({ maxRunsPerWindow: 1, maxConcurrentRuns: 5 });
    await l.acquire(a, at(t));
    await l.acquire(a, at(t, 600)); // exactly 600 s later: the first run is outside the window
    await l.acquire(b, at(t));
    await assert.rejects(l.acquire(b, at(t, 599.999)), refused("runs_per_window")); // one millisecond before: still inside
  }],
  ["the token budget counts released runs' tokens in the window", async ({ make, users: [a], t }) => {
    const l = make({ maxConcurrentRuns: 5, maxRunsPerWindow: 10 });
    await l.release(await l.acquire(a, at(t)), a, done(at(t, 1), 1000));
    await assert.rejects(l.acquire(a, at(t, 2)), refused("tokens_per_window"));
  }],
  ["a run that never finished stops counting as in progress after the stale time", async ({ make, users: [a], t }) => {
    const l = make();
    await l.acquire(a, at(t));
    await assert.rejects(l.acquire(a, at(t, CONTRACT_STALE_MS / 1000 - 1)), refused("concurrent_runs"));
    await l.acquire(a, at(t, CONTRACT_STALE_MS / 1000 + 1));
  }],
  ["users are independent, and one cannot release another's run", async ({ make, users: [a, b], t }) => {
    const l = make();
    const run = await l.acquire(a, at(t));
    await l.acquire(b, at(t));
    await l.release(run, b, done(at(t, 1)));
    await assert.rejects(l.acquire(a, at(t, 2)), refused("concurrent_runs"));
  }],
  ["global concurrency: runs in progress across users are capped; releasing any one frees a place for anyone", async ({ make, users: [a, b], t }) => {
    const l = make({ maxGlobalConcurrentRuns: 1, maxConcurrentRuns: 1 });
    const run = await l.acquire(a, at(t));
    await assert.rejects(l.acquire(b, at(t, 1)), refused("global_concurrent_runs"));
    await l.release(run, a, done(at(t, 2)));
    await l.acquire(b, at(t, 3));
  }],
  ["global concurrency does not replace the per-user limit: a person at their own cap is told so first", async ({ make, users: [a], t }) => {
    const l = make({ maxGlobalConcurrentRuns: 1, maxConcurrentRuns: 1 });
    await l.acquire(a, at(t));
    await assert.rejects(l.acquire(a, at(t, 1)), refused("concurrent_runs"));
  }],
  ["global concurrency under simultaneous admissions from different users: only the allowed number succeed", async ({ make, users: [a, b], t }) => {
    const l = make({ maxGlobalConcurrentRuns: 1, maxConcurrentRuns: 1, maxRunsPerWindow: 50 });
    const results = await Promise.allSettled([a, b, a, b, a, b].map((u) => l.acquire(u, at(t))));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  }],
  ["an abandoned run stops holding a global place after the stale time", async ({ make, users: [a, b], t }) => {
    const l = make({ maxGlobalConcurrentRuns: 1 });
    await l.acquire(a, at(t));
    await assert.rejects(l.acquire(b, at(t, CONTRACT_STALE_MS / 1000 - 1)), refused("global_concurrent_runs"));
    await l.acquire(b, at(t, CONTRACT_STALE_MS / 1000 + 1));
  }],
];
