// Orchestration: the sequence of pure steps that turn a validated
// TaxInput + AssessmentYearRules into a TaxResult. engine.ts is the only
// caller of this module; it exists separately so engine.ts stays a thin,
// readable "here's the sequence" entry point while this file holds the
// actual step implementations. (Surcharge itself now lives in its own
// module, surcharge.ts — it's a real implemented calculator with its own
// marginal-relief safety gate, not a stub, so it earns its own file the
// same way slabs/rebate/cess did.)
import { roundToNearestTenRupees } from "./rounding";
import { resolveAssessmentYearRules } from "./rules";
import {
  TaxEngineInternalError,
  TaxInputValidationError,
  UnsupportedTaxRuleError,
  type AgeCategory,
  type ComputationNode,
  type DeductionAdjustment,
  type DeductionInput,
  type DeductionLimits,
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
  // One entry per section. A repeated section would otherwise be summed
  // silently, which is a double count the taxpayer never intended.
  const seenSections = new Set<string>();
  for (const deduction of input.deductions) {
    if (!deduction || typeof deduction !== "object") {
      throw new TaxInputValidationError("Each deduction must be an object.");
    }
    if (typeof deduction.section !== "string" || !deduction.section.trim()) {
      throw new TaxInputValidationError("Each deduction must have a non-empty section.");
    }
    if (seenSections.has(deduction.section)) {
      throw new TaxInputValidationError(
        `Duplicate deduction section "${deduction.section}": declare each section once, with its total.`,
      );
    }
    seenSections.add(deduction.section);

    if (deduction.section === "80D") {
      validate80DInput(deduction);
    } else {
      const amountPaise = (deduction as { amountPaise: number }).amountPaise;
      assertIntegerPaise(amountPaise, `Deduction "${deduction.section}"`);
      if (amountPaise <= 0) {
        throw new TaxInputValidationError(`Deduction "${deduction.section}" must be a positive amount.`);
      }
    }
  }
}

// Section 80D is structured (self/family and parents), so it has its own
// shape check. Zero is a valid "nothing claimed" value for either part.
function validate80DInput(deduction: object): void {
  const d = deduction as Record<string, unknown>;
  for (const field of ["selfFamilyPaise", "parentsPaise"] as const) {
    const value = d[field];
    if (typeof value !== "number") {
      throw new TaxInputValidationError(
        `Section 80D requires "selfFamilyPaise" and "parentsPaise" (integer paise, 0 if none); "${field}" is missing or not a number.`,
      );
    }
    assertIntegerPaise(value, `Section 80D ${field}`);
    if (value < 0) {
      throw new TaxInputValidationError(`Section 80D ${field} cannot be negative.`);
    }
  }
  for (const flag of ["spouseIsSenior", "anyParentIsSenior"] as const) {
    if (d[flag] !== undefined && typeof d[flag] !== "boolean") {
      throw new TaxInputValidationError(`Section 80D "${flag}" must be true or false when provided.`);
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

const formatRupeesForLabel = (paise: number): string =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(paise / 100)}`;

type SituationFor80D = {
  ageCategory: AgeCategory;
  spouseIsSenior?: boolean;
  anyParentIsSenior?: boolean;
};

/**
 * The Section 80D limits that apply to a taxpayer. The taxpayer's own senior
 * status comes from the age category; a senior spouse also raises the
 * self/family limit ("if any person is a Senior Citizen"); the parents limit
 * depends only on whether a parent is a senior. Single source of truth for
 * both the calculation below and `deductionCapsFor`.
 */
function select80DCaps(limits: DeductionLimits, situation: SituationFor80D): { selfFamilyPaise: number; parentsPaise: number } {
  const selfFamilyIsSenior = situation.ageCategory !== "below60" || situation.spouseIsSenior === true;
  const { selfFamilyPaise, parentsPaise } = limits.section80D;
  return {
    selfFamilyPaise: selfFamilyIsSenior ? selfFamilyPaise.senior : selfFamilyPaise.standard,
    parentsPaise: situation.anyParentIsSenior === true ? parentsPaise.senior : parentsPaise.standard,
  };
}

export type DeductionCaps = {
  section80CPaise: number;
  selfFamilyPaise: number;
  parentsPaise: number;
};

/**
 * The deduction limits that apply for an assessment year and taxpayer
 * situation, straight from the rules data. Pure and safe to call from UI
 * code, so limits shown to a user can never drift from the ones enforced.
 */
export function deductionCapsFor(assessmentYearLabel: string, situation: SituationFor80D): DeductionCaps {
  const { deductionLimits } = resolveAssessmentYearRules(assessmentYearLabel);
  return { section80CPaise: deductionLimits.section80CPaise, ...select80DCaps(deductionLimits, situation) };
}

export function applyDeductions(
  salaryIncomePaise: number,
  deductions: DeductionInput[],
  regimeRules: RegimeRules,
  regime: TaxRegime,
  supportedSections: string[],
  limits: DeductionLimits,
  ageCategory: AgeCategory,
): { totalDeductionsPaise: number; nodes: ComputationNode[]; adjustments: DeductionAdjustment[] } {
  const nodes: ComputationNode[] = [];
  const adjustments: DeductionAdjustment[] = [];
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
    return { totalDeductionsPaise, nodes, adjustments };
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

  // One claimed component against its statutory limit. The full claim is
  // shown as a deduction node and any excess over the limit is added back
  // by a separate, visible node, so the tree always reconciles and the
  // disallowed amount is never hidden.
  function addCapped(args: {
    claimLabel: string;
    claimSection: string;
    component: DeductionAdjustment["component"];
    declaredPaise: number;
    capPaise: number;
    excessLabelPrefix: string;
    limitSection: string;
  }): void {
    const allowedPaise = Math.min(args.declaredPaise, args.capPaise);
    nodes.push({
      label: args.claimLabel,
      amountPaise: -args.declaredPaise,
      kind: "deduction",
      sourceSection: args.claimSection,
      children: [],
    });
    if (args.declaredPaise > allowedPaise) {
      const excessPaise = args.declaredPaise - allowedPaise;
      nodes.push({
        label:
          `${args.excessLabelPrefix}: ${formatRupeesForLabel(excessPaise)} over the ` +
          `${formatRupeesForLabel(args.capPaise)} limit — not allowed`,
        amountPaise: excessPaise,
        kind: "deduction",
        sourceSection: args.limitSection,
        children: [],
      });
    }
    adjustments.push({
      component: args.component,
      declaredPaise: args.declaredPaise,
      allowedPaise,
      capPaise: args.capPaise,
    });
    totalDeductionsPaise += allowedPaise;
  }

  for (const deduction of deductions) {
    if (deduction.section === "80C") {
      addCapped({
        claimLabel: "Section 80C Deduction",
        claimSection: "80C",
        component: "80C",
        declaredPaise: deduction.amountPaise,
        capPaise: limits.section80CPaise,
        excessLabelPrefix: "Section 80C",
        limitSection: "Section 80CCE",
      });
    } else if (deduction.section === "80D") {
      const caps = select80DCaps(limits, {
        ageCategory,
        spouseIsSenior: deduction.spouseIsSenior,
        anyParentIsSenior: deduction.anyParentIsSenior,
      });
      if (deduction.selfFamilyPaise > 0) {
        addCapped({
          claimLabel: "Section 80D Deduction (self/family)",
          claimSection: "80D",
          component: "80D-self-family",
          declaredPaise: deduction.selfFamilyPaise,
          capPaise: caps.selfFamilyPaise,
          excessLabelPrefix: "Section 80D (self/family)",
          limitSection: "Section 80D",
        });
      }
      if (deduction.parentsPaise > 0) {
        addCapped({
          claimLabel: "Section 80D Deduction (parents)",
          claimSection: "80D",
          component: "80D-parents",
          declaredPaise: deduction.parentsPaise,
          capPaise: caps.parentsPaise,
          excessLabelPrefix: "Section 80D (parents)",
          limitSection: "Section 80D",
        });
      }
    } else {
      // A section listed as supported in the rules but with no handler here
      // is an engine bug, never a caller error.
      throw new TaxEngineInternalError(
        `Deduction section "${(deduction as { section: string }).section}" is registered as supported but has no handler.`,
      );
    }
  }

  return { totalDeductionsPaise, nodes, adjustments };
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
