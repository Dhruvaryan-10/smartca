// Tax-engine tests. Every test here is pure — no database, no session,
// no network — matching the engine's own purity contract. Expected
// values below are hand-computed against the AY 2026-27 rules (see
// frontend/tax-engine/rules/ay-2026-27.ts), not derived from the code
// under test, so a systematic bug in the engine would actually be
// caught rather than tautologically confirmed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateTax,
  ENGINE_VERSION,
  TaxInputValidationError,
  UnsupportedAssessmentYearError,
  UnsupportedTaxRuleError,
} from "../tax-engine";
import { reconcile } from "../tax-engine/compute";
import { roundToNearestTenRupees } from "../tax-engine/rounding";
import type { TaxInput } from "../tax-engine";

const rupees = (r: number) => r * 100; // convert whole rupees to paise for readable test fixtures

function newRegimeInput(salaryRupees: number, overrides: Partial<TaxInput> = {}): TaxInput {
  return {
    assessmentYearLabel: "2026-27",
    regime: "new",
    ageCategory: "below60",
    incomeSources: [{ kind: "salary", label: "Salary", amountPaise: rupees(salaryRupees) }],
    deductions: [],
    ...overrides,
  };
}

function oldRegimeInput(salaryRupees: number, overrides: Partial<TaxInput> = {}): TaxInput {
  return {
    assessmentYearLabel: "2026-27",
    regime: "old",
    ageCategory: "below60",
    incomeSources: [{ kind: "salary", label: "Salary", amountPaise: rupees(salaryRupees) }],
    deductions: [],
    ...overrides,
  };
}

/**
 * Every test that produces a result should call this — no exceptions.
 * Checks BOTH independently-reconciling trees: `tree` (the tax
 * derivation: total = slab_tax + rebate + surcharge + cess, uniformly,
 * with no node-kind special case) and `taxableIncomeTree` (the income
 * derivation: taxable_income = gross_total_income + deductions). See
 * the Phase 1C-A computation-tree audit for why these are two separate
 * trees rather than one nested tree with a hidden exception.
 */
function assertReconciles(result: ReturnType<typeof calculateTax>) {
  assert.equal(reconcile(result.tree), true, "tax computation tree must reconcile exactly in integer paise");
  assert.equal(
    reconcile(result.taxableIncomeTree),
    true,
    "taxable income tree must reconcile exactly in integer paise",
  );
}

// --- 1. Zero income ---------------------------------------------------

test("1. zero income produces zero tax and a reconciling tree", () => {
  const result = calculateTax(newRegimeInput(0));
  assert.equal(result.grossTotalIncomePaise, 0);
  assert.equal(result.taxableIncomePaise, 0);
  assert.equal(result.taxBeforeRebatePaise, 0);
  assert.equal(result.totalTaxPaise, 0);
  assertReconciles(result);
});

// --- 2-7. New-regime slab boundaries (exact, cumulative tax before rebate) ---
// Note: salary alone, no standard deduction applied intentionally here —
// these use `other` income (not salary-kind) so the standard deduction
// (which only applies against salary) doesn't shift the taxable-income
// boundary away from the round numbers being tested.

const NEW_REGIME_BOUNDARIES: { label: string; incomeRupees: number; taxBeforeRebateRupees: number }[] = [
  { label: "2. ₹4,00,000 boundary", incomeRupees: 4_00_000, taxBeforeRebateRupees: 0 },
  { label: "3. ₹8,00,000 boundary", incomeRupees: 8_00_000, taxBeforeRebateRupees: 20_000 },
  { label: "4. ₹12,00,000 boundary", incomeRupees: 12_00_000, taxBeforeRebateRupees: 60_000 },
  { label: "5. ₹16,00,000 boundary", incomeRupees: 16_00_000, taxBeforeRebateRupees: 1_20_000 },
  { label: "6. ₹20,00,000 boundary", incomeRupees: 20_00_000, taxBeforeRebateRupees: 2_00_000 },
  { label: "7. ₹24,00,000 boundary", incomeRupees: 24_00_000, taxBeforeRebateRupees: 3_00_000 },
];

for (const { label, incomeRupees, taxBeforeRebateRupees } of NEW_REGIME_BOUNDARIES) {
  test(label, () => {
    const result = calculateTax(
      newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(incomeRupees) }] }),
    );
    assert.equal(result.taxBeforeRebatePaise, rupees(taxBeforeRebateRupees));
    assertReconciles(result);
  });
}

test("6b. ₹20,00,000 boundary: total tax after cess (no rebate applies above ₹12L)", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(20_00_000) }] }),
  );
  assert.equal(result.rebatePaise, 0);
  assert.equal(result.cessPaise, rupees(8_000)); // 4% of ₹2,00,000
  assert.equal(result.totalTaxPaise, rupees(2_08_000));
  assertReconciles(result);
});

// --- 8. ₹1 above a boundary ------------------------------------------

// Note: a literal "₹1 above" a round-lakh boundary rounds straight back
// DOWN to the boundary under Section 288A (last digit 1 < 5), so these
// use ₹6 above instead — the smallest offset whose last digit (6 >= 5)
// survives rounding by moving up to the next ₹10, giving a genuine,
// still-tiny excess into the next slab.

test("8. just above the ₹4,00,000 new-regime boundary (survives 288A rounding) taxes only the rounded excess at 5%", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(4_00_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(4_00_010)); // 288A: 4,00,006 -> 4,00,010
  // ₹10 into the 5% bracket = 50 paise.
  assert.equal(result.taxBeforeRebatePaise, 50);
  assertReconciles(result);
});

test("8b. just above the ₹2,50,000 old-regime boundary (survives 288A rounding) taxes only the rounded excess at 5%", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(2_50_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(2_50_010));
  assert.equal(result.taxBeforeRebatePaise, 50);
  assertReconciles(result);
});

// --- 9. Old-regime boundaries -----------------------------------------

const OLD_REGIME_BOUNDARIES: { label: string; incomeRupees: number; taxBeforeRebateRupees: number }[] = [
  { label: "9a. old regime ₹2,50,000 boundary", incomeRupees: 2_50_000, taxBeforeRebateRupees: 0 },
  { label: "9b. old regime ₹5,00,000 boundary", incomeRupees: 5_00_000, taxBeforeRebateRupees: 12_500 },
  { label: "9c. old regime ₹10,00,000 boundary", incomeRupees: 10_00_000, taxBeforeRebateRupees: 1_12_500 },
];

for (const { label, incomeRupees, taxBeforeRebateRupees } of OLD_REGIME_BOUNDARIES) {
  test(label, () => {
    const result = calculateTax(
      oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(incomeRupees) }] }),
    );
    assert.equal(result.taxBeforeRebatePaise, rupees(taxBeforeRebateRupees));
    assertReconciles(result);
  });
}

// --- 10-11. Standard deduction -----------------------------------------

test("10. new-regime standard deduction (₹75,000) reduces taxable income, capped at salary", () => {
  const result = calculateTax(newRegimeInput(8_00_000)); // salary-kind income
  assert.equal(result.grossTotalIncomePaise, rupees(8_00_000));
  assert.equal(result.totalDeductionsPaise, rupees(75_000));
  assert.equal(result.taxableIncomePaise, rupees(7_25_000));
  assertReconciles(result);
});

test("11. old-regime standard deduction (₹50,000) reduces taxable income, capped at salary", () => {
  const result = calculateTax(oldRegimeInput(8_00_000));
  assert.equal(result.totalDeductionsPaise, rupees(50_000));
  assert.equal(result.taxableIncomePaise, rupees(7_50_000));
  assertReconciles(result);
});

test("standard deduction is capped at actual salary income (never creates negative income)", () => {
  const result = calculateTax(newRegimeInput(30_000)); // salary less than the ₹75,000 deduction
  assert.equal(result.totalDeductionsPaise, rupees(30_000)); // capped, not the full 75,000
  assert.equal(result.taxableIncomePaise, 0);
  assertReconciles(result);
});

// --- 12-13. Section 87A threshold behavior, both regimes ----------------

test("12. old-regime 87A: taxable income exactly at ₹5,00,000 threshold is fully rebated to zero", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_000) }] }),
  );
  assert.equal(result.rebatePaise, rupees(12_500));
  assert.equal(result.totalTaxPaise, 0);
  assertReconciles(result);
});

test("13. new-regime 87A: taxable income exactly at ₹12,00,000 threshold is fully rebated to zero", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(12_00_000) }] }),
  );
  assert.equal(result.rebatePaise, rupees(60_000));
  assert.equal(result.totalTaxPaise, 0);
  assertReconciles(result);
});

test("new regime, just above ₹12,00,000: verified marginal relief now computes a real result (no longer refused)", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(12_00_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(12_00_010)); // 288A rounding
  // excess over ₹12,00,000 = ₹10 = 1000 paise. Uncapped slab tax on
  // ₹12,00,010 = ₹60,000 (cumulative to 12L) + ₹10 * 15% = ₹60,001.50 =
  // 6,000,150 paise, which vastly exceeds the ₹10 excess — so relief
  // caps tax-after-rebate to exactly the excess.
  assert.equal(result.taxBeforeRebatePaise, 6_000_150);
  assert.equal(result.rebatePaise, 6_000_150 - 1000);
  const taxAfterRebate = result.taxBeforeRebatePaise - result.rebatePaise;
  assert.equal(taxAfterRebate, 1000); // exactly the excess income — the relief cap
  assertReconciles(result);
});

test("old regime, just above ₹5,00,000: marginal relief remains unverified and blocked (distinct from the new-regime formula)", () => {
  assert.throws(
    () =>
      calculateTax(
        oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_006) }] }),
      ),
    UnsupportedTaxRuleError,
  );
});

test("well above the 87A threshold (relief cannot possibly matter) computes normally, zero rebate", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(20_00_000) }] }),
  );
  assert.equal(result.rebatePaise, 0);
  assertReconciles(result);
});

// --- 14. Cess -----------------------------------------------------------

test("14. cess is exactly 4% of tax after rebate, floored to the paise", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(10_00_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(1_12_500));
  assert.equal(result.rebatePaise, 0); // well above the ₹5L threshold, no relief needed
  assert.equal(result.cessPaise, rupees(4_500)); // 4% of 1,12,500
  assert.equal(result.totalTaxPaise, rupees(1_17_000));
  assertReconciles(result);
});

// --- 15-16. Deductions ---------------------------------------------------

test("15. supported 80C deduction under the old regime reduces taxable income and tax", () => {
  const result = calculateTax(
    oldRegimeInput(8_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] }),
  );
  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 1_50_000)); // standard deduction + 80C
  assert.equal(result.taxableIncomePaise, rupees(6_00_000));
  assert.equal(result.taxBeforeRebatePaise, rupees(32_500));
  assert.equal(result.rebatePaise, 0);
  assert.equal(result.cessPaise, rupees(1_300));
  assert.equal(result.totalTaxPaise, rupees(33_800));
  assertReconciles(result);
});

test("15b. supported 80D deduction under the old regime is accepted alongside 80C", () => {
  const result = calculateTax(
    oldRegimeInput(8_00_000, {
      deductions: [
        { section: "80C", amountPaise: rupees(1_50_000) },
        { section: "80D", amountPaise: rupees(25_000) },
      ],
    }),
  );
  assert.equal(result.totalDeductionsPaise, rupees(50_000 + 1_50_000 + 25_000));
  assertReconciles(result);
});

test("16. an unsupported deduction section is rejected with a validation error, not silently accepted", () => {
  assert.throws(
    () => calculateTax(oldRegimeInput(8_00_000, { deductions: [{ section: "80G", amountPaise: rupees(10_000) }] })),
    TaxInputValidationError,
  );
});

test("a recognized section (80C) declared under the NEW regime is refused — eligibility unverified, not assumed", () => {
  assert.throws(
    () => calculateTax(newRegimeInput(8_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] })),
    UnsupportedTaxRuleError,
  );
});

test("new regime with NO declared deductions computes normally (only the standard deduction applies)", () => {
  const result = calculateTax(newRegimeInput(8_00_000));
  assertReconciles(result);
});

// --- 17-18. Invalid inputs -----------------------------------------------

test("17. negative income is rejected", () => {
  assert.throws(
    () => calculateTax(newRegimeInput(0, { incomeSources: [{ kind: "salary", label: "Salary", amountPaise: -1 }] })),
    TaxInputValidationError,
  );
});

test("negative deduction amount is rejected", () => {
  assert.throws(
    () => calculateTax(oldRegimeInput(8_00_000, { deductions: [{ section: "80C", amountPaise: -1 }] })),
    TaxInputValidationError,
  );
});

test("18. non-integer paise is rejected", () => {
  assert.throws(
    () =>
      calculateTax(newRegimeInput(0, { incomeSources: [{ kind: "salary", label: "Salary", amountPaise: 100.5 }] })),
    TaxInputValidationError,
  );
});

// --- 19. Unsupported assessment year --------------------------------------

test("19. an unregistered assessment year fails clearly and never falls back to another year's rules", () => {
  assert.throws(
    () => calculateTax(newRegimeInput(8_00_000, { assessmentYearLabel: "2099-00" })),
    UnsupportedAssessmentYearError,
  );
});

// --- 20. Invalid regime ----------------------------------------------------

test("20. an invalid regime value is rejected rather than silently defaulted", () => {
  assert.throws(
    () => calculateTax({ ...newRegimeInput(8_00_000), regime: "flat" as never }),
    TaxInputValidationError,
  );
});

test("invalid income source kind is rejected", () => {
  assert.throws(
    () =>
      calculateTax(
        newRegimeInput(0, {
          incomeSources: [{ kind: "rental" as never, label: "Rent", amountPaise: rupees(1_00_000) }],
        }),
      ),
    TaxInputValidationError,
  );
});

// --- 21. Deterministic repeatability ---------------------------------------

test("21. calculateTax is deterministic — identical input produces byte-identical output", () => {
  const input = oldRegimeInput(8_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] });
  const first = calculateTax(input);
  const second = calculateTax(input);
  assert.deepEqual(first, second);
});

// --- 22. Computation-tree reconciliation (broad sweep) ----------------------

test("22. computation tree reconciles exactly, in integer paise, across a range of realistic inputs", () => {
  const cases: TaxInput[] = [
    newRegimeInput(0),
    newRegimeInput(5_00_000),
    newRegimeInput(12_75_000),
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(30_00_000) }] }),
    oldRegimeInput(6_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_00_000) }] }),
    oldRegimeInput(0, {
      incomeSources: [
        { kind: "salary", label: "Salary", amountPaise: rupees(4_00_000) },
        { kind: "business", label: "Freelance", amountPaise: rupees(2_00_000) },
        { kind: "other", label: "Bank Interest", amountPaise: rupees(50_000) },
      ],
    }),
  ];
  for (const input of cases) {
    const result = calculateTax(input);
    assertReconciles(result);
  }
});

test("reconciliation also holds when deductions exceed available income (taxable income floored at zero)", () => {
  const result = calculateTax(
    oldRegimeInput(0, {
      incomeSources: [{ kind: "salary", label: "Salary", amountPaise: rupees(40_000) }],
      deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }],
    }),
  );
  assert.equal(result.taxableIncomePaise, 0);
  assertReconciles(result);
});

// --- 23. Old vs new regime remain independently isolated --------------------

test("23. identical income under old vs new regime produces independently correct, non-leaking results", () => {
  const incomeSources: TaxInput["incomeSources"] = [
    { kind: "salary", label: "Salary", amountPaise: rupees(9_00_000) },
  ];
  const oldResult = calculateTax({
    assessmentYearLabel: "2026-27",
    regime: "old",
    ageCategory: "below60",
    incomeSources,
    deductions: [],
  });
  const newResult = calculateTax({
    assessmentYearLabel: "2026-27",
    regime: "new",
    ageCategory: "below60",
    incomeSources,
    deductions: [],
  });
  assert.equal(oldResult.regime, "old");
  assert.equal(newResult.regime, "new");
  assert.notEqual(oldResult.totalDeductionsPaise, newResult.totalDeductionsPaise); // ₹50,000 vs ₹75,000 standard deduction
  assert.notEqual(oldResult.totalTaxPaise, newResult.totalTaxPaise);
  assertReconciles(oldResult);
  assertReconciles(newResult);
});

// --- 24. Income-source aggregation -------------------------------------------

test("24. multiple income sources of the same kind are aggregated correctly under one gross total", () => {
  const result = calculateTax(
    newRegimeInput(0, {
      incomeSources: [
        { kind: "salary", label: "Primary Job", amountPaise: rupees(5_00_000) },
        { kind: "other", label: "Bank Interest", amountPaise: rupees(20_000) },
        { kind: "other", label: "Dividend", amountPaise: rupees(10_000) },
      ],
    }),
  );
  assert.equal(result.grossTotalIncomePaise, rupees(5_00_000 + 20_000 + 10_000));
  // Standard deduction only applies against the salary-kind portion.
  assert.equal(result.totalDeductionsPaise, rupees(75_000));
  assertReconciles(result);
});

// --- Engine identity / metadata --------------------------------------------

test("engineVersion and rulesVersion are stamped on every result", () => {
  const result = calculateTax(newRegimeInput(5_00_000));
  assert.equal(result.engineVersion, ENGINE_VERSION);
  assert.equal(result.rulesVersion, "ay-2026-27-v2");
  assert.equal(result.assessmentYearLabel, "2026-27");
});

test("no auth/database/network dependency: this module can be imported and run with no environment configured", () => {
  // If this test file needed DATABASE_URL, AUTH_SECRET, or a running
  // Postgres instance, it would already have failed by this point — it
  // deliberately does NOT import ../db/load-env like every other test
  // file in this repo, proving the engine has no such dependency.
  const result = calculateTax(newRegimeInput(1_00_000));
  assert.ok(result);
});

// --- Computation-tree audit: `total` reconciles with NO node-kind
// exception, and `taxable_income` is never nested inside it. -------------
// (Phase 1C-A follow-up audit: the tree previously required a
// kind-aware filter to reconcile `total`, which a generic UI or an AI
// narrating the tree could not safely assume without hidden knowledge.
// These tests assert the invariant directly, independent of the
// reconcile() helper, so a regression here fails loudly and specifically.)

test("`total`'s children are exactly its tax-scale components — no `taxable_income` node mixed in", () => {
  const result = calculateTax(oldRegimeInput(8_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] }));

  assert.equal(result.tree.kind, "total");
  const childKinds = result.tree.children.map((c) => c.kind).sort();
  assert.deepEqual(childKinds, ["cess", "rebate", "slab_tax", "surcharge"]);
  assert.ok(
    !result.tree.children.some((c) => c.kind === "taxable_income" || c.kind === "gross_total_income"),
    "total must never nest an income-scale node among its tax-scale children",
  );
});

test("`total.amountPaise` equals a plain, unfiltered sum of its children — no kind-aware exception required", () => {
  const result = calculateTax(newRegimeInput(20_00_000));
  const blindSum = result.tree.children.reduce((sum, c) => sum + c.amountPaise, 0);
  assert.equal(result.tree.amountPaise, blindSum);
  assert.equal(result.tree.amountPaise, result.totalTaxPaise);
});

test("`taxableIncomeTree` is returned separately and reconciles independently with a plain sum", () => {
  const result = calculateTax(oldRegimeInput(8_00_000, { deductions: [{ section: "80C", amountPaise: rupees(1_50_000) }] }));

  assert.equal(result.taxableIncomeTree.kind, "taxable_income");
  const blindSum = result.taxableIncomeTree.children.reduce((sum, c) => sum + c.amountPaise, 0);
  assert.equal(result.taxableIncomeTree.amountPaise, blindSum);
  assert.equal(result.taxableIncomeTree.amountPaise, result.taxableIncomePaise);
  // And its own gross_total_income child is present and intact (not
  // stripped out along with removing it from `total`).
  assert.ok(result.taxableIncomeTree.children.some((c) => c.kind === "gross_total_income"));
});

// --- 25. Statutory rounding (Sections 288A/288B) — direct unit tests ---
// Independent of calculateTax: exercises roundToNearestTenRupees()
// itself against the "ignore paise, then round the whole-rupee amount
// to the nearest ₹10 (5 rounds up, below 5 rounds down)" rule.

test("25a. rounding: last digit below 5 rounds down to the nearest ₹10", () => {
  assert.equal(roundToNearestTenRupees(rupees(12)), rupees(10));
  assert.equal(roundToNearestTenRupees(rupees(14)), rupees(10));
});

test("25b. rounding: last digit 5 or above rounds up to the nearest ₹10", () => {
  assert.equal(roundToNearestTenRupees(rupees(15)), rupees(20));
  assert.equal(roundToNearestTenRupees(rupees(16)), rupees(20));
});

test("25c. rounding: an amount already an exact multiple of ₹10 is unchanged", () => {
  assert.equal(roundToNearestTenRupees(rupees(20)), rupees(20));
  assert.equal(roundToNearestTenRupees(0), 0);
});

test("25d. rounding ignores paise entirely — only the whole-rupee amount decides the outcome", () => {
  // ₹12.99 -> ignore paise -> ₹12 -> last digit 2 -> rounds down to ₹10.
  assert.equal(roundToNearestTenRupees(1299), rupees(10));
});

// --- 26. Old-regime age categories: senior and super-senior slabs -------

test("26a. old-regime senior citizen (60+): ₹3,00,000 exemption boundary is nil tax", () => {
  const result = calculateTax(
    oldRegimeInput(0, {
      ageCategory: "senior",
      incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(3_00_000) }],
    }),
  );
  assert.equal(result.taxBeforeRebatePaise, 0);
  assertReconciles(result);
});

test("26b. old-regime senior citizen: ₹5,00,000 boundary taxes only the 3L-5L band at 5%", () => {
  const result = calculateTax(
    oldRegimeInput(0, {
      ageCategory: "senior",
      incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_000) }],
    }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(10_000)); // 5% of ₹2,00,000
  assertReconciles(result);
});

test("26c. old-regime senior citizen: ₹10,00,000 boundary", () => {
  const result = calculateTax(
    oldRegimeInput(0, {
      ageCategory: "senior",
      incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(10_00_000) }],
    }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(1_10_000)); // 10,000 + 20% of ₹5,00,000
  assertReconciles(result);
});

test("26d. old-regime super senior citizen (80+): ₹5,00,000 exemption boundary is nil tax", () => {
  const result = calculateTax(
    oldRegimeInput(0, {
      ageCategory: "superSenior",
      incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_000) }],
    }),
  );
  assert.equal(result.taxBeforeRebatePaise, 0);
  assertReconciles(result);
});

test("26e. old-regime super senior citizen: ₹10,00,000 boundary taxes only the 5L-10L band at 20%", () => {
  const result = calculateTax(
    oldRegimeInput(0, {
      ageCategory: "superSenior",
      incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(10_00_000) }],
    }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(1_00_000)); // 20% of ₹5,00,000
  assertReconciles(result);
});

test("26f. identical old-regime income taxed differently by age category — the age-dependent exemption is real, not cosmetic", () => {
  const incomeSources: TaxInput["incomeSources"] = [{ kind: "other", label: "Other", amountPaise: rupees(3_00_000) }];
  const below60 = calculateTax(oldRegimeInput(0, { ageCategory: "below60", incomeSources }));
  const senior = calculateTax(oldRegimeInput(0, { ageCategory: "senior", incomeSources }));
  const superSenior = calculateTax(oldRegimeInput(0, { ageCategory: "superSenior", incomeSources }));
  assert.equal(below60.taxBeforeRebatePaise, rupees(2_500)); // 5% of ₹50,000 above the ₹2.5L exemption
  assert.equal(senior.taxBeforeRebatePaise, 0); // fully within the ₹3L exemption
  assert.equal(superSenior.taxBeforeRebatePaise, 0); // fully within the ₹5L exemption
  assertReconciles(below60);
  assertReconciles(senior);
  assertReconciles(superSenior);
});

// --- 27. New-regime slabs are age-independent (Section 115BAC) ---------

test("27. new-regime tax is identical across all three age categories for the same income", () => {
  const incomeSources: TaxInput["incomeSources"] = [{ kind: "other", label: "Other", amountPaise: rupees(9_00_000) }];
  const below60 = calculateTax(newRegimeInput(0, { ageCategory: "below60", incomeSources }));
  const senior = calculateTax(newRegimeInput(0, { ageCategory: "senior", incomeSources }));
  const superSenior = calculateTax(newRegimeInput(0, { ageCategory: "superSenior", incomeSources }));
  assert.equal(below60.taxBeforeRebatePaise, senior.taxBeforeRebatePaise);
  assert.equal(senior.taxBeforeRebatePaise, superSenior.taxBeforeRebatePaise);
  assert.equal(below60.totalTaxPaise, senior.totalTaxPaise);
  assert.equal(senior.totalTaxPaise, superSenior.totalTaxPaise);
  assertReconciles(below60);
  assertReconciles(senior);
  assertReconciles(superSenior);
});

// --- 28. New-regime ₹12L marginal relief: mid-zone example and phase-out ---

test("28a. new-regime marginal relief mid-zone: relief is active and caps tax to the excess over ₹12L", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(12_50_000) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(12_50_000));
  assert.equal(result.taxBeforeRebatePaise, rupees(67_500)); // 60,000 (to 12L) + 15% of ₹50,000
  assert.equal(result.rebatePaise, rupees(67_500 - 50_000));
  const taxAfterRebate = result.taxBeforeRebatePaise - result.rebatePaise;
  assert.equal(taxAfterRebate, rupees(50_000)); // exactly the excess over ₹12L
  assertReconciles(result);
});

test("28b. new-regime marginal relief phase-out: once ordinary slab tax no longer exceeds the excess, relief stops applying", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(13_00_000) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(13_00_000));
  assert.equal(result.taxBeforeRebatePaise, rupees(75_000)); // 60,000 (to 12L) + 15% of ₹1,00,000
  assert.equal(result.rebatePaise, 0); // ordinary tax (75,000) <= excess (1,00,000): relief phased out
  assertReconciles(result);
});

// --- 29. Surcharge boundaries and verified marginal relief ---------------
// Surcharge marginal relief IS implemented (verified — see surcharge.ts,
// quoting the Income Tax Department's own rule text): tax + surcharge
// must never exceed (tax payable at the threshold) + (income exceeding
// that threshold). These tests exercise: the exact thresholds (still
// 0%/the lower rate, per the "<=" framing — no crossing has happened
// yet, so no relief question even arises), just below a threshold (deep
// in the lower bracket — relief already phased out), just above a
// threshold (relief active, and strictly positive), well past a
// threshold (relief phases back out to zero as the naive figure catches
// up with the cap), and the point where old and new regimes diverge
// above ₹5Cr — the new regime has NO ₹5Cr threshold at all (Section
// 115BAC caps at 25% with only three thresholds: ₹50L/₹1Cr/₹2Cr), so it
// must never manufacture relief around a nonexistent boundary there.
//
// Expected figures below were independently derived from the official
// formula using exact integer-paise (BigInt) arithmetic in a standalone
// script — not by reading this implementation — then cross-checked
// against the engine's actual output before being hardcoded here.

test("29a. surcharge does not apply at exactly ₹50,00,000 taxable income (old regime)", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(50_00_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(13_12_500));
  assert.equal(result.surchargePaise, 0);
  assertReconciles(result);
});

test("29b. surcharge does not apply at exactly ₹50,00,000 taxable income (new regime)", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(50_00_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(10_80_000));
  assert.equal(result.surchargePaise, 0);
  assertReconciles(result);
});

test("29c. just above ₹50,00,000 (old regime): marginal relief caps a ₹10 income increase to a ₹10 tax increase, not a full 10% surcharge", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(50_00_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(50_00_010)); // 288A rounding
  assert.equal(result.taxBeforeRebatePaise, 131250300); // exact slab tax on ₹50,00,010
  assert.equal(result.surchargePaise, 700); // relieved: naive 10% would be ~₹1,31,250
  assertReconciles(result);
});

test("29d. just above ₹50,00,000 (new regime): marginal relief caps a ₹10 income increase to a ₹10 tax increase, not a full 10% surcharge", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(50_00_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(50_00_010));
  assert.equal(result.taxBeforeRebatePaise, 108000300);
  assert.equal(result.surchargePaise, 700); // relieved: naive 10% would be ~₹1,08,000
  assertReconciles(result);
});

test("29e. ₹51,00,000 (new regime): relief remains active moderately past ₹50L, well short of the naive 10% rate", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(51_00_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(11_10_000));
  assert.equal(result.surchargePaise, rupees(70_000)); // relieved (naive 10% would be ₹1,11,000)
  assertReconciles(result);
});

test("29f. just below ₹1,00,00,000 (new regime, ₹99,99,990): deep in the 50L-1Cr bracket — relief has already phased out to zero", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(99_99_990) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, 257999700);
  assert.equal(result.surchargePaise, 25799970); // full, un-relieved 10% — no relief needed here
  assertReconciles(result);
});

test("29g. exactly ₹1,00,00,000 (new regime): still the 50L-1Cr bracket (strict '>' convention) — 10% surcharge applies cleanly, no relief needed", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(1_00_00_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(25_80_000));
  assert.equal(result.surchargePaise, rupees(2_58_000)); // 10% of 25,80,000
  assertReconciles(result);
});

test("29h. just above ₹1,00,00,000 (new regime): crossing into the 1Cr-2Cr bracket triggers fresh, positive relief", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(1_00_00_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(1_00_00_010));
  assert.equal(result.taxBeforeRebatePaise, 258000300);
  assert.equal(result.surchargePaise, 25800700); // relieved: naive 15% would be ~₹3,87,000
  assertReconciles(result);
});

test("29i. ₹1,00,10,000 (new regime): relief still active a little further past the ₹1Cr threshold", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(1_00_10_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(25_83_000));
  assert.equal(result.surchargePaise, rupees(2_65_000)); // relieved (naive 15% would be ₹3,87,450)
  assertReconciles(result);
});

test("29j. just below ₹2,00,00,000 (new regime, ₹1,99,99,990): deep in the 1Cr-2Cr bracket — relief has phased out to zero", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(1_99_99_990) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, 557999700);
  assert.equal(result.surchargePaise, 83699955); // full, un-relieved 15%
  assertReconciles(result);
});

test("29k. exactly ₹2,00,00,000 (new regime): still the 1Cr-2Cr bracket — 15% surcharge applies cleanly, no relief needed", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(2_00_00_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(55_80_000));
  assert.equal(result.surchargePaise, rupees(8_37_000)); // 15% of 55,80,000
  assertReconciles(result);
});

test("29l. just above ₹2,00,00,000 (new regime): crossing into the >2Cr cap bracket triggers fresh, positive relief", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(2_00_00_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(2_00_00_010));
  assert.equal(result.taxBeforeRebatePaise, 558000300);
  assert.equal(result.surchargePaise, 83700700); // relieved: naive 25% would be ~₹13,95,000
  assertReconciles(result);
});

test("29m. new regime at ₹5,00,00,000 and beyond: still just the 25% cap bracket from ₹2Cr — no relief, and NO extra ₹5Cr threshold exists to relieve around", () => {
  const at5Cr = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_00_000) }] }),
  );
  assert.equal(at5Cr.taxBeforeRebatePaise, rupees(1_45_80_000));
  assert.equal(at5Cr.surchargePaise, rupees(36_45_000)); // full, un-relieved 25% — deep in the >2Cr bracket
  assertReconciles(at5Cr);

  // Crossing ₹5,00,00,000 itself produces no fresh relief event for the
  // new regime — unlike the old regime (29p below), there is no bracket
  // boundary here at all, so nothing to relieve around.
  const justAbove5Cr = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_00_006) }] }),
  );
  assert.equal(justAbove5Cr.surchargePaise, Math.floor((justAbove5Cr.taxBeforeRebatePaise * 2500) / 10000)); // plain, un-relieved 25%

  const at6Cr = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(6_00_00_000) }] }),
  );
  assert.equal(at6Cr.surchargePaise, rupees(43_95_000)); // still 25% — new regime's cap, per Section 115BAC
  assert.equal(at6Cr.totalTaxPaise, rupees(2_28_54_000));
  assertReconciles(at6Cr);
  assertReconciles(justAbove5Cr);
});

test("29n. just below ₹5,00,00,000 (old regime, ₹4,99,99,990): deep in the 2Cr-5Cr bracket — relief has phased out to zero", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(4_99_99_990) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, 1481249700);
  assert.equal(result.surchargePaise, 370312425); // full, un-relieved 25%
  assertReconciles(result);
});

test("29o. exactly ₹5,00,00,000 (old regime): still the 2Cr-5Cr bracket (strict '>' convention) — 25% surcharge applies cleanly", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_00_000) }] }),
  );
  assert.equal(result.taxBeforeRebatePaise, rupees(1_48_12_500));
  assert.equal(result.surchargePaise, rupees(37_03_125)); // 25% of 1,48,12,500
  assertReconciles(result);
});

test("29p. just above ₹5,00,00,000 (old regime): crossing into the 37% bracket triggers fresh, positive relief — the genuine old-regime-only threshold", () => {
  const result = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(5_00_00_006) }] }),
  );
  assert.equal(result.taxableIncomePaise, rupees(5_00_00_010));
  assert.equal(result.taxBeforeRebatePaise, 1481250300);
  assert.equal(result.surchargePaise, 370313200); // relieved: naive 37% would be far larger
  assertReconciles(result);
});

test("29q. old regime steps up to 37% well above ₹5Cr — genuinely different from the new regime's 25% cap at the SAME income", () => {
  const oldAt6Cr = calculateTax(
    oldRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(6_00_00_000) }] }),
  );
  const newAt6Cr = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(6_00_00_000) }] }),
  );
  assert.equal(oldAt6Cr.taxBeforeRebatePaise, rupees(1_78_12_500));
  assert.equal(oldAt6Cr.surchargePaise, rupees(65_90_625)); // full, un-relieved 37% — deep past the ₹5Cr threshold
  assert.equal(oldAt6Cr.totalTaxPaise, rupees(2_53_79_250));
  assert.notEqual(oldAt6Cr.surchargePaise, newAt6Cr.surchargePaise);
  assertReconciles(oldAt6Cr);
  assertReconciles(newAt6Cr);
});

test("29r. cess is charged at 4% of (tax + RELIEVED surcharge), not of the naive pre-relief surcharge", () => {
  const result = calculateTax(
    newRegimeInput(0, { incomeSources: [{ kind: "other", label: "Other", amountPaise: rupees(51_00_000) }] }),
  );
  const taxAfterSurcharge = result.taxBeforeRebatePaise + result.surchargePaise; // rebate is 0 this far above ₹12L
  assert.equal(result.cessPaise, Math.floor((taxAfterSurcharge * 400) / 10000));
  // Sanity: this must be far less than 4% of what a naive (un-relieved) surcharge would have produced.
  const naiveSurcharge = Math.floor((result.taxBeforeRebatePaise * 1000) / 10000);
  assert.ok(result.surchargePaise < naiveSurcharge);
  assertReconciles(result);
});

test("every non-leaf node in BOTH trees reconciles via the exact same rule — no per-node-kind special case remains anywhere", () => {
  const result = calculateTax(
    oldRegimeInput(0, {
      incomeSources: [
        { kind: "salary", label: "Salary", amountPaise: rupees(4_00_000) },
        { kind: "business", label: "Freelance", amountPaise: rupees(2_00_000) },
        { kind: "other", label: "Bank Interest", amountPaise: rupees(50_000) },
      ],
      deductions: [{ section: "80D", amountPaise: rupees(25_000) }],
    }),
  );

  function assertUniformReconciliation(node: ReturnType<typeof calculateTax>["tree"]) {
    if (node.children.length > 0) {
      const sum = node.children.reduce((s, c) => s + c.amountPaise, 0);
      assert.equal(node.amountPaise, sum, `node "${node.label}" (kind: ${node.kind}) must equal sum of its children`);
    }
    for (const child of node.children) assertUniformReconciliation(child);
  }

  assertUniformReconciliation(result.tree);
  assertUniformReconciliation(result.taxableIncomeTree);
});
