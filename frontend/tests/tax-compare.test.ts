// Regime comparison tests. Pure — no database, session, or network.
//
// The comparison reports numbers only. It must never contain recommendation
// language, and one regime refusing must not hide the other's result.
// Expected values are hand-computed (AY 2026-27 rules).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateTax,
  TaxEngineInternalError,
  TaxInputValidationError,
  UnsupportedAssessmentYearError,
  UnsupportedTaxRuleError,
} from "../tax-engine";
import { compareRegimes, comparisonNumbers } from "../tax-engine/compare";
import type { ComparisonInput } from "../tax-engine/compare";
import type { TaxInput, TaxResult } from "../tax-engine";

const rupees = (r: number) => r * 100;

function salaryInput(salaryRupees: number, overrides: Partial<ComparisonInput> = {}): ComparisonInput {
  return {
    assessmentYearLabel: "2026-27",
    ageCategory: "below60",
    incomeSources: [{ kind: "salary", label: "Salary", amountPaise: rupees(salaryRupees) }],
    deductions: [],
    ...overrides,
  };
}

/** A calculator that records what it was asked to compute. */
function recordingCalculator(behaviour?: (input: TaxInput) => TaxResult | void) {
  const seen: TaxInput[] = [];
  const calculate = (input: TaxInput): TaxResult => {
    seen.push(input);
    return behaviour?.(input) ?? calculateTax(input);
  };
  return { calculate, seen };
}

test("both regimes succeed: old and new results plus the numerical difference", () => {
  // ₹15,00,000 salary; old regime claims ₹1,50,000 of 80C.
  //   new: taxable 14,25,000 -> tax 93,750 + 4% cess = 97,500
  //   old: taxable 13,00,000 -> tax 2,02,500 + 4% cess = 2,10,600
  const comparison = compareRegimes(salaryInput(15_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] }));

  assert.equal(comparison.new.status, "ok");
  assert.equal(comparison.old.status, "ok");
  if (comparison.new.status !== "ok" || comparison.old.status !== "ok") return;
  assert.equal(comparison.new.result.regime, "new");
  assert.equal(comparison.old.result.regime, "old");
  assert.equal(comparison.new.result.totalTaxPaise, rupees(97_500));
  assert.equal(comparison.old.result.totalTaxPaise, rupees(2_10_600));
  assert.deepEqual(comparison.numbers, {
    oldTotalTaxPaise: rupees(2_10_600),
    newTotalTaxPaise: rupees(97_500),
    differencePaise: rupees(1_13_100),
    lowerTaxRegime: "new",
  });
});

test("the same income and age category feed both regimes", () => {
  const input = salaryInput(15_00_000, {
    ageCategory: "senior",
    incomeSources: [
      { kind: "salary", label: "Salary", amountPaise: rupees(10_00_000) },
      { kind: "business", label: "Consulting", amountPaise: rupees(3_00_000) },
      { kind: "other", label: "Interest", amountPaise: rupees(50_000) },
    ],
  });
  const { calculate, seen } = recordingCalculator();
  compareRegimes(input, calculate);

  assert.equal(seen.length, 2);
  const [oldInput, newInput] = [seen.find((i) => i.regime === "old")!, seen.find((i) => i.regime === "new")!];
  assert.deepEqual(oldInput.incomeSources, newInput.incomeSources);
  assert.equal(oldInput.ageCategory, "senior");
  assert.equal(newInput.ageCategory, "senior");
  assert.equal(oldInput.assessmentYearLabel, newInput.assessmentYearLabel);
});

test("deductions go to the old regime only; the new regime never receives them", () => {
  const deductions: ComparisonInput["deductions"] = [
    { section: "80C", amountPaise: rupees(1_50_000) },
    { section: "80D", selfFamilyPaise: rupees(25_000), parentsPaise: rupees(50_000), anyParentIsSenior: true },
  ];
  const { calculate, seen } = recordingCalculator();
  const comparison = compareRegimes(salaryInput(15_00_000, { deductions }), calculate);

  assert.deepEqual(seen.find((i) => i.regime === "old")!.deductions, deductions);
  assert.deepEqual(seen.find((i) => i.regime === "new")!.deductions, []);

  // With the real engine, the new regime succeeds (it would refuse declared deductions) and applies only its standard deduction.
  const real = compareRegimes(salaryInput(15_00_000, { deductions }));
  assert.equal(real.new.status, "ok");
  if (real.new.status === "ok") {
    assert.equal(real.new.result.totalDeductionsPaise, rupees(75_000));
    assert.deepEqual(real.new.result.deductionAdjustments, []);
  }
  assert.equal(real.old.status, "ok");
  if (real.old.status === "ok") assert.equal(real.old.result.deductionAdjustments.length, 3);
  assert.deepEqual(comparison.old.status, "ok");
});

test("the caller's input is not mutated", () => {
  const input = salaryInput(15_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] });
  const snapshot = JSON.stringify(input);
  compareRegimes(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test("one regime refusing does not hide the other regime's result", () => {
  const { calculate } = recordingCalculator((input) => {
    if (input.regime === "old") throw new UnsupportedTaxRuleError("old regime scenario is not supported");
  });
  const comparison = compareRegimes(salaryInput(15_00_000), calculate);

  assert.equal(comparison.new.status, "ok");
  assert.equal(comparison.old.status, "refused");
  if (comparison.old.status === "refused") {
    assert.equal(comparison.old.refusal.kind, "unsupported_rule");
    assert.match(comparison.old.refusal.message, /not supported/);
  }
  assert.equal(comparison.numbers, null, "no numerical comparison exists when one side has no result");

  // And the mirror image.
  const { calculate: refuseNew } = recordingCalculator((input) => {
    if (input.regime === "new") throw new UnsupportedTaxRuleError("new regime scenario is not supported");
  });
  const mirror = compareRegimes(salaryInput(15_00_000), refuseNew);
  assert.equal(mirror.old.status, "ok");
  assert.equal(mirror.new.status, "refused");
  assert.equal(mirror.numbers, null);
});

test("both regimes refusing yields two typed refusals and no numbers", () => {
  const { calculate } = recordingCalculator(() => {
    throw new UnsupportedTaxRuleError("not supported");
  });
  const comparison = compareRegimes(salaryInput(15_00_000), calculate);
  assert.equal(comparison.old.status, "refused");
  assert.equal(comparison.new.status, "refused");
  assert.equal(comparison.numbers, null);
});

test("equal tax is an explicit tie, not a recommendation", () => {
  // ₹3,00,000 salary: both regimes end at nil tax.
  const comparison = compareRegimes(salaryInput(3_00_000));
  assert.deepEqual(comparison.numbers, {
    oldTotalTaxPaise: 0,
    newTotalTaxPaise: 0,
    differencePaise: 0,
    lowerTaxRegime: "equal",
  });
});

test("old can be the lower-tax regime, and the difference is always non-negative", () => {
  const { calculate } = recordingCalculator((input) => ({
    ...calculateTax(input),
    totalTaxPaise: input.regime === "old" ? rupees(100) : rupees(250),
  }));
  const comparison = compareRegimes(salaryInput(15_00_000), calculate);
  assert.deepEqual(comparison.numbers, {
    oldTotalTaxPaise: rupees(100),
    newTotalTaxPaise: rupees(250),
    differencePaise: rupees(150),
    lowerTaxRegime: "old",
  });
});

test("the comparison contains numbers only: no recommendation fields", () => {
  const comparison = compareRegimes(salaryInput(15_00_000));
  assert.deepEqual(Object.keys(comparison).sort(), ["new", "numbers", "old"]);
  assert.deepEqual(Object.keys(comparison.numbers!).sort(), [
    "differencePaise",
    "lowerTaxRegime",
    "newTotalTaxPaise",
    "oldTotalTaxPaise",
  ]);
});

test("problems that are not specific to one regime still throw instead of being reported as a refusal", () => {
  // Bad input hits both regimes identically.
  assert.throws(
    () => compareRegimes(salaryInput(15_00_000, { incomeSources: [{ kind: "salary", label: "S", amountPaise: -1 }] })),
    TaxInputValidationError,
  );
  // So does an unsupported assessment year.
  assert.throws(() => compareRegimes(salaryInput(15_00_000, { assessmentYearLabel: "2031-32" })), UnsupportedAssessmentYearError);
  // And an engine bug must never be dressed up as a regime refusal.
  const { calculate } = recordingCalculator(() => {
    throw new TaxEngineInternalError("tree failed reconciliation");
  });
  assert.throws(() => compareRegimes(salaryInput(15_00_000), calculate), TaxEngineInternalError);
});

test("each regime's result is stamped with the engine and rules versions", () => {
  const comparison = compareRegimes(salaryInput(8_00_000));
  for (const outcome of [comparison.old, comparison.new]) {
    assert.equal(outcome.status, "ok");
    if (outcome.status === "ok") {
      assert.equal(outcome.result.engineVersion, "tax-engine-v2");
      assert.equal(outcome.result.rulesVersion, "ay-2026-27-v3");
    }
  }
});

test("comparisonNumbers gives the same numbers as compareRegimes, so saved runs never need arithmetic in the UI", () => {
  const live = compareRegimes(salaryInput(15_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] }));
  assert.equal(live.old.status, "ok");
  assert.equal(live.new.status, "ok");
  if (live.old.status !== "ok" || live.new.status !== "ok") return;

  assert.deepEqual(comparisonNumbers(live.old.result, live.new.result), live.numbers);
  // A missing side means there is nothing to compare.
  assert.equal(comparisonNumbers(live.old.result, null), null);
  assert.equal(comparisonNumbers(null, live.new.result), null);
  assert.equal(comparisonNumbers(null, null), null);
});
