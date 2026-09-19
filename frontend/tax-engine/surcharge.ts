// Surcharge — implements the AY 2026-27 bracket table verified in the
// Phase 1C-B source audit (two independent secondary sources; NOT
// independently fetched from a primary government document in that
// audit — see rules/ay-2026-27.ts for the full honesty note on this
// evidence level).
//
// Unlike income slabs, surcharge is NOT progressive/cumulative — it is a
// single flat rate applied to the WHOLE pre-cess tax amount, determined
// by whichever bracket the taxable income falls into. That cliff
// structure is exactly why the law provides marginal relief at each
// threshold (₹50L, ₹1Cr, ₹2Cr, and — old regime only — ₹5Cr): without
// it, earning ₹1 more than a threshold could increase tax+surcharge by
// far more than the extra rupee earned.
//
// MARGINAL RELIEF — verified formula, per Phase 1C-C's explicit
// direction quoting the Income Tax Department's own rule text:
//
//   When net income exceeds a threshold, the amount payable as income
//   tax + surcharge must not exceed:
//     tax payable at the threshold + income exceeding that threshold.
//
// "The threshold" is the lower bound of the surcharge bracket the
// taxable income actually falls into (`bracket.fromPaise`) — that is
// exactly the point at which the surcharge rate jumped, so it's the
// only point relief needs to anchor to. "Tax payable at the threshold"
// is income tax (via the SAME slab table) plus surcharge at whatever
// rate applies exactly AT that threshold amount (which, since income
// exactly equal to a threshold stays in the lower bracket — see
// findApplicableBracket below — is the rate of the bracket just below
// the one the actual income is in). For the ₹50L threshold that lower
// rate is 0%, matching the well-known "no surcharge below ₹50L" case;
// for ₹1Cr/₹2Cr/₹5Cr it is the previous bracket's non-zero rate, since
// surcharge is already being charged below those thresholds.
//
// This relief only ever reduces the SURCHARGE component, never the
// underlying income tax — it caps (tax + surcharge) to the formula
// above by solving for surcharge = cap - tax, floored at zero. This is
// a distinct statutory concept from Section 87A's marginal relief
// (rebate.ts) and is never conflated with it.
//
// SCOPE: this formula is verified for, and only applies to, this
// engine's ordinary-income model. Every threshold here (₹50L+) is far
// above both regimes' Section 87A rebate thresholds (₹5L old / ₹12L
// new), so "tax payable at the threshold" never needs to account for a
// rebate — it is always zero at these income levels. The moment
// capital-gains/special-rate income support is added, this formula's
// inputs must be re-scoped to ordinary-rate taxable income only, same
// as rebate.ts's marginal-relief formula.
import type { ComputationNode, SlabBracket, SurchargeBracket } from "./types";
import { computeSlabTax } from "./slabs";

// Strictly greater-than: the law's brackets are phrased "exceeds ₹50L",
// "exceeds ₹1Cr", etc. — a taxable income of EXACTLY a threshold stays
// in the LOWER bracket. This is also what lets `findApplicableBracket`
// be reused, unmodified, to find "the rate that applies exactly at a
// threshold" when computing marginal relief below: passing the
// threshold itself in always resolves to the bracket just below it.
function findApplicableBracket(taxableIncomePaise: number, brackets: SurchargeBracket[]): SurchargeBracket {
  let applicable = brackets[0];
  for (const bracket of brackets) {
    if (taxableIncomePaise > bracket.fromPaise) {
      applicable = bracket;
    }
  }
  return applicable;
}

export function computeSurcharge(
  taxableIncomePaise: number,
  taxAfterRebatePaise: number,
  slabs: SlabBracket[],
  brackets: SurchargeBracket[],
): ComputationNode {
  const bracket = findApplicableBracket(taxableIncomePaise, brackets);

  if (bracket.rateBasisPoints === 0) {
    return {
      label: "Surcharge (not applicable — below ₹50,00,000)",
      amountPaise: 0,
      kind: "surcharge",
      sourceSection: null,
      children: [],
    };
  }

  const naiveSurchargePaise = Math.floor((taxAfterRebatePaise * bracket.rateBasisPoints) / 10000);
  const naiveTotalPaise = taxAfterRebatePaise + naiveSurchargePaise;

  // "Tax payable at the threshold": income tax on the threshold amount
  // itself (same slabs), plus surcharge at whatever rate applies exactly
  // at that threshold (the bracket just below the current one).
  const thresholdPaise = bracket.fromPaise;
  const taxAtThresholdPaise = computeSlabTax(thresholdPaise, slabs).totalTaxPaise;
  const rateAtThresholdBasisPoints = findApplicableBracket(thresholdPaise, brackets).rateBasisPoints;
  const surchargeAtThresholdPaise = Math.floor((taxAtThresholdPaise * rateAtThresholdBasisPoints) / 10000);

  const excessIncomeOverThresholdPaise = taxableIncomePaise - thresholdPaise;
  const capPaise = taxAtThresholdPaise + surchargeAtThresholdPaise + excessIncomeOverThresholdPaise;

  if (naiveTotalPaise <= capPaise) {
    // No relief needed — the cliff at this threshold doesn't actually
    // cost more than the income earned crossing it.
    return {
      label: `Surcharge (${bracket.label}, ${bracket.rateBasisPoints / 100}%)`,
      amountPaise: naiveSurchargePaise,
      kind: "surcharge",
      sourceSection: null,
      children: [],
    };
  }

  // Marginal relief: reduce surcharge (only) so that tax + surcharge
  // together equal the statutory cap exactly. Never negative — see the
  // module comment above for why this always holds for real slab rates.
  const relievedSurchargePaise = Math.max(0, capPaise - taxAfterRebatePaise);
  return {
    label: `Surcharge (${bracket.label}, ${bracket.rateBasisPoints / 100}%, marginal relief applied)`,
    amountPaise: relievedSurchargePaise,
    kind: "surcharge",
    sourceSection: "Surcharge marginal relief",
    children: [],
  };
}
