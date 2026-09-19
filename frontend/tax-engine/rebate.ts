// Section 87A rebate.
//
// NEW REGIME marginal relief is implemented, verified in the Phase 1C-B
// source audit (independently triangulated three ways: the statutory
// description, a worked numeric example re-derived from first
// principles, and an independently-derived phase-out boundary that
// matched a separately-cited figure — see that report for the full
// evidence).
//
// OLD REGIME has no marginal relief. The Income Tax Department's AY
// 2026-27 guidance states the old-regime rebate as ₹12,500 where "Taxable
// income shall not exceed 5,00,000", and describes marginal relief only
// for surcharge (evidence record: rules/ay-2026-27.ts). Above the threshold
// the old-regime rebate is therefore simply nil. Earlier versions of this
// engine refused that band instead; that refusal was removed in Phase 3.
// Do not add old-regime relief without a primary source that establishes it.
//
// SCOPE: the new-regime formula below is verified and implemented ONLY
// for this engine's ordinary-income model (salary/business/other). Per
// CBDT Circular No. 13/2025, special-rate income (capital gains under
// Sections 111A/112/112A) must be EXCLUDED from this calculation
// entirely — ordinary and special-rate income are taxed, and rebated,
// separately. Since this engine has no capital-gains support at all,
// every paisa it sees is implicitly ordinary income, so the formula
// applies cleanly. The moment capital-gains support is added, this
// function's `taxableIncomePaise` input must be re-scoped to ordinary-
// rate taxable income only — never the blended total.
import type { ComputationNode, RebateRules, TaxRegime } from "./types";

/**
 * Verified new-regime formula (taxable income > threshold):
 *   excessIncome = taxableIncome - threshold
 *   if uncappedTax > excessIncome:  taxAfterRebate = excessIncome        (marginal relief — caps tax to the excess)
 *   else:                            taxAfterRebate = uncappedTax         (relief has phased out; ordinary tax applies)
 *   rebate = uncappedTax - taxAfterRebate                                  (never negative, by construction)
 *
 * At/below the threshold (both regimes), the rebate is simply capped at
 * the lesser of the tax actually owed and the regime's maximum rebate —
 * unchanged from Phase 1C-A, and not dependent on the unverified
 * old-regime marginal-relief formula.
 */
export function computeRebate(
  taxableIncomePaise: number,
  taxBeforeRebatePaise: number,
  rules: RebateRules,
  regime: TaxRegime,
): ComputationNode {
  if (taxableIncomePaise <= rules.thresholdPaise) {
    const rebatePaise = Math.min(taxBeforeRebatePaise, rules.maxRebatePaise);
    return {
      label: rebatePaise > 0 ? `${rules.sourceSection} rebate` : `${rules.sourceSection} rebate (not applicable)`,
      amountPaise: -rebatePaise,
      kind: "rebate",
      sourceSection: rules.sourceSection,
      children: [],
    };
  }

  if (regime === "old") {
    // Above the threshold the old-regime rebate is simply nil, and there is
    // no marginal relief (see the note at the top of this file).
    return {
      label: `${rules.sourceSection} rebate (not applicable — above the income threshold)`,
      amountPaise: 0,
      kind: "rebate",
      sourceSection: rules.sourceSection,
      children: [],
    };
  }

  const excessIncomePaise = taxableIncomePaise - rules.thresholdPaise;

  if (taxBeforeRebatePaise <= excessIncomePaise) {
    // Above threshold, but the ordinary slab tax is already no more than
    // the excess income — capping would change nothing.
    return {
      label: `${rules.sourceSection} rebate (not applicable — above threshold, relief not needed)`,
      amountPaise: 0,
      kind: "rebate",
      sourceSection: rules.sourceSection,
      children: [],
    };
  }

  // New regime, verified: cap tax to the excess income over the
  // threshold. The rebate is whatever reduction that cap represents —
  // never negative, since this branch only runs when
  // taxBeforeRebatePaise > excessIncomePaise.
  const reliefAmountPaise = taxBeforeRebatePaise - excessIncomePaise;
  return {
    label: `${rules.sourceSection} marginal relief`,
    amountPaise: -reliefAmountPaise,
    kind: "rebate",
    sourceSection: rules.sourceSection,
    children: [],
  };
}
