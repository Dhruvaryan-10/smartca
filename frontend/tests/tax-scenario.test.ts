// scenarioDelta: the deterministic "what changes if..." helper. PURE, like the rest of the engine: it subtracts two
// results the engine itself produced, so no tax arithmetic is ever done outside the engine.
//
// The result is SIGNED (scenario minus base), unlike comparisonNumbers, whose difference is absolute and whose fields
// are named for the two regimes. A scenario is only comparable with a base computed under the same assessment year,
// regime, engine version and rules version.
//
// This is a new test file: it does not touch the existing engine tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScenarioMismatchError, calculateTax, scenarioDelta } from "../tax-engine";
import type { TaxInput, TaxResult } from "../tax-engine";

const RUPEE = 100;
const salary = (rupees: number): TaxInput["incomeSources"] => [{ kind: "salary", label: "Salary", amountPaise: rupees * RUPEE }];
const input = (over: Partial<TaxInput> = {}): TaxInput => ({
  assessmentYearLabel: "2026-27",
  regime: "old",
  ageCategory: "below60",
  incomeSources: salary(1_500_000),
  deductions: [],
  ...over,
});

const base = calculateTax(input());
const withEightyC = calculateTax(input({ deductions: [{ section: "80C", amountPaise: 150_000 * RUPEE }] }));

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

// --- signed change ---------------------------------------------------------------------

test("the change is scenario minus base, signed: a scenario that pays less tax is negative", () => {
  assert.ok(withEightyC.totalTaxPaise < base.totalTaxPaise, "fixture: 80C lowers the old-regime tax");
  const delta = scenarioDelta(base, withEightyC);
  assert.equal(delta.change.totalTaxPaise, withEightyC.totalTaxPaise - base.totalTaxPaise);
  assert.ok(delta.change.totalTaxPaise < 0);
  assert.equal(delta.base.totalTaxPaise, base.totalTaxPaise);
  assert.equal(delta.scenario.totalTaxPaise, withEightyC.totalTaxPaise);
});

test("the same scenario the other way round is the same magnitude with the opposite sign, and no change is exactly zero", () => {
  const forward = scenarioDelta(base, withEightyC);
  const backward = scenarioDelta(withEightyC, base);
  assert.equal(backward.change.totalTaxPaise, -forward.change.totalTaxPaise);
  assert.ok(backward.change.totalTaxPaise > 0, "paying more is positive, not an absolute value");
  assert.equal(backward.change.taxableIncomePaise, -forward.change.taxableIncomePaise);

  const none = scenarioDelta(base, base);
  assert.deepEqual(Object.values(none.change), [0, 0, 0, 0, 0, 0]);
});

test("every component of the change is a signed subtraction of the engine's own figures", () => {
  const delta = scenarioDelta(base, withEightyC);
  assert.deepEqual(delta.change, {
    totalTaxPaise: withEightyC.totalTaxPaise - base.totalTaxPaise,
    taxableIncomePaise: withEightyC.taxableIncomePaise - base.taxableIncomePaise,
    totalDeductionsPaise: withEightyC.totalDeductionsPaise - base.totalDeductionsPaise,
    rebatePaise: withEightyC.rebatePaise - base.rebatePaise,
    surchargePaise: withEightyC.surchargePaise - base.surchargePaise,
    cessPaise: withEightyC.cessPaise - base.cessPaise,
  });
  assert.ok(delta.change.totalDeductionsPaise > 0, "the 80C the scenario adds shows as more deductions applied");
});

test("the delta says which year, regime and versions it is about", () => {
  const delta = scenarioDelta(base, withEightyC);
  assert.equal(delta.assessmentYearLabel, "2026-27");
  assert.equal(delta.regime, "old");
  assert.equal(delta.engineVersion, base.engineVersion);
  assert.equal(delta.rulesVersion, base.rulesVersion);
});

test("it only reads its inputs: neither result is changed", () => {
  const a = deepFreeze(structuredClone(base));
  const b = deepFreeze(structuredClone(withEightyC));
  assert.doesNotThrow(() => scenarioDelta(a, b));
});

// --- it refuses to compare things that are not comparable ------------------------------

const clone = (over: Partial<TaxResult>): TaxResult => ({ ...withEightyC, ...over });

test("a mismatched assessment year, regime, engine version or rules version is refused, and the error names each", () => {
  for (const [field, over] of [
    ["assessmentYearLabel", { assessmentYearLabel: "2025-26" }],
    ["regime", { regime: "new" }],
    ["engineVersion", { engineVersion: "tax-engine-v0" }],
    ["rulesVersion", { rulesVersion: "another-rules-version" }],
  ] as const) {
    assert.throws(
      () => scenarioDelta(base, clone(over)),
      (error: unknown) => error instanceof ScenarioMismatchError && error.fields.length === 1 && error.fields[0] === field && error.message.includes(field),
      field,
    );
  }
  assert.throws(
    () => scenarioDelta(base, clone({ assessmentYearLabel: "2025-26", regime: "new" })),
    (error: unknown) => error instanceof ScenarioMismatchError && error.fields.join(",") === "assessmentYearLabel,regime",
    "every mismatched field is listed, not just the first",
  );
});

test("a different age category or different income is NOT a mismatch: that is what a scenario is", () => {
  const senior = calculateTax(input({ ageCategory: "senior" }));
  assert.doesNotThrow(() => scenarioDelta(base, senior));
  const richer = calculateTax(input({ incomeSources: salary(2_500_000) }));
  assert.ok(scenarioDelta(base, richer).change.totalTaxPaise > 0);
});
