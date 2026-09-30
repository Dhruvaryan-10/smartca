// The run-limit decision and the limiter interface (lib/assistant/run-limits.ts). PURE: no database. The atomic PostgreSQL implementation
// is exercised in assistant-stores.db.test.ts, and the service's use of the interface in assistant-service.db.test.ts.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantRateLimitError, RUN_LIMIT_CODES, exceededRunLimit, isCompleteRunLimits } from "../lib/assistant/run-limits";

const FRONTEND = path.resolve(__dirname, "..");
const LIMITS = { windowSeconds: 3600, maxRunsPerWindow: 10, maxConcurrentRuns: 2, maxTokensPerWindow: 1000, maxGlobalConcurrentRuns: 50 };
const USAGE = { runsInWindow: 3, runsInProgress: 1, tokensInWindow: 200, globalRunsInProgress: 10 };

test("the first run, and any run under every limit, may start", () => {
  assert.equal(exceededRunLimit({ runsInWindow: 0, runsInProgress: 0, tokensInWindow: 0, globalRunsInProgress: 0 }, LIMITS), null);
  assert.equal(exceededRunLimit(USAGE, LIMITS), null);
  assert.equal(exceededRunLimit({ runsInWindow: 9, runsInProgress: 1, tokensInWindow: 999, globalRunsInProgress: 49 }, LIMITS), null, "one below each limit");
});

test("each limit, reached, refuses the next run", () => {
  assert.equal(exceededRunLimit({ ...USAGE, runsInProgress: 2 }, LIMITS), "concurrent_runs");
  assert.equal(exceededRunLimit({ ...USAGE, runsInWindow: 10 }, LIMITS), "runs_per_window");
  assert.equal(exceededRunLimit({ ...USAGE, tokensInWindow: 1000 }, LIMITS), "tokens_per_window");
  assert.equal(exceededRunLimit({ ...USAGE, globalRunsInProgress: 50 }, LIMITS), "global_concurrent_runs");
});

test("the order: the person's concurrency, their run count, their tokens, then everyone's concurrency", () => {
  const all = { runsInWindow: 10, runsInProgress: 2, tokensInWindow: 1000, globalRunsInProgress: 50 };
  assert.equal(exceededRunLimit(all, LIMITS), "concurrent_runs");
  assert.equal(exceededRunLimit({ ...all, runsInProgress: 0 }, LIMITS), "runs_per_window");
  assert.equal(exceededRunLimit({ ...all, runsInProgress: 0, runsInWindow: 0 }, LIMITS), "tokens_per_window");
  assert.equal(exceededRunLimit({ ...all, runsInProgress: 0, runsInWindow: 0, tokensInWindow: 0 }, LIMITS), "global_concurrent_runs");
  assert.deepEqual([...RUN_LIMIT_CODES].sort(), ["concurrent_runs", "global_concurrent_runs", "runs_per_window", "tokens_per_window"]);
});

test("limits must be complete to exist; malformed usage or limits refuse rather than allow", () => {
  assert.equal(isCompleteRunLimits(LIMITS), true);
  for (const field of Object.keys(LIMITS)) {
    const partial: Record<string, number> = { ...LIMITS };
    delete partial[field];
    assert.equal(isCompleteRunLimits(partial), false, `without ${field}`);
    for (const bad of [0, -1, 1.5, Number.NaN, "10"]) assert.equal(isCompleteRunLimits({ ...LIMITS, [field]: bad }), false, `${field}=${String(bad)}`);
  }
  for (const bad of [null, undefined, 7, "limits", []]) assert.equal(isCompleteRunLimits(bad), false);
  for (const usage of [{ ...USAGE, runsInWindow: -1 }, { ...USAGE, runsInProgress: 0.5 }, { ...USAGE, tokensInWindow: Number.NaN }, { ...USAGE, runsInWindow: undefined }, { ...USAGE, globalRunsInProgress: -1 }, { ...USAGE, globalRunsInProgress: undefined }]) {
    assert.notEqual(exceededRunLimit(usage as never, LIMITS), null, JSON.stringify(usage));
  }
  assert.notEqual(exceededRunLimit(USAGE, { ...LIMITS, maxTokensPerWindow: 0 }), null);
});

test("a refusal carries a code and a fixed message, never a count", () => {
  for (const code of RUN_LIMIT_CODES) {
    const error = new AssistantRateLimitError(code);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /\d/);
  }
});

test("run-limits.ts has no imports and reads no clock: time is always passed in", () => {
  const code = fs.readFileSync(path.join(FRONTEND, "lib/assistant/run-limits.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(code, /^\s*import\b/m);
  assert.doesNotMatch(code, /require\(|import\(|process\.env|Date\.now\(|new Date\(/);
});
