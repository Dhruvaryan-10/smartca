// Generic, regime-agnostic slab-tax calculator. Takes a slab table as
// data — never hardcodes a rate or boundary — so the same function
// computes both old- and new-regime tax, and works unchanged for any
// future assessment year's slab table.
import type { ComputationNode, SlabBracket } from "./types";

export type SlabComputation = {
  totalTaxPaise: number;
  nodes: ComputationNode[]; // one per bracket actually reached by the income
};

/**
 * Boundary convention: `uptoPaise` is the INCLUSIVE upper bound of a
 * bracket. Income exactly equal to a boundary stays in the lower bracket;
 * the next paise above it is the first paise taxed at the next bracket's
 * rate. This matches the standard "up to ₹4,00,000: nil" phrasing audited
 * in the Phase 1C source review.
 *
 * Rate application: `amountInBracketPaise * rateBasisPoints / 10000`,
 * computed with integer multiplication then `Math.floor` — never a
 * floating-point rate literal like `0.05`.
 */
export function computeSlabTax(taxableIncomePaise: number, slabs: SlabBracket[]): SlabComputation {
  const nodes: ComputationNode[] = [];
  let totalTaxPaise = 0;
  let lowerBoundPaise = 0; // exclusive — amounts strictly greater than this fall in the current bracket

  for (const bracket of slabs) {
    if (taxableIncomePaise <= lowerBoundPaise) break;

    const bracketTopPaise =
      bracket.uptoPaise === null ? taxableIncomePaise : Math.min(taxableIncomePaise, bracket.uptoPaise);
    const amountInBracketPaise = bracketTopPaise - lowerBoundPaise;

    const bracketTaxPaise = Math.floor((amountInBracketPaise * bracket.rateBasisPoints) / 10000);

    nodes.push({
      label: bracket.label,
      amountPaise: bracketTaxPaise,
      kind: "slab",
      sourceSection: null,
      children: [],
    });
    totalTaxPaise += bracketTaxPaise;

    lowerBoundPaise = bracket.uptoPaise === null ? taxableIncomePaise : bracket.uptoPaise;
  }

  return { totalTaxPaise, nodes };
}
