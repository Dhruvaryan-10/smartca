// Section 87A rebate.
//
// NEW REGIME marginal relief is implemented, verified in the Phase 1C-B
// source audit (independently triangulated three ways: the statutory
// description, a worked numeric example re-derived from first
// principles, and an independently-derived phase-out boundary that
// matched a separately-cited figure — see that report for the full
// evidence).
//
// OLD REGIME marginal relief is DELIBERATELY still blocked. The Phase
// 1C-B audit explicitly did not re-verify the old-regime (₹5L threshold)
// marginal-relief formula with the same rigor as the new-regime case —
// its own report says so under "Rules that MUST remain blocked." Do not
// assume the same formula applies just because both are "Section 87A
// marginal relief" — they were verified to different standards, and only
// the new-regime one has been implemented.
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
import { UnsupportedTaxRuleError } from "./types";
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

  const excessIncomePaise = taxableIncomePaise - rules.thresholdPaise;

  if (taxBeforeRebatePaise <= excessIncomePaise) {
    // Above threshold, but the ordinary slab tax is already no more than
    // the excess income — capping would change nothing regardless of
    // which formula applies. Safe for both regimes.
    return {
      label: `${rules.sourceSection} rebate (not applicable — above threshold, relief not needed)`,
      amountPaise: 0,
      kind: "rebate",
      sourceSection: rules.sourceSection,
      children: [],
    };
  }

  if (regime === "old") {
    // This IS the marginal-relief zone, and the old-regime formula was
    // not verified in the Phase 1C-B audit — refuse rather than guess.
    throw new UnsupportedTaxRuleError(
      `Taxable income of ${taxableIncomePaise} paise is in the old-regime ${rules.sourceSection} ` +
      `marginal-relief zone above the ₹5,00,000 threshold. That formula was not independently verified ` +
      `in the Phase 1C-B audit (unlike the new-regime formula, which was) — this engine refuses to ` +
      `compute a result here rather than assume the same formula applies.`,
    );
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
