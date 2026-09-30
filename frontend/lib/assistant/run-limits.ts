// ASSISTANT RUN LIMITS: the pure decision whether one more assistant run may start, and the limiter INTERFACE the application service
// depends on. PURE: no imports, no database, no clock. The PostgreSQL implementation (services/assistant/run-store.ts) gathers the usage
// atomically across every server instance and calls exceededRunLimit; tests can supply any other RunLimiter. The values come only from
// the server's configuration (ExternalAssistantConfig.limits); nothing a client sends can change them.
//
// Three kinds of limit, kept apart:
//   per-user request limits      runs one person may start in the window, and model tokens they may use in it
//   per-user concurrency         runs one person may have in progress at once
//   global concurrency           runs in progress across ALL people at once (docs/decisions/0003): the per-user limits bound each person
//                                but not their sum, and an overloaded provider fails only AFTER the tools have read the person's data and
//                                it has been sent; the global cap refuses before any tool runs or anything leaves SmartCA
// These add to, and never replace, the per-run bounds that already exist: at most MAX_ROUNDS model calls and MAX_TOOL_CALLS tool calls
// per run (orchestrator.ts), the per-call timeout, the whole-run budget and the output cap (withModelGuard).

export type RunLimits = Readonly<{
  windowSeconds: number;
  maxRunsPerWindow: number;
  maxConcurrentRuns: number;
  maxTokensPerWindow: number;
  maxGlobalConcurrentRuns: number;
}>;

/**
 * What this person is using (runs started in the window, any outcome; runs in progress; tokens used in the window), and how many runs
 * are in progress across everyone. The global count is a number only: it never says whose runs they are.
 */
export type RunUsage = Readonly<{ runsInWindow: number; runsInProgress: number; tokensInWindow: number; globalRunsInProgress: number }>;

export const RUN_LIMIT_CODES = ["concurrent_runs", "runs_per_window", "tokens_per_window", "global_concurrent_runs"] as const;
export type RunLimitCode = (typeof RUN_LIMIT_CODES)[number];

const MESSAGES: Record<RunLimitCode, string> = {
  concurrent_runs: "Too many assistant requests are already in progress.",
  runs_per_window: "Too many assistant requests in the current window.",
  tokens_per_window: "The assistant usage budget for the current window is used up.",
  global_concurrent_runs: "The assistant is serving as many requests as it can at the moment.",
};

/** A run was refused by a limit. A code and a fixed message; never a count, a user or a value. */
export class AssistantRateLimitError extends Error {
  readonly code: RunLimitCode;
  constructor(code: RunLimitCode) {
    super(MESSAGES[code]);
    this.name = "AssistantRateLimitError";
    this.code = code;
  }
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const LIMIT_FIELDS = ["windowSeconds", "maxRunsPerWindow", "maxConcurrentRuns", "maxTokensPerWindow", "maxGlobalConcurrentRuns"] as const;

/** Whether `limits` states every limit as a whole number of at least 1. A limiter must refuse to exist with anything else. */
export function isCompleteRunLimits(limits: unknown): limits is RunLimits {
  if (typeof limits !== "object" || limits === null) return false;
  const l = limits as Record<string, unknown>;
  return LIMIT_FIELDS.every((f) => whole(l[f]) && (l[f] as number) >= 1);
}

/**
 * The limit one more run would break, or null if it may start. Checked in this order: the person's concurrency, their run count, their
 * token budget, then everyone's concurrency (so a person over their own limit is told about their own limit). Malformed usage or limits
 * refuse (fail closed) rather than allow.
 */
export function exceededRunLimit(usage: RunUsage, limits: RunLimits): RunLimitCode | null {
  const u = usage as Record<string, unknown>;
  if (!whole(u.runsInWindow) || !whole(u.runsInProgress) || !whole(u.tokensInWindow) || !whole(u.globalRunsInProgress)) return "runs_per_window";
  if (!isCompleteRunLimits(limits)) return "runs_per_window";
  if (usage.runsInProgress >= limits.maxConcurrentRuns) return "concurrent_runs";
  if (usage.runsInWindow >= limits.maxRunsPerWindow) return "runs_per_window";
  if (usage.tokensInWindow >= limits.maxTokensPerWindow) return "tokens_per_window";
  if (usage.globalRunsInProgress >= limits.maxGlobalConcurrentRuns) return "global_concurrent_runs";
  return null;
}

/** How a run ended, recorded when its slot is released. Codes, counts and times only: never content. */
export type RunOutcome = {
  status: "succeeded" | "failed";
  resultCode: string | null;
  failureKind: string | null;
  answerState: string | null;
  modelCalls: number;
  toolCalls: number;
  toolRefusals: number;
  toolsCalled: readonly string[];
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  finishedAt: Date;
};

/**
 * The boundary the application service depends on. `acquire` checks every limit (this person's and the global one) AT `at` and, only if
 * all allow it, opens a run slot and returns its id, atomically (two simultaneous acquires cannot both pass a limit); otherwise it throws an
 * AssistantRateLimitError. `release` closes the slot with the run's outcome: the run stops counting as in progress, and its tokens count
 * toward the window. Time is always passed in, so behaviour is deterministic and testable.
 */
export type RunLimiter = Readonly<{
  acquire(userId: string, at: Date): Promise<string>;
  release(runId: string, userId: string, outcome: RunOutcome): Promise<void>;
}>;
