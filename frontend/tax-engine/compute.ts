// Orchestration: the sequence of pure steps that turn a validated
// TaxInput + AssessmentYearRules into a TaxResult. engine.ts is the only
// caller of this module; it exists separately so engine.ts stays a thin,
// readable "here's the sequence" entry point while this file holds the
// actual step implementations. (Surcharge itself now lives in its own
// module, surcharge.ts — it's a real implemented calculator with its own
// marginal-relief safety gate, not a stub, so it earns its own file the
// same way slabs/rebate/cess did.)
import { roundToNearestTenRupees } from "./rounding";
import {
  TaxInputValidationError,
  UnsupportedTaxRuleError,
  type AgeCategory,
  type ComputationNode,
  type DeductionInput,
  type IncomeSource,
  type RegimeRules,
  type TaxInput,
  type TaxRegime,
} from "./types";

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

const INCOME_KIND_LABEL: Record<IncomeSource["kind"], string> = {
  salary: "Salary Income",
  business: "Business/Professional Income",
  other: "Other Income",
};

const AGE_CATEGORIES: AgeCategory[] = ["below60", "senior", "superSenior"];

function assertIntegerPaise(value: number, fieldDescription: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TaxInputValidationError(`${fieldDescription} must be an integer number of paise; got ${value}.`);
  }
}

export function validateInput(input: TaxInput): void {
  if (input === null || typeof input !== "object") {
    throw new TaxInputValidationError("Tax input must be an object.");
  }
  if (!input.assessmentYearLabel || typeof input.assessmentYearLabel !== "string") {
    throw new TaxInputValidationError("assessmentYearLabel is required.");
  }
  if (input.regime !== "old" && input.regime !== "new") {
    throw new TaxInputValidationError(`regime must be "old" or "new"; got ${JSON.stringify(input.regime)}.`);
  }
  if (!AGE_CATEGORIES.includes(input.ageCategory)) {
    throw new TaxInputValidationError(
      `ageCategory must be one of ${AGE_CATEGORIES.map((a) => `"${a}"`).join(", ")}; got ${JSON.stringify(input.ageCategory)}.`,
    );
  }
  if (!Array.isArray(input.incomeSources)) {
    throw new TaxInputValidationError("incomeSources must be an array.");
  }
  for (const source of input.incomeSources) {
    if (!source || typeof source !== "object") {
      throw new TaxInputValidationError("Each income source must be an object.");
    }
    if (source.kind !== "salary" && source.kind !== "business" && source.kind !== "other") {
      throw new TaxInputValidationError(`Invalid income source kind: ${JSON.stringify(source.kind)}.`);
    }
    if (typeof source.label !== "string" || !source.label.trim()) {
      throw new TaxInputValidationError("Each income source must have a non-empty label.");
    }
    assertIntegerPaise(source.amountPaise, `Income source "${source.label}"`);
    if (source.amountPaise < 0) {
      throw new TaxInputValidationError(`Income source "${source.label}" cannot be negative.`);
    }
  }
  if (!Array.isArray(input.deductions)) {
    throw new TaxInputValidationError("deductions must be an array.");
  }
  for (const deduction of input.deductions) {
    if (!deduction || typeof deduction !== "object") {
      throw new TaxInputValidationError("Each deduction must be an object.");
    }
    if (typeof deduction.section !== "string" || !deduction.section.trim()) {
      throw new TaxInputValidationError("Each deduction must have a non-empty section.");
    }
    assertIntegerPaise(deduction.amountPaise, `Deduction "${deduction.section}"`);
    if (deduction.amountPaise <= 0) {
      throw new TaxInputValidationError(`Deduction "${deduction.section}" must be a positive amount.`);
    }
  }
}

// ---------------------------------------------------------------------
// Income aggregation
// ---------------------------------------------------------------------

export function aggregateIncome(incomeSources: IncomeSource[]): {
  grossTotalIncomePaise: number;
  salaryIncomePaise: number;
  node: ComputationNode;
} {
  const kinds: IncomeSource["kind"][] = ["salary", "business", "other"];
  const children: ComputationNode[] = [];
  let grossTotalIncomePaise = 0;
  let salaryIncomePaise = 0;

  for (const kind of kinds) {
    const sources = incomeSources.filter((s) => s.kind === kind);
    if (sources.length === 0) continue;

    const kindTotalPaise = sources.reduce((sum, s) => sum + s.amountPaise, 0);
    grossTotalIncomePaise += kindTotalPaise;
    if (kind === "salary") salaryIncomePaise = kindTotalPaise;

    if (sources.length === 1) {
      children.push({
        label: sources[0].label,
        amountPaise: sources[0].amountPaise,
        kind: "income",
        sourceSection: null,
        children: [],
      });
    } else {
      children.push({
        label: INCOME_KIND_LABEL[kind],
        amountPaise: kindTotalPaise,
        kind: "income",
        sourceSection: null,
        // Business/professional income here is a plain aggregated
        // ordinary-rate figure — this engine does NOT implement 44AD/
        // 44ADA presumptive taxation, depreciation, loss set-off/
        // carry-forward, or AMT. Treating it as ordinary slab income is
        // a deliberate simplification, not a verified equivalence.
        children: sources.map((s) => ({
          label: s.label,
          amountPaise: s.amountPaise,
          kind: "income",
          sourceSection: null,
          children: [],
        })),
      });
    }
  }

  return {
    grossTotalIncomePaise,
    salaryIncomePaise,
    node: {
      label: "Gross Total Income",
      amountPaise: grossTotalIncomePaise,
      kind: "gross_total_income",
      sourceSection: null,
      children,
    },
  };
}

// ---------------------------------------------------------------------
// Deductions
// ---------------------------------------------------------------------

export function applyDeductions(
  salaryIncomePaise: number,
  deductions: DeductionInput[],
  regimeRules: RegimeRules,
  regime: TaxRegime,
  supportedSections: string[],
): { totalDeductionsPaise: number; nodes: ComputationNode[] } {
  const nodes: ComputationNode[] = [];
  let totalDeductionsPaise = 0;

  // Standard deduction: verified for both regimes, capped at actual
  // salary income (a deduction cannot create negative salary income).
  const standardDeductionPaise = Math.min(regimeRules.standardDeductionPaise, salaryIncomePaise);
  if (standardDeductionPaise > 0) {
    nodes.push({
      label: "Standard Deduction",
      amountPaise: -standardDeductionPaise,
      kind: "deduction",
      sourceSection: "Section 16(ia)",
      children: [],
    });
    totalDeductionsPaise += standardDeductionPaise;
  }

  if (deductions.length === 0) {
    return { totalDeductionsPaise, nodes };
  }

  for (const deduction of deductions) {
    if (!supportedSections.includes(deduction.section)) {
      throw new TaxInputValidationError(
        `Unsupported deduction section "${deduction.section}". This engine currently recognizes only: ` +
        `${supportedSections.join(", ")}.`,
      );
    }
  }

  // The section is one we recognize in general, but whether it's
  // honored under THIS regime is a separate, regime-specific question —
  // see RegimeRules.deductionsSupported's doc comment in types.ts.
  if (!regimeRules.deductionsSupported) {
    throw new UnsupportedTaxRuleError(
      regime === "new"
        ? `Declared deductions (${deductions.map((d) => d.section).join(", ")}) are not permitted under the ` +
          `new tax regime — Section 115BAC does not allow Chapter VI-A deductions such as 80C/80D (verified in ` +
          `the Phase 1C-B source audit). This is not a missing feature; it is the correct legal outcome, so this ` +
          `engine refuses rather than silently applying or dropping them.`
        : `Declared deductions (${deductions.map((d) => d.section).join(", ")}) were supplied, but this ` +
          `regime's eligibility for these sections was not verified against an authoritative source. This ` +
          `engine refuses to compute a result rather than guess whether they apply.`,
    );
  }

  for (const deduction of deductions) {
    nodes.push({
      label: `Section ${deduction.section} Deduction`,
      amountPaise: -deduction.amountPaise,
      kind: "deduction",
      sourceSection: deduction.section,
      children: [],
    });
    totalDeductionsPaise += deduction.amountPaise;
  }

  return { totalDeductionsPaise, nodes };
}

// ---------------------------------------------------------------------
// Taxable income (floor-at-zero, then Section 288A rounding), with
// honest plug nodes for both adjustments so reconciliation stays exact
// even though the reported taxable income is not simply gross - deductions.
// ---------------------------------------------------------------------

export function computeTaxableIncome(
  grossTotalIncomeNode: ComputationNode,
  totalDeductionsPaise: number,
  deductionNodes: ComputationNode[],
): { taxableIncomePaise: number; node: ComputationNode } {
  const rawPaise = grossTotalIncomeNode.amountPaise - totalDeductionsPaise;
  const flooredPaise = Math.max(0, rawPaise);

  // Reuse the actual gross_total_income node (with its real income
  // children) rather than a stub — a stub with an empty children array
  // would fail its own reconciliation check (amountPaise !== sum([])).
  const children: ComputationNode[] = [grossTotalIncomeNode, ...deductionNodes];

  if (rawPaise < 0) {
    // Deductions exceeded available income. Every deduction node above
    // still shows its full entitled amount (honest about what was
    // claimed); this node makes the shown math reconcile to the true,
    // floored-at-zero result instead of silently displaying a negative
    // taxable income.
    children.push({
      label: "Deductions limited to available income",
      amountPaise: -rawPaise, // positive — offsets the excess claimed above
      kind: "deduction",
      sourceSection: null,
      children: [],
    });
  }

  // Section 288A: round the (floored) taxable income to the nearest
  // ₹10. Only add a visible adjustment node if rounding actually moved
  // the figure — keeps the tree uncluttered for the (common in tests)
  // case of already-round inputs.
  const roundedPaise = roundToNearestTenRupees(flooredPaise);
  const roundingDeltaPaise = roundedPaise - flooredPaise;
  if (roundingDeltaPaise !== 0) {
    children.push({
      label: "Section 288A rounding",
      amountPaise: roundingDeltaPaise,
      kind: "deduction", // signed adjustment, not a fresh income/deduction concept of its own
      sourceSection: "Section 288A",
      children: [],
    });
  }

  return {
    taxableIncomePaise: roundedPaise,
    node: {
      label: "Taxable Income",
      amountPaise: roundedPaise,
      kind: "taxable_income",
      sourceSection: null,
      children,
    },
  };
}

// ---------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------
// ONE rule, with NO exceptions, for every aggregation node kind:
// amountPaise === sum(children.amountPaise). `total` used to be a
// special case (its children included a `taxable_income` node, kept
// only for narrative purposes and excluded from the sum via a kind
// filter) — that was removed in the Phase 1C-A computation-tree audit.
// `total`'s children are exactly its tax-scale components (slab_tax,
// rebate, surcharge, cess, and an optional Section 288B rounding
// adjustment), so a blind sum is always exactly right.

export function reconcile(node: ComputationNode): boolean {
  for (const child of node.children) {
    if (!reconcile(child)) return false;
  }

  switch (node.kind) {
    case "gross_total_income":
    case "taxable_income":
    case "slab_tax":
    case "total":
      return node.amountPaise === node.children.reduce((sum, c) => sum + c.amountPaise, 0);
    default:
      return true; // leaf nodes have nothing to reconcile
  }
}

export type { TaxRegime };
