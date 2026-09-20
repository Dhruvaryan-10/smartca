// Behaviour evaluation for the answer layer. PURE: it runs fixtures through buildAnswer and reports, per BEHAVIOUR, how many
// behaved as specified. There is no single "accuracy" number: the behaviours are different promises, and a blend would hide
// which one broke.
//
// What this measures, and what it does not. The answer layer is deterministic, so a fixture either behaves as specified or it
// does not: this harness checks the layer's RULES against fixtures written from the specification, including compromised-model
// texts (a model that obeys injected text, invents evidence, changes an amount). It says NOTHING about how a real model
// behaves, or about whether a released answer is true. A real model needs its own evaluation once one is connected.
import { buildAnswer } from "./answer";
import type { Answer, AnswerInput, AnswerState, ViolationCode } from "./answer";
import { wilson } from "../rag-eval/stats";
import type { Rate } from "../rag-eval/stats";

export const ANSWER_EVAL_BEHAVIORS = [
  "groundedness",
  "evidence_preservation",
  "number_preservation",
  "refusal_correctness",
  "unsupported_claim_handling",
  "injection_resistance",
] as const;
export type AnswerEvalBehavior = (typeof ANSWER_EVAL_BEHAVIORS)[number];

export type AnswerEvalCase = {
  id: string;
  behavior: AnswerEvalBehavior;
  /** What the case is about, in a sentence: shown with a failure. */
  description: string;
  input: AnswerInput;
  expect: {
    state: AnswerState;
    /** Exactly the blocking violation codes expected. */
    blocking: readonly ViolationCode[];
    /** Exactly the warning codes expected (default none). */
    warnings?: readonly ViolationCode[];
    /** Whether the model's text is released. */
    textReleased: boolean;
    /** Evidence ids that must be in facts.evidence, exactly and in order. */
    evidenceIds?: readonly string[];
    /** The tax tool payloads that must be in the facts, verbatim and in order. */
    taxPayloads?: readonly unknown[];
    /** Paise values that must appear, exactly, under a "...Paise" key of some tax or ledger fact. */
    paise?: readonly number[];
    /** Strings that must appear nowhere in the facts (injected text). */
    absentFromFacts?: readonly string[];
    /** Refusal reasons the facts must carry, in order. */
    refusalReasons?: readonly string[];
  };
};

export type AnswerEvalOutcome = { id: string; behavior: AnswerEvalBehavior; passed: boolean; failures: string[]; state: AnswerState; violations: ViolationCode[] };

export type AnswerEvalResult = {
  outcomes: AnswerEvalOutcome[];
  /** k of n cases that behaved as specified, per behaviour, with a 95% Wilson interval. */
  metrics: Record<AnswerEvalBehavior, Rate>;
  /** For each violation code: how many fixtures expect it, and how many of those produced it. */
  coverage: Record<string, { expected: number; produced: number }>;
};

/** JSON with keys sorted, so two structurally equal values compare equal. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function paiseIn(value: unknown, into: Set<number>): void {
  if (Array.isArray(value)) for (const item of value) paiseIn(item, into);
  else if (value !== null && typeof value === "object") {
    for (const [key, inner] of Object.entries(value as object)) {
      if (key.endsWith("Paise") && typeof inner === "number") into.add(inner);
      else paiseIn(inner, into);
    }
  }
}

const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => canon(x) === canon(b[i]));
const list = (xs: readonly unknown[]) => `[${xs.map((x) => (typeof x === "string" ? x : canon(x))).join(", ")}]`;

/** Checks one answer against what a case expects; the failures say what differed. */
export function checkAnswer(c: AnswerEvalCase, answer: Answer): string[] {
  const failures: string[] = [];
  const e = c.expect;
  if (answer.state !== e.state) failures.push(`state: expected ${e.state}, got ${answer.state}`);

  const blocking = [...new Set(answer.violations.filter((v) => v.severity === "blocking").map((v) => v.code))].sort();
  const warnings = [...new Set(answer.violations.filter((v) => v.severity === "warning").map((v) => v.code))].sort();
  if (!sameList(blocking, [...e.blocking].sort())) failures.push(`blocking violations: expected ${list([...e.blocking].sort())}, got ${list(blocking)}`);
  if (!sameList(warnings, [...(e.warnings ?? [])].sort())) failures.push(`warnings: expected ${list([...(e.warnings ?? [])].sort())}, got ${list(warnings)}`);
  if ((answer.text !== null) !== e.textReleased) failures.push(`text released: expected ${e.textReleased}, got ${answer.text !== null}`);

  if (e.evidenceIds !== undefined) {
    const got = answer.facts.evidence.map((f) => f.evidenceId);
    if (!sameList(got, e.evidenceIds)) failures.push(`evidence preserved: expected ${list(e.evidenceIds)}, got ${list(got)}`);
  }
  if (e.taxPayloads !== undefined) {
    const got = answer.facts.taxValues.map((f) => f.payload);
    if (!sameList(got, e.taxPayloads)) failures.push("tax values: the facts are not the tools' results, verbatim");
  }
  if (e.paise !== undefined) {
    const present = new Set<number>();
    for (const f of [...answer.facts.taxValues, ...answer.facts.ledger]) paiseIn(f.payload, present);
    const missing = e.paise.filter((p) => !present.has(p));
    if (missing.length > 0) failures.push(`paise not preserved: ${missing.join(", ")}`);
  }
  if (e.absentFromFacts !== undefined) {
    const facts = JSON.stringify(answer.facts);
    for (const marker of e.absentFromFacts) if (facts.includes(marker)) failures.push(`"${marker.slice(0, 30)}" reached the facts`);
  }
  if (e.refusalReasons !== undefined) {
    const got = answer.facts.refusals.map((r) => r.reason);
    if (!sameList(got, e.refusalReasons)) failures.push(`refusal reasons: expected ${list(e.refusalReasons)}, got ${list(got)}`);
  }
  return failures;
}

export function runAnswerEval(cases: readonly AnswerEvalCase[]): AnswerEvalResult {
  const outcomes: AnswerEvalOutcome[] = [];
  const coverage: AnswerEvalResult["coverage"] = {};

  for (const c of cases) {
    const answer = buildAnswer(c.input);
    const failures = checkAnswer(c, answer);
    outcomes.push({ id: c.id, behavior: c.behavior, passed: failures.length === 0, failures, state: answer.state, violations: [...new Set(answer.violations.map((v) => v.code))].sort() });
    for (const code of [...c.expect.blocking, ...(c.expect.warnings ?? [])]) {
      const entry = (coverage[code] ??= { expected: 0, produced: 0 });
      entry.expected += 1;
      if (answer.violations.some((v) => v.code === code)) entry.produced += 1;
    }
  }

  const metrics = Object.fromEntries(
    ANSWER_EVAL_BEHAVIORS.map((behavior) => {
      const mine = outcomes.filter((o) => o.behavior === behavior);
      return [behavior, wilson(mine.filter((o) => o.passed).length, mine.length)];
    }),
  ) as Record<AnswerEvalBehavior, Rate>;
  return { outcomes, metrics, coverage };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

/** A human-readable report: one line per behaviour (k of n, with its interval), the coverage of each rule, and every failure. */
export function formatAnswerEvalReport(result: AnswerEvalResult, cases: readonly AnswerEvalCase[] = []): string {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const out: string[] = [
    "ANSWER LAYER EVALUATION (behaviour, fixture-based)",
    "  Deterministic rules run over fixtures, including compromised-model texts. Each line is k of n fixtures that behaved as specified,",
    "  with a 95% Wilson interval. There is no single accuracy figure. This says nothing about a real model, or about whether a released",
    "  answer is true.",
    "",
    "== BY BEHAVIOUR ==",
  ];
  for (const behavior of ANSWER_EVAL_BEHAVIORS) {
    const m = result.metrics[behavior];
    out.push(`  ${behavior.padEnd(28)}${`${m.k}/${m.n}`.padStart(7)}  ${pct(m.rate).padStart(7)}  [${pct(m.low)} to ${pct(m.high)}]`);
  }
  out.push("", "== RULE COVERAGE (violations expected by a fixture, and produced) ==");
  for (const [code, c] of Object.entries(result.coverage).sort(([a], [b]) => a.localeCompare(b))) out.push(`  ${code.padEnd(28)}${c.produced}/${c.expected}`);
  const failing = result.outcomes.filter((o) => !o.passed);
  out.push("", "== FAILURES ==");
  if (failing.length === 0) out.push("  none");
  for (const o of failing) {
    out.push(`  [${o.behavior}] ${o.id}: ${byId.get(o.id)?.description ?? ""}`, ...o.failures.map((f) => `      ${f}`));
  }
  return `${out.join("\n")}\n`;
}
