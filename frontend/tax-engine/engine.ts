// Public entry point. This is the ONLY function outside code should call.
//
// Purity contract: nothing in this file (or anything it imports from
// ./compute, ./slabs, ./rebate, ./cess, ./surcharge, ./rounding, ./rules)
// touches auth(), a database, Drizzle, a service, an API route, fetch(),
// or any network API. Given the same input, calculateTax always returns
// the same output — that's what makes it independently testable and
// what makes it safe for a future AI assistant to call without ever
// needing to compute tax numbers itself (see the project's core
// architectural rule: the LLM must never calculate trusted tax numbers
// itself).
import {
  aggregateIncome,
  applyDeductions,
  computeTaxableIncome,
  reconcile,
  validateInput,
} from "./compute";
import { computeCess } from "./cess";
import { roundToNearestTenRupees } from "./rounding";
import { computeRebate } from "./rebate";
import { computeSlabTax } from "./slabs";
import { computeSurcharge } from "./surcharge";
import { resolveAssessmentYearRules } from "./rules";
import { TaxEngineInternalError, type ComputationNode, type TaxInput, type TaxResult } from "./types";

export const ENGINE_VERSION = "tax-engine-v2";

export function calculateTax(input: TaxInput): TaxResult {
  // 1. Validate input (including the now-required ageCategory).
  validateInput(input);

  // 2. Resolve AY rules — throws UnsupportedAssessmentYearError, never
  //    falls back to a different year's rules.
  const ayRules = resolveAssessmentYearRules(input.assessmentYearLabel);
  const regimeRules = ayRules.regimes[input.regime];
  // Old regime: genuinely age-dependent slabs. New regime: `slabs` maps
  // every age category to the SAME table (Section 115BAC does not vary
  // by age) — so this lookup is correct and age-ignoring by construction
  // for the new regime, with no conditional logic needed here.
  const slabs = regimeRules.slabs[input.ageCategory];

  // 3. Aggregate income.
  const { grossTotalIncomePaise, salaryIncomePaise, node: grossTotalIncomeNode } = aggregateIncome(
    input.incomeSources,
  );

  // 4. Apply supported deductions (standard deduction always; declared
  //    80C/80D only where the regime's eligibility is verified as
  //    permitted — throws UnsupportedTaxRuleError otherwise, with a
  //    regime-specific message).
  const { totalDeductionsPaise, nodes: deductionNodes, adjustments: deductionAdjustments } = applyDeductions(
    salaryIncomePaise,
    input.deductions,
    regimeRules,
    input.regime,
    ayRules.supportedDeductionSections,
    ayRules.deductionLimits,
    input.ageCategory,
  );

  // 5-6. Taxable income: floored at zero, then Section 288A rounding
  //    applied (with an honest plug node for each adjustment, if it
  //    actually changed the figure).
  const { taxableIncomePaise, node: taxableIncomeNode } = computeTaxableIncome(
    grossTotalIncomeNode,
    totalDeductionsPaise,
    deductionNodes,
  );

  // 7. Slab tax, computed on the ROUNDED taxable income.
  const slabComputation = computeSlabTax(taxableIncomePaise, slabs);
  const slabTaxNode: ComputationNode = {
    label: "Slab Tax",
    amountPaise: slabComputation.totalTaxPaise,
    kind: "slab_tax",
    sourceSection: null,
    children: slabComputation.nodes,
  };

  // 8. Rebate (Section 87A). Both regimes: the rebate applies up to the
  //    regime's maximum when taxable income is at or below its threshold.
  //    Above the threshold, the new regime gets marginal relief
  //    (implemented and verified — see rebate.ts); the old regime gets NO
  //    rebate and no marginal relief, and the engine does not refuse: it
  //    computes normally, because the Income Tax Department's guidance
  //    describes marginal relief for surcharge only. (Earlier versions
  //    refused the old-regime band above the threshold; Phase 3 removed
  //    that refusal.)
  const rebateNode = computeRebate(taxableIncomePaise, slabComputation.totalTaxPaise, regimeRules.rebate, input.regime);
  const taxAfterRebatePaise = slabComputation.totalTaxPaise + rebateNode.amountPaise; // rebateNode.amountPaise is <= 0

  // 9. Surcharge — real bracket table with verified marginal relief at
  //    each threshold (distinct from, and computed independently of,
  //    87A's marginal relief above). Needs `slabs` to compute "tax
  //    payable at the threshold" per the relief formula — see
  //    surcharge.ts.
  const surchargeNode = computeSurcharge(taxableIncomePaise, taxAfterRebatePaise, slabs, regimeRules.surchargeBrackets);
  const taxAfterSurchargePaise = taxAfterRebatePaise + surchargeNode.amountPaise;

  // 10. Cess, on (tax after rebate + surcharge).
  const cessNode = computeCess(taxAfterSurchargePaise, ayRules.cessRateBasisPoints);
  const taxBeforeFinalRoundingPaise = taxAfterSurchargePaise + cessNode.amountPaise;

  // 11. Section 288B: round final tax payable to the nearest ₹10. Same
  //    "only add a node if it actually changed something" discipline as
  //    288A above.
  const totalTaxPaise = roundToNearestTenRupees(taxBeforeFinalRoundingPaise);
  const finalRoundingDeltaPaise = totalTaxPaise - taxBeforeFinalRoundingPaise;

  const totalChildren: ComputationNode[] = [slabTaxNode, rebateNode, surchargeNode, cessNode];
  if (finalRoundingDeltaPaise !== 0) {
    totalChildren.push({
      label: "Section 288B rounding",
      amountPaise: finalRoundingDeltaPaise,
      kind: "cess", // signed adjustment alongside the other tax-scale components; not a fresh concept of its own
      sourceSection: "Section 288B",
      children: [],
    });
  }

  // 12. Build the computation tree, verify BOTH trees reconcile.
  //
  // `total`'s children are exactly its tax-scale components — NOT
  // `taxableIncomeNode`, which is an income-scale figure. Mixing it in
  // would make "parent = sum of children" false for `total` (it would
  // need a kind-aware filter to reconcile), which a generic UI or an AI
  // narrating the tree could not safely assume without hidden knowledge.
  // The income derivation is still fully available — as its own,
  // independently-reconciling tree, returned below as `taxableIncomeTree`.
  const totalNode: ComputationNode = {
    label: "Total Tax",
    amountPaise: totalTaxPaise,
    kind: "total",
    sourceSection: null,
    children: totalChildren,
  };

  if (!reconcile(totalNode) || !reconcile(taxableIncomeNode)) {
    // This would indicate a bug in the engine itself, not a bad input —
    // never silently return a result that fails its own reconciliation.
    throw new TaxEngineInternalError(
      "Tax engine internal error: computation tree failed reconciliation. This is an engine bug, not " +
      "a user input problem — please report it rather than trusting this result.",
    );
  }

  // 13. Return the deterministic result.
  return {
    engineVersion: ENGINE_VERSION,
    rulesVersion: ayRules.rulesVersion,
    assessmentYearLabel: ayRules.assessmentYearLabel,
    regime: input.regime,
    ageCategory: input.ageCategory,
    grossTotalIncomePaise,
    totalDeductionsPaise,
    deductionAdjustments,
    taxableIncomePaise,
    taxBeforeRebatePaise: slabComputation.totalTaxPaise,
    // Math.abs, not unary `-`: rebateNode.amountPaise is always <= 0 by
    // construction, but negating an exact 0 in JS produces -0, which is
    // not === 0 under SameValue comparison (e.g. Node's assert.strict).
    rebatePaise: Math.abs(rebateNode.amountPaise),
    surchargePaise: surchargeNode.amountPaise,
    cessPaise: cessNode.amountPaise,
    totalTaxPaise,
    tree: totalNode,
    taxableIncomeTree: taxableIncomeNode,
  };
}
