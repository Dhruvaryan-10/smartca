// The assistant's persistence: consent (services/assistant/authorization-store.ts) and the run audit with its per-user limits
// (services/assistant/run-store.ts), against the local PostgreSQL. Each test uses throwaway users and deletes them (cascading their rows).
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { assistantRuns } from "../db/schema";
import { findAssistantAuthorization, grantAssistantAuthorization, revokeAssistantAuthorization } from "../services/assistant/authorization-store";
import { createPostgresRunLimiter, recordRejectedRun, recordRunPlan } from "../services/assistant/run-store";
import { purgeExpiredAssistantRuns } from "../services/assistant/run-retention";
import type { RunOutcome } from "../lib/assistant/run-limits";
import { AssistantRateLimitError } from "../lib/assistant/run-limits";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { NotAuthenticatedError, ValidationError } from "../services/errors";
import { AssistantConfigError } from "../services/assistant/config";
import { deleteTestUser, makeTestUser } from "./helpers";
import { CONTRACT_LIMITS, CONTRACT_STALE_MS, LIMITER_CONTRACT } from "./helpers-limiter";

const T0 = new Date("2026-09-29T10:00:00Z");
const T1 = new Date("2026-09-29T14:00:00Z");
const GRANT = { profileId: "full", recipient: "recipient-a", dataClasses: [...EGRESS_FIELD_CLASSES], issuedAt: T0, expiresAt: T1 };
const LIMITS = { windowSeconds: 3600, maxRunsPerWindow: 5, maxConcurrentRuns: 1, maxTokensPerWindow: 1000, maxGlobalConcurrentRuns: 100 };

async function withUsers(n: number, work: (ids: string[]) => Promise<void>) {
  const users = await Promise.all(Array.from({ length: n }, (_, i) => makeTestUser(`assistant-store-${i}`)));
  try {
    await work(users.map((u) => u.id));
  } finally {
    for (const u of users) await deleteTestUser(u.id);
  }
}
const runsOf = (userId: string) => db.select().from(assistantRuns).where(eq(assistantRuns.userId, userId));

// --- consent -------------------------------------------------------------------------------------------------------------------

test("a grant is stored with the disclosed inventory version, found for its owner, and matches the typed authorization", async () => {
  await withUsers(1, async ([a]) => {
    const granted = await grantAssistantAuthorization(a, GRANT);
    assert.deepEqual(granted, {
      version: 1, authorizationId: granted.authorizationId, userId: a, profileId: "full", recipient: "recipient-a", consent: "granted",
      dataClasses: [...EGRESS_FIELD_CLASSES], issuedAt: "2026-09-29T10:00:00Z", expiresAt: "2026-09-29T14:00:00Z", inventoryVersion: fingerprintInventory(),
    });
    assert.deepEqual(await findAssistantAuthorization(a, { profileId: "full", recipient: "recipient-a" }), { status: "active", authorization: granted });
    const [row] = (await db.execute(sql`select inventory_version from assistant_authorizations where id = ${granted.authorizationId}`)).rows as Array<{ inventory_version: string }>;
    assert.equal(row.inventory_version, fingerprintInventory());
  });
});

test("consent is per user: another user finds nothing, and cannot revoke it", async () => {
  await withUsers(2, async ([a, b]) => {
    const granted = await grantAssistantAuthorization(a, GRANT);
    assert.deepEqual(await findAssistantAuthorization(b, { profileId: "full", recipient: "recipient-a" }), { status: "none" });
    assert.equal(await revokeAssistantAuthorization(b, granted.authorizationId), false, "not theirs");
    assert.equal((await findAssistantAuthorization(a, { profileId: "full", recipient: "recipient-a" })).status, "active", "still active for its owner");
  });
});

test("consent is per recipient and profile", async () => {
  await withUsers(1, async ([a]) => {
    await grantAssistantAuthorization(a, GRANT);
    assert.deepEqual(await findAssistantAuthorization(a, { profileId: "full", recipient: "recipient-b" }), { status: "none" });
    assert.deepEqual(await findAssistantAuthorization(a, { profileId: "synthetic", recipient: "recipient-a" }), { status: "none" });
  });
});

test("revocation is recorded, once, and the latest grant decides: withdrawing never falls back to an older grant", async () => {
  await withUsers(1, async ([a]) => {
    const older = await grantAssistantAuthorization(a, GRANT);
    const newer = await grantAssistantAuthorization(a, { ...GRANT, issuedAt: new Date("2026-09-29T11:00:00Z") });
    assert.equal(await revokeAssistantAuthorization(a, newer.authorizationId), true);
    assert.equal(await revokeAssistantAuthorization(a, newer.authorizationId), false, "already revoked");
    assert.deepEqual(await findAssistantAuthorization(a, { profileId: "full", recipient: "recipient-a" }), { status: "revoked", authorizationId: newer.authorizationId });
    assert.notEqual(older.authorizationId, newer.authorizationId);
  });
});

test("a grant is validated before it is stored, and needs a user", async () => {
  await withUsers(1, async ([a]) => {
    for (const bad of [
      { ...GRANT, dataClasses: [] }, { ...GRANT, dataClasses: ["everything"] }, { ...GRANT, dataClasses: ["system_value", "system_value"] },
      { ...GRANT, recipient: "has space" }, { ...GRANT, profileId: " " }, { ...GRANT, expiresAt: T0 },
    ]) await assert.rejects(grantAssistantAuthorization(a, bad as never), ValidationError, JSON.stringify(bad));
    await assert.rejects(grantAssistantAuthorization("", GRANT), NotAuthenticatedError);
    assert.deepEqual(await findAssistantAuthorization(a, { profileId: "full", recipient: "recipient-a" }), { status: "none" }, "nothing was stored");
  });
});

// --- the run audit and the limits, through the RunLimiter interface -------------------------------------------------------------
// Every test uses its own far-future time base and its own users, so its windows contain only the rows it made.

let base = Date.UTC(2031, 0, 1);
const freshTime = () => {
  base += 30 * 86_400_000;
  return base;
};
const at = (t: number, seconds = 0) => new Date(t + seconds * 1000);
const limiter = (over: Partial<typeof LIMITS> = {}, staleAfterMs = 60_000) => createPostgresRunLimiter({ ...LIMITS, ...over }, { mode: "external", staleAfterMs });
const outcome = (finishedAt: Date, tokens: [number | null, number | null] = [null, null]): RunOutcome => ({
  status: "succeeded", resultCode: null, failureKind: null, answerState: "answered", modelCalls: 1, toolCalls: 0, toolRefusals: 0, toolsCalled: [],
  inputTokens: tokens[0], outputTokens: tokens[1], durationMs: 5, finishedAt,
});
const refusedWith = (code: string) => (e: unknown) => e instanceof AssistantRateLimitError && e.code === code;

test("a limiter refuses to exist without a complete set of limits (fail closed)", () => {
  for (const bad of [undefined, {}, { ...LIMITS, maxTokensPerWindow: undefined }, { ...LIMITS, maxConcurrentRuns: 0 }, { ...LIMITS, windowSeconds: -1 }, { ...LIMITS, maxRunsPerWindow: Number.POSITIVE_INFINITY }, { ...LIMITS, windowSeconds: Number.NaN }]) {
    assert.throws(() => createPostgresRunLimiter(bad, { mode: "external", staleAfterMs: 60_000 }), (e: unknown) => e instanceof AssistantConfigError && e.code === "invalid_configuration", JSON.stringify(bad));
  }
  assert.throws(() => createPostgresRunLimiter(LIMITS, { mode: "external", staleAfterMs: 0 }), RangeError);
});

test("the first run is allowed, recorded as running at the given time, then planned and released: metadata only", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const granted = await grantAssistantAuthorization(a, GRANT);
    const l = limiter();
    const runId = await l.acquire(a, at(t));
    let [row] = await runsOf(a);
    assert.deepEqual([row.status, row.startedAt.getTime()], ["running", t]);
    await recordRunPlan(runId, a, { authorizationId: granted.authorizationId, profileId: "full", recipient: "recipient-a", modelId: "m-1", allowedTools: ["calculate_tax"], visibleClasses: ["user_financial_data"], inventoryVersion: "inv1-00000000" });
    await l.release(runId, a, { ...outcome(at(t, 3), [120, 30]), modelCalls: 2, toolCalls: 1, toolsCalled: ["calculate_tax"], durationMs: 812.6 });
    [row] = await runsOf(a);
    assert.deepEqual(
      [row.status, row.authorizationId, row.profileId, row.recipient, row.modelId, row.allowedTools, row.visibleClasses, row.modelCalls, row.toolCalls, row.toolsCalled, row.inputTokens, row.outputTokens, row.durationMs, row.finishedAt?.getTime()],
      ["succeeded", granted.authorizationId, "full", "recipient-a", "m-1", ["calculate_tax"], ["user_financial_data"], 2, 1, ["calculate_tax"], 120, 30, 813, t + 3000],
    );
  });
});

test("per-user concurrency: a second run cannot start while the first is in progress; releasing frees the slot", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const l = limiter();
    const first = await l.acquire(a, at(t));
    await assert.rejects(l.acquire(a, at(t, 1)), refusedWith("concurrent_runs"));
    const rows = await runsOf(a);
    assert.deepEqual(rows.map((r) => r.status).sort(), ["rejected", "running"]);
    assert.equal(rows.find((r) => r.status === "rejected")?.resultCode, "too_many_concurrent_runs");
    await l.release(first, a, outcome(at(t, 2)));
    await l.acquire(a, at(t, 3));
  });
});

test("per-user concurrency under a real race: of many simultaneous acquires for one person, exactly one succeeds", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const l = limiter({ maxRunsPerWindow: 100 });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => l.acquire(a, at(t))));
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.ok(outcomes.filter((o) => o.status === "rejected").every((o) => refusedWith("concurrent_runs")((o as PromiseRejectedResult).reason)));
  });
});

test("separate users have separate per-user counters", async () => {
  await withUsers(2, async ([a, b]) => {
    const t = freshTime();
    const l = limiter({ maxRunsPerWindow: 1 });
    await l.acquire(a, at(t));
    await l.acquire(b, at(t)); // b is not limited by a's run or a's window
    await assert.rejects(l.acquire(a, at(t, 1)), refusedWith("concurrent_runs"));
  });
});

test("the window: runs count while their start is inside it, and stop counting once it has passed, deterministically", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const l = limiter({ maxRunsPerWindow: 2, maxConcurrentRuns: 10, windowSeconds: 600 });
    await l.release(await l.acquire(a, at(t)), a, outcome(at(t, 1)));
    await l.release(await l.acquire(a, at(t, 10)), a, outcome(at(t, 11)));
    await assert.rejects(l.acquire(a, at(t, 599)), refusedWith("runs_per_window"), "both still inside the window");
    await assert.rejects(l.acquire(a, at(t, 600)), refusedWith("runs_per_window"), "the refused attempts count too");
    await l.acquire(a, at(t, 60 * 60)); // an hour later, every earlier attempt is outside the 10-minute window
  });
});

test("the token budget: tokens used in the window refuse the next run; refused attempts before consent count toward the window", async () => {
  await withUsers(2, async ([a, b]) => {
    const t = freshTime();
    const l = limiter({ maxConcurrentRuns: 10, maxRunsPerWindow: 10, maxTokensPerWindow: 1000 });
    await l.release(await l.acquire(a, at(t)), a, outcome(at(t, 1), [600, 400]));
    await assert.rejects(l.acquire(a, at(t, 2)), refusedWith("tokens_per_window"));
    for (let i = 0; i < 2; i++) await recordRejectedRun(b, { mode: "external", resultCode: "consent_required", failureKind: "AssistantAuthorizationError:consent_not_given", at: at(t, i) });
    await assert.rejects(limiter({ maxRunsPerWindow: 2, maxConcurrentRuns: 10 }).acquire(b, at(t, 5)), refusedWith("runs_per_window"));
  });
});

test("a run that died without finishing stops counting as in progress after staleAfterMs", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const l = limiter({}, 60_000);
    await l.acquire(a, at(t)); // never released
    await assert.rejects(l.acquire(a, at(t, 59)), refusedWith("concurrent_runs"));
    await l.acquire(a, at(t, 61));
  });
});

test("history older than both the window and the stale time never counts: an unfinished run and its tokens from long ago are ignored", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const l = limiter({ maxConcurrentRuns: 1, maxRunsPerWindow: 1, maxTokensPerWindow: 10, windowSeconds: 600 }, 60_000);
    await l.acquire(a, at(t, -86_400)); // a day ago, never released
    await db.insert(assistantRuns).values({ userId: a, mode: "external", status: "succeeded", startedAt: at(t, -3600), inputTokens: 5000 });
    await l.acquire(a, at(t));
    assert.equal((await runsOf(a)).length, 3, "the history is kept for the audit; it simply no longer counts");
  });
});

test("release only closes the person's own running run, and every call needs a valid time and user", async () => {
  await withUsers(2, async ([a, b]) => {
    const t = freshTime();
    const l = limiter();
    const runId = await l.acquire(a, at(t));
    await l.release(runId, b, outcome(at(t, 1)));
    assert.equal((await runsOf(a))[0].status, "running", "another user cannot close it");
    await assert.rejects(l.release(runId, a, outcome(new Date(Number.NaN))), RangeError);
    await assert.rejects(l.acquire(a, new Date(Number.NaN)), RangeError);
    await assert.rejects(l.acquire("", at(t)), NotAuthenticatedError);
  });
});

test("two limiter instances (two logical servers) share the limits through PostgreSQL, not process memory", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const serverA = limiter({ maxRunsPerWindow: 100 });
    const serverB = limiter({ maxRunsPerWindow: 100 });
    // Racing: of simultaneous acquires split across both instances, exactly one succeeds.
    const outcomes = await Promise.allSettled([serverA, serverB, serverA, serverB, serverA, serverB].map((l) => l.acquire(a, at(t))));
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    const [won] = outcomes.filter((o): o is PromiseFulfilledResult<string> => o.status === "fulfilled").map((o) => o.value);
    // Sequential: the slot taken through one instance is seen by the other, and released through it too.
    await assert.rejects(serverB.acquire(a, at(t, 1)), refusedWith("concurrent_runs"));
    await serverB.release(won, a, outcome(at(t, 2)));
    await serverA.acquire(a, at(t, 3));
  });
});

test("the request limit through two instances: runs started on either count toward the same window", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const serverA = limiter({ maxRunsPerWindow: 2, maxConcurrentRuns: 10 });
    const serverB = limiter({ maxRunsPerWindow: 2, maxConcurrentRuns: 10 });
    await serverA.acquire(a, at(t));
    await serverB.acquire(a, at(t, 1));
    await assert.rejects(serverA.acquire(a, at(t, 2)), refusedWith("runs_per_window"));
    await assert.rejects(serverB.acquire(a, at(t, 2)), refusedWith("runs_per_window"));
  });
});

test("release after a failed run frees the slot; a second release changes nothing, and nothing ever counts below zero", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    const l = limiter();
    const runId = await l.acquire(a, at(t));
    await l.release(runId, a, { ...outcome(at(t, 1)), status: "failed", resultCode: "provider_unavailable", failureKind: "ModelProviderError:unavailable", answerState: null });
    await l.release(runId, a, outcome(at(t, 9))); // a second release: ignored, the first outcome stands
    const [row] = await runsOf(a);
    assert.deepEqual([row.status, row.resultCode, row.finishedAt?.getTime()], ["failed", "provider_unavailable", t + 1000]);
    // Exactly one slot is free again, not two: a released-twice run did not make room for a second concurrent run.
    await l.acquire(a, at(t, 2));
    await assert.rejects(l.acquire(a, at(t, 3)), refusedWith("concurrent_runs"));
  });
});

test("a failure inside the acquire transaction rolls back: no row and no stuck slot is left", async () => {
  await withUsers(1, async ([a]) => {
    const t = freshTime();
    // A user id that does not exist violates the foreign key on insert, inside the transaction.
    const ghost = "00000000-0000-4000-8000-000000000000";
    await assert.rejects(limiter().acquire(ghost, at(t)));
    assert.deepEqual(await db.select().from(assistantRuns).where(eq(assistantRuns.userId, ghost)), []);
    // A limiter whose rows the database rejects (an invalid mode fails a check constraint) leaves nothing behind either.
    await assert.rejects(createPostgresRunLimiter(LIMITS, { mode: "bogus" as never, staleAfterMs: 60_000 }).acquire(a, at(t)));
    assert.deepEqual(await runsOf(a), []);
    await limiter().acquire(a, at(t, 1)); // and the person's slot is free
  });
});

// --- the global concurrency cap --------------------------------------------------------------------------------------------------

test("global concurrency under a real race across two instances and many people: exactly the cap is admitted", async () => {
  await withUsers(6, async (users) => {
    const t = freshTime();
    const serverA = limiter({ maxGlobalConcurrentRuns: 2 });
    const serverB = limiter({ maxGlobalConcurrentRuns: 2 });
    const outcomes = await Promise.allSettled(users.map((u, i) => (i % 2 === 0 ? serverA : serverB).acquire(u, at(t))));
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 2);
    assert.ok(outcomes.filter((o) => o.status === "rejected").every((o) => refusedWith("global_concurrent_runs")((o as PromiseRejectedResult).reason)));
    // Every refused attempt is on record for its own person, as rejected, and no slot is held for it.
    const rows = (await Promise.all(users.map(runsOf))).flat();
    assert.deepEqual([rows.filter((r) => r.status === "running").length, rows.filter((r) => r.status === "rejected").length], [2, 4]);
    assert.ok(rows.filter((r) => r.status === "rejected").every((r) => r.failureKind === "AssistantRateLimitError:global_concurrent_runs" && r.resultCode === "assistant_busy"));
  });
});

test("the global cap counts only running runs of its own mode, in progress at the time asked", async () => {
  await withUsers(3, async ([a, b, c]) => {
    const t = freshTime();
    // A synthetic run in progress, and an external run that starts later than the time asked: neither holds a place now.
    await db.insert(assistantRuns).values({ userId: a, mode: "synthetic", status: "running", startedAt: at(t) });
    await db.insert(assistantRuns).values({ userId: b, mode: "external", status: "running", startedAt: at(t, 10) });
    await limiter({ maxGlobalConcurrentRuns: 1 }).acquire(c, at(t, 1));
  });
});

// --- retention of the run audit ---------------------------------------------------------------------------------------------------
// These rows are dated 1990, before any other row a test or a developer makes, so a cutoff in 1990 can only ever reach them.

test("retention deletes run rows that started before the cutoff, in batches, whatever their outcome; later rows and consent records stay", async () => {
  await withUsers(2, async ([a, b]) => {
    const day = 86_400_000;
    const now = new Date(Date.UTC(1990, 0, 31));
    const old = (u: string, daysAgo: number, status: "succeeded" | "failed" | "rejected" | "running") =>
      db.insert(assistantRuns).values({ userId: u, mode: "external", status, startedAt: new Date(now.getTime() - daysAgo * day) }).returning({ id: assistantRuns.id });
    for (const [u, daysAgo, status] of [[a, 20, "succeeded"], [a, 15, "failed"], [b, 12, "rejected"], [b, 11, "running"], [a, 11, "succeeded"]] as const) await old(u, daysAgo, status);
    const [keptA] = await old(a, 9, "succeeded");
    const [keptB] = await old(b, 1, "rejected");
    const grant = await grantAssistantAuthorization(a, { ...GRANT, issuedAt: new Date(now.getTime() - 30 * day), expiresAt: new Date(now.getTime() - 20 * day) });

    const result = await purgeExpiredAssistantRuns({ now, retentionDays: 10, batchSize: 2 });
    assert.equal(result.deletedRuns, 5, "three full-or-partial batches of 2");
    assert.equal(result.cutoff.getTime(), now.getTime() - 10 * day);
    assert.deepEqual((await runsOf(a)).map((r) => r.id), [keptA.id]);
    assert.deepEqual((await runsOf(b)).map((r) => r.id), [keptB.id]);
    assert.equal((await findAssistantAuthorization(a, { profileId: "full", recipient: "recipient-a" })).status, "active", "the (expired) consent record is kept");
    assert.ok(grant.authorizationId);

    // Running it again deletes nothing: it is idempotent.
    assert.equal((await purgeExpiredAssistantRuns({ now, retentionDays: 10 })).deletedRuns, 0);
  });
});

test("retention refuses a value outside its bounds, and a bad time or batch, before deleting anything", async () => {
  const now = new Date(Date.UTC(1990, 0, 31));
  for (const retentionDays of [0, -1, 1.5, Number.NaN, 3651]) {
    await assert.rejects(purgeExpiredAssistantRuns({ now, retentionDays }), (e: unknown) => e instanceof AssistantConfigError && e.variables.includes("ASSISTANT_RUN_RETENTION_DAYS"), String(retentionDays));
  }
  await assert.rejects(purgeExpiredAssistantRuns({ now: new Date(Number.NaN), retentionDays: 10 }), RangeError);
  await assert.rejects(purgeExpiredAssistantRuns({ now, retentionDays: 10, batchSize: 0 }), RangeError);
});

// --- the shared RunLimiter contract, against PostgreSQL (the same cases run against the in-memory limiter in a pure test) -------------
for (const [name, check] of LIMITER_CONTRACT) {
  test(`PostgreSQL limiter: ${name}`, async () => {
    await withUsers(2, async ([a, b]) => {
      const make = (over = {}) => createPostgresRunLimiter({ ...CONTRACT_LIMITS, ...over }, { mode: "external", staleAfterMs: CONTRACT_STALE_MS });
      await check({ make, users: [a, b], t: freshTime() });
    });
  });
}
