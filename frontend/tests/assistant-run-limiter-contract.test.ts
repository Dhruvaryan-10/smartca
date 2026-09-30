// The RunLimiter contract (helpers-limiter.ts) against the IN-MEMORY limiter. PURE: no database. The same contract runs against the
// PostgreSQL limiter in assistant-stores.db.test.ts, so the two implementations are proven to behave the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_LIMITS, CONTRACT_STALE_MS, LIMITER_CONTRACT, createMemoryRunLimiter } from "./helpers-limiter";

for (const [name, check] of LIMITER_CONTRACT) {
  test(`in-memory limiter: ${name}`, async () => {
    const make = (over = {}) => createMemoryRunLimiter({ ...CONTRACT_LIMITS, ...over }, CONTRACT_STALE_MS);
    await check({ make, users: ["user-a", "user-b"], t: Date.UTC(2030, 0, 1) });
  });
}

test("in-memory limiter: refuses to exist without complete limits", () => {
  for (const bad of [undefined, {}, { ...CONTRACT_LIMITS, maxConcurrentRuns: 0 }, { ...CONTRACT_LIMITS, windowSeconds: Number.NaN }]) {
    assert.throws(() => createMemoryRunLimiter(bad, CONTRACT_STALE_MS), RangeError);
  }
});
