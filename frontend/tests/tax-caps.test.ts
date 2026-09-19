// Phase 3 engine tests: statutory deduction caps (80C, structured 80D),
// duplicate-section handling, the old-regime Section 87A behaviour above
// the ₹5,00,000 threshold, and the version stamps that changed with them.
//
// Pure — no database, session, or network. Expected values are
// hand-computed from the AY 2026-27 rules (see
// frontend/tax-engine/rules/ay-2026-27.ts for the evidence record), not
// derived from the code under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateTax,
  deductionCapsFor,
  ENGINE_VERSION,
  TaxInputValidationError,
  UnsupportedTaxRuleError,
} from "../tax-engine";
import { reconcile } from "../tax-engine/compute";
import { resolveAssessmentYearRules } from "../tax-engine/rules";
import type { ComputationNode, DeductionInput, TaxInput } from "../tax-engine";

const rupees = (r: number) => r * 100;

function oldInput(salaryRupees: number, overrides: Partial<TaxInput> = {}): TaxInput {
  return {
    assessmentYearLabel: "2026-27",
    regime: "old",
    ageCategory: "below60",
    incomeSources: [{ kind: "salary", label: "Salary", amountPaise: rupees(salaryRupees) }],
    deductions: [],
    ...overrides,
  };
}

function otherIncomeInput(otherRupees: number, overrides: Partial<TaxInput> = {}): TaxInput {
  return oldInput(0, {
    incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(otherRupees) }],
    ...overrides,
  });
}

function d80c(amountRupees: number): DeductionInput {
  return { section: "80C", amountPaise: rupees(amountRupees) };
}

function d80d(
  selfFamilyRupees: number,
  parentsRupees: number,
  flags: { spouseIsSenior?: boolean; anyParentIsSenior?: boolean } = {},
): DeductionInput {
  return { section: "80D", selfFamilyPaise: rupees(selfFamilyRupees), parentsPaise: rupees(parentsRupees), ...flags };
}

function assertReconciles(result: ReturnType<typeof calculateTax>) {
  assert.equal(reconcile(result.tree), true, "tax tree must reconcile");
  assert.equal(reconcile(result.taxableIncomeTree), true, "taxable income tree must reconcile");
}

function findNodes(node: ComputationNode, predicate: (n: ComputationNode) => boolean): ComputationNode[] {
  const found = predicate(node) ? [node] : [];
  return found.concat(...node.children.map((c) => findNodes(c, predicate)));
}

/** Nodes that add back an amount disallowed by a statutory cap. */
const capExcessNodes = (result: ReturnType<typeof calculateTax>, section: string) =>
  findNodes(result.taxableIncomeTree, (n) => n.kind === "deduction" && n.sourceSection === section && n.amountPaise > 0);

// ---------------------------------------------------------------------------
// Rules data: the caps are data, with the evidence recorded beside them
// ---------------------------------------------------------------------------

test("AY 2026-27 deduction limits are rule data with the official figures", () => {
  const limits = resolveAssessmentYearRules("2026-27").deductionLimits;
  assert.equal(limits.section80CPaise, rupees(1_50_000));
  assert.equal(limits.section80D.selfFamilyPaise.standard, rupees(25_000));
  assert.equal(limits.section80D.selfFamilyPaise.senior, rupees(50_000));
  assert.equal(limits.section80D.parentsPaise.standard, rupees(25_000));
  assert.equal(limits.section80D.parentsPaise.senior, rupees(50_000));
});

test("deductionCapsFor derives applicable caps from taxpayer and parent senior status", () => {
  const caps = (age: "below60" | "senior" | "superSenior", flags = {}) =>
    deductionCapsFor("2026-27", { ageCategory: age, ...flags });

  assert.deepEqual(caps("below60"), {
    section80CPaise: rupees(1_50_000),
    selfFamilyPaise: rupees(25_000),
    parentsPaise: rupees(25_000),
  });
  assert.equal(caps("senior").selfFamilyPaise, rupees(50_000));
  assert.equal(caps("superSenior").selfFamilyPaise, rupees(50_000));
  assert.equal(caps("below60", { spouseIsSenior: true }).selfFamilyPaise, rupees(50_000));
  // A senior taxpayer does not raise the PARENTS cap; only a senior parent does.
  assert.equal(caps("senior").parentsPaise, rupees(25_000));
  assert.equal(caps("below60", { anyParentIsSenior: true }).parentsPaise, rupees(50_000));
});

// ---------------------------------------------------------------------------
// 80C
// ---------------------------------------------------------------------------

test("80C below the cap: full amount allowed, no adjustment node", () => {
  const result = calculateTax(oldInput(8_00_000, { deductions: [d80c(1_00_000)] }));
  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 1_00_000));
  assert.equal(result.taxableIncomePaise, rupees(6_50_000));
  assert.deepEqual(result.deductionAdjustments, [
    { component: "80C", declaredPaise: rupees(1_00_000), allowedPaise: rupees(1_00_000), capPaise: rupees(1_50_000) },
  ]);
  assert.equal(capExcessNodes(result, "Section 80CCE").length, 0);
  assertReconciles(result);
});

test("80C exactly at the ₹1,50,000 cap: full amount allowed, no adjustment node", () => {
  const result = calculateTax(oldInput(8_00_000, { deductions: [d80c(1_50_000)] }));
  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 1_50_000));
  assert.equal(result.deductionAdjustments[0].allowedPaise, rupees(1_50_000));
  assert.equal(capExcessNodes(result, "Section 80CCE").length, 0);
  assertReconciles(result);
});

test("80C above the cap is clamped to ₹1,50,000 and the excess is shown in the tree", () => {
  const result = calculateTax(oldInput(8_00_000, { deductions: [d80c(2_00_000)] }));

  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 1_50_000)); // standard + clamped 80C
  assert.equal(result.taxableIncomePaise, rupees(6_00_000));
  assert.deepEqual(result.deductionAdjustments, [
    { component: "80C", declaredPaise: rupees(2_00_000), allowedPaise: rupees(1_50_000), capPaise: rupees(1_50_000) },
  ]);

  // The declared amount is shown in full, and a visible node adds back the excess.
  const claimed = findNodes(result.taxableIncomeTree, (n) => n.kind === "deduction" && n.sourceSection === "80C");
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].amountPaise, -rupees(2_00_000));
  const excess = capExcessNodes(result, "Section 80CCE");
  assert.equal(excess.length, 1);
  assert.equal(excess[0].amountPaise, rupees(50_000));
  assert.match(excess[0].label, /80C/);
  assert.match(excess[0].label, /1,50,000/);
  assertReconciles(result);
});

test("an over-cap 80C claim taxes identically to a claim exactly at the cap", () => {
  const capped = calculateTax(oldInput(12_00_000, { deductions: [d80c(1_50_000)] }));
  const over = calculateTax(oldInput(12_00_000, { deductions: [d80c(5_00_000)] }));
  assert.equal(over.taxableIncomePaise, capped.taxableIncomePaise);
  assert.equal(over.totalTaxPaise, capped.totalTaxPaise);
});

// ---------------------------------------------------------------------------
// 80D (structured: self/family and parents)
// ---------------------------------------------------------------------------

test("80D self/family below and at the ₹25,000 cap is allowed in full", () => {
  for (const amount of [10_000, 25_000]) {
    const result = calculateTax(oldInput(10_00_000, { deductions: [d80d(amount, 0)] }));
    assert.equal(result.totalDeductionsPaise, rupees(50_000 + amount));
    assert.equal(result.deductionAdjustments.length, 1);
    assert.equal(result.deductionAdjustments[0].component, "80D-self-family");
    assert.equal(result.deductionAdjustments[0].allowedPaise, rupees(amount));
    assert.equal(capExcessNodes(result, "Section 80D").length, 0);
    assertReconciles(result);
  }
});

test("80D self/family above the ₹25,000 cap is clamped with a visible excess", () => {
  const result = calculateTax(oldInput(10_00_000, { deductions: [d80d(30_000, 0)] }));
  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 25_000));
  assert.deepEqual(result.deductionAdjustments, [
    { component: "80D-self-family", declaredPaise: rupees(30_000), allowedPaise: rupees(25_000), capPaise: rupees(25_000) },
  ]);
  const excess = capExcessNodes(result, "Section 80D");
  assert.equal(excess.length, 1);
  assert.equal(excess[0].amountPaise, rupees(5_000));
  assertReconciles(result);
});

test("a senior or super-senior taxpayer gets the ₹50,000 self/family cap", () => {
  for (const ageCategory of ["senior", "superSenior"] as const) {
    const atCap = calculateTax(oldInput(10_00_000, { ageCategory, deductions: [d80d(50_000, 0)] }));
    assert.equal(atCap.deductionAdjustments[0].capPaise, rupees(50_000));
    assert.equal(atCap.deductionAdjustments[0].allowedPaise, rupees(50_000));

    const over = calculateTax(oldInput(10_00_000, { ageCategory, deductions: [d80d(60_000, 0)] }));
    assert.equal(over.deductionAdjustments[0].allowedPaise, rupees(50_000));
    assert.equal(capExcessNodes(over, "Section 80D")[0].amountPaise, rupees(10_000));
    assertReconciles(over);
  }
});

test("a senior spouse raises the self/family cap even when the taxpayer is under 60", () => {
  const result = calculateTax(oldInput(10_00_000, { deductions: [d80d(50_000, 0, { spouseIsSenior: true })] }));
  assert.equal(result.deductionAdjustments[0].capPaise, rupees(50_000));
  assert.equal(result.deductionAdjustments[0].allowedPaise, rupees(50_000));
});

test("80D parents: ₹25,000 cap, or ₹50,000 when a parent is a senior citizen", () => {
  const standard = calculateTax(oldInput(10_00_000, { deductions: [d80d(0, 30_000)] }));
  assert.deepEqual(standard.deductionAdjustments, [
    { component: "80D-parents", declaredPaise: rupees(30_000), allowedPaise: rupees(25_000), capPaise: rupees(25_000) },
  ]);

  const senior = calculateTax(oldInput(10_00_000, { deductions: [d80d(0, 60_000, { anyParentIsSenior: true })] }));
  assert.equal(senior.deductionAdjustments[0].capPaise, rupees(50_000));
  assert.equal(senior.deductionAdjustments[0].allowedPaise, rupees(50_000));
  assert.equal(capExcessNodes(senior, "Section 80D")[0].amountPaise, rupees(10_000));
  assertReconciles(senior);
});

test("a senior taxpayer does not raise the parents cap", () => {
  const result = calculateTax(oldInput(10_00_000, { ageCategory: "senior", deductions: [d80d(0, 40_000)] }));
  assert.equal(result.deductionAdjustments[0].capPaise, rupees(25_000));
  assert.equal(result.deductionAdjustments[0].allowedPaise, rupees(25_000));
});

test("80D self/family and parents are capped independently and both apply", () => {
  const result = calculateTax(oldInput(10_00_000, { deductions: [d80d(25_000, 50_000, { anyParentIsSenior: true })] }));
  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 25_000 + 50_000));
  assert.deepEqual(
    result.deductionAdjustments.map((a) => a.component),
    ["80D-self-family", "80D-parents"],
  );
  assertReconciles(result);
});

test("an 80D declaration of zero adds no deduction and no adjustment", () => {
  const result = calculateTax(oldInput(10_00_000, { deductions: [d80d(0, 0)] }));
  assert.equal(result.totalDeductionsPaise, rupees(50_000));
  assert.deepEqual(result.deductionAdjustments, []);
  assertReconciles(result);
});

test("80C and 80D together: each is capped on its own", () => {
  const result = calculateTax(oldInput(10_00_000, { deductions: [d80c(3_00_000), d80d(40_000, 10_000)] }));
  // standard 50,000 + 80C 1,50,000 + 80D self/family 25,000 + parents 10,000
  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 1_50_000 + 25_000 + 10_000));
  assert.equal(result.taxableIncomePaise, rupees(10_00_000 - 2_35_000));
  assertReconciles(result);
});

// ---------------------------------------------------------------------------
// Validation: duplicates, shapes
// ---------------------------------------------------------------------------

test("a duplicated deduction section is rejected, not silently double-counted", () => {
  assert.throws(
    () => calculateTax(oldInput(20_00_000, { deductions: [d80c(1_50_000), d80c(1_50_000)] })),
    (e: unknown) => e instanceof TaxInputValidationError && /duplicate/i.test(e.message) && /80C/.test(e.message),
  );
  assert.throws(
    () => calculateTax(oldInput(20_00_000, { deductions: [d80d(10_000, 0), d80d(0, 10_000)] })),
    (e: unknown) => e instanceof TaxInputValidationError && /duplicate/i.test(e.message) && /80D/.test(e.message),
  );
});

test("the old single-amount 80D shape is rejected with a clear message", () => {
  const legacy = { section: "80D", amountPaise: rupees(25_000) } as unknown as DeductionInput;
  assert.throws(
    () => calculateTax(oldInput(10_00_000, { deductions: [legacy] })),
    (e: unknown) => e instanceof TaxInputValidationError && /selfFamilyPaise/.test(e.message),
  );
});

test("80D rejects negative, fractional, and non-boolean inputs", () => {
  const bad = (partial: Record<string, unknown>) =>
    ({ section: "80D", selfFamilyPaise: 0, parentsPaise: 0, ...partial }) as unknown as DeductionInput;
  for (const deduction of [
    bad({ selfFamilyPaise: -1 }),
    bad({ parentsPaise: -1 }),
    bad({ selfFamilyPaise: 1.5 }),
    bad({ parentsPaise: Number.NaN }),
    bad({ spouseIsSenior: "yes" }),
    bad({ anyParentIsSenior: 1 }),
  ]) {
    assert.throws(() => calculateTax(oldInput(10_00_000, { deductions: [deduction] })), TaxInputValidationError);
  }
});

test("declared deductions are still refused under the new regime", () => {
  for (const deduction of [d80c(1_50_000), d80d(25_000, 0)]) {
    assert.throws(
      () => calculateTax(oldInput(10_00_000, { regime: "new", deductions: [deduction] })),
      UnsupportedTaxRuleError,
    );
  }
});

test("results without deductions carry an empty adjustment list", () => {
  assert.deepEqual(calculateTax(oldInput(8_00_000)).deductionAdjustments, []);
  assert.deepEqual(calculateTax(oldInput(8_00_000, { regime: "new" })).deductionAdjustments, []);
});

test("caps apply before the deduction-exceeds-income floor, and both stay visible and reconcile", () => {
  // Salary ₹2,00,000: standard deduction ₹50,000 leaves ₹1,50,000 of income.
  // 80C ₹3,00,000 clamps to ₹1,50,000, then 80D ₹25,000 pushes past the income.
  const result = calculateTax(oldInput(2_00_000, { deductions: [d80c(3_00_000), d80d(25_000, 0)] }));
  assert.equal(result.taxableIncomePaise, 0);
  assert.equal(result.totalTaxPaise, 0);
  assert.equal(capExcessNodes(result, "Section 80CCE").length, 1);
  assert.ok(
    findNodes(result.taxableIncomeTree, (n) => n.label === "Deductions limited to available income").length === 1,
  );
  assertReconciles(result);
});

test("cap adjustments are deterministic and do not mutate the input", () => {
  const input = oldInput(8_00_000, { deductions: [d80c(2_00_000), d80d(30_000, 60_000, { anyParentIsSenior: true })] });
  const snapshot = JSON.stringify(input);
  const first = calculateTax(input);
  const second = calculateTax(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// Old-regime Section 87A: above the ₹5,00,000 threshold there is simply no rebate
// ---------------------------------------------------------------------------

test("old regime, exactly ₹5,00,000: fully rebated to zero", () => {
  const result = calculateTax(otherIncomeInput(5_00_000));
  assert.equal(result.taxBeforeRebatePaise, rupees(12_500));
  assert.equal(result.rebatePaise, rupees(12_500));
  assert.equal(result.totalTaxPaise, 0);
  assertReconciles(result);
});

test("old regime, just above ₹5,00,000: no rebate and no refusal", () => {
  const result = calculateTax(otherIncomeInput(5_00_006)); // 288A rounds to ₹5,00,010
  assert.equal(result.taxableIncomePaise, rupees(5_00_010));
  assert.equal(result.taxBeforeRebatePaise, 1_250_200); // ₹12,500 + 20% of ₹10
  assert.equal(result.rebatePaise, 0);
  assert.equal(result.cessPaise, 50_008);
  assert.equal(result.totalTaxPaise, rupees(13_000)); // 13,002.08 -> 288B -> ₹13,000
  const rebate = findNodes(result.tree, (n) => n.kind === "rebate");
  assert.equal(rebate.length, 1);
  assert.equal(rebate[0].amountPaise, 0);
  assert.match(rebate[0].label, /not applicable/);
  assertReconciles(result);
});

test("old regime across the former refusal band: normal slab tax, no rebate", () => {
  // ₹5,10,000: 12,500 + 20% of 10,000 = 14,500; +4% cess = 15,080.
  const mid = calculateTax(otherIncomeInput(5_10_000));
  assert.equal(mid.rebatePaise, 0);
  assert.equal(mid.totalTaxPaise, rupees(15_080));
  assertReconciles(mid);

  // Continuous, with no throw, from just above the threshold through ₹5,20,000.
  for (const income of [5_00_010, 5_05_000, 5_12_600, 5_15_620, 5_20_000]) {
    const r = calculateTax(otherIncomeInput(income));
    assert.equal(r.rebatePaise, 0, `no rebate at ₹${income}`);
    assertReconciles(r);
  }
});

test("old regime senior citizen: rebate at exactly ₹5,00,000, none just above", () => {
  const at = calculateTax(otherIncomeInput(5_00_000, { ageCategory: "senior" }));
  assert.equal(at.taxBeforeRebatePaise, rupees(10_000));
  assert.equal(at.rebatePaise, rupees(10_000));
  assert.equal(at.totalTaxPaise, 0);

  const above = calculateTax(otherIncomeInput(5_00_006, { ageCategory: "senior" }));
  assert.equal(above.rebatePaise, 0);
  assert.equal(above.totalTaxPaise, rupees(10_400)); // 10,002 + 4% cess = 10,402.08 -> 10,400
  assertReconciles(above);
});

test("new regime is unchanged: verified marginal relief still applies just above ₹12,00,000", () => {
  const result = calculateTax(
    oldInput(0, {
      regime: "new",
      incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(12_00_006) }],
    }),
  );
  assert.equal(result.taxableIncomePaise, rupees(12_00_010));
  assert.equal(result.taxBeforeRebatePaise - result.rebatePaise, 1000); // capped to the ₹10 excess
  assertReconciles(result);
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

test("engine and rules versions were bumped because trusted tax behaviour changed", () => {
  const result = calculateTax(oldInput(8_00_000));
  assert.equal(ENGINE_VERSION, "tax-engine-v2");
  assert.equal(result.engineVersion, "tax-engine-v2");
  assert.equal(result.rulesVersion, "ay-2026-27-v3");
});
