// SmartCA tax engine — shared types and error classes.
//
// PURITY: this entire directory (frontend/tax-engine/**) must never import
// from next-auth, drizzle-orm, pg, frontend/db/**, or frontend/services/**.
// It takes plain data in and returns plain data out — no session, no
// database, no network. That's what lets it be tested exhaustively and
// deterministically, and it's why these error classes are defined locally
// rather than imported from services/errors.ts (a deliberate, small
// duplication in exchange for zero coupling to the service layer).
//
// MONEY: every amount in this module is an integer number of paise
// (₹1 = 100 paise), matching frontend/db/schema.ts's convention. Never a
// float. Rates are represented as integer "basis points" (1/100 of a
// percent; 500 = 5.00%) and combined with amounts via integer
// multiply-then-floor-divide — never `amount * 0.05`.
//
// SCOPE (Phase 1C-C): this engine models ORDINARY, slab-rate income only
// (salary, business/professional, other). It has NO concept of capital
// gains or any other special-rate income (Sections 111A/112/112A etc.).
// This matters beyond "not implemented yet": the Phase 1C-B source audit
// found (CBDT Circular No. 13/2025) that special-rate income must be
// EXCLUDED from the Section 87A rebate/marginal-relief calculation
// entirely, with ordinary and special-rate income taxed separately. The
// marginal-relief formula implemented in rebate.ts is therefore only
// correct because every paisa this engine ever sees is ordinary income —
// the moment capital gains support is added, that formula's inputs must
// be re-scoped to ordinary income only, not silently fed the blended
// total. Do not tax future capital gains as ordinary slab income.

export type TaxRegime = "old" | "new";

export type IncomeSourceKind = "salary" | "business" | "other";

/**
 * Individual/HUF age category — only meaningful for old-regime slab
 * selection (the new regime, Section 115BAC, uses identical slabs for
 * every age category; see rules/ay-2026-27.ts). Required, not optional:
 * an omitted age category would be ambiguous (which old-regime table?),
 * so every caller must state it explicitly rather than have the engine
 * guess or default silently.
 */
export type AgeCategory = "below60" | "senior" | "superSenior";

export type IncomeSource = {
  kind: IncomeSourceKind;
  label: string;
  amountPaise: number;
};

export type DeductionInput = {
  section: string;
  amountPaise: number;
};

export type TaxInput = {
  assessmentYearLabel: string;
  regime: TaxRegime;
  ageCategory: AgeCategory;
  incomeSources: IncomeSource[];
  deductions: DeductionInput[];
  // Capital gains are deliberately NOT part of this input shape yet —
  // see the SCOPE note above.
};

// ---------------------------------------------------------------------
// Computation tree
// ---------------------------------------------------------------------
// Sign convention (this is what lets one reconciliation rule work
// everywhere instead of special-casing every node): amounts that INCREASE
// the parent figure are positive; amounts that DECREASE it (deductions,
// rebate) are stored as NEGATIVE amountPaise. A deduction of ₹75,000 is
// represented as amountPaise: -7500000, not 7500000 — so "parent equals
// the sum of its children" is literally true by arithmetic, not just by
// convention, for every node in the tree, with NO exceptions anywhere
// (see the Phase 1C-A computation-tree audit and compute.ts's
// `reconcile()`, which enforces this with a single uniform rule).

export type ComputationNodeKind =
  | "income"
  | "deduction"
  | "gross_total_income"
  | "taxable_income"
  | "slab"
  | "slab_tax"
  | "rebate"
  | "surcharge"
  | "cess"
  | "total";

export type ComputationNode = {
  label: string;
  amountPaise: number;
  kind: ComputationNodeKind;
  sourceSection: string | null;
  children: ComputationNode[];
};

export type TaxResult = {
  engineVersion: string;
  rulesVersion: string;
  assessmentYearLabel: string;
  regime: TaxRegime;
  ageCategory: AgeCategory;
  grossTotalIncomePaise: number;
  totalDeductionsPaise: number; // positive number, the magnitude actually applied
  /** Section 288A-rounded taxable income — the figure slab tax is actually computed on. */
  taxableIncomePaise: number;
  taxBeforeRebatePaise: number;
  rebatePaise: number; // positive number, the magnitude actually applied
  surchargePaise: number; // positive number, the magnitude actually applied (0 below ₹50L)
  cessPaise: number;
  /** Section 288B-rounded final tax payable. */
  totalTaxPaise: number;
  /**
   * The tax-derivation tree: `total` = slab_tax + rebate + surcharge +
   * cess (+ a Section 288B rounding adjustment node, only present if
   * rounding actually changed the figure), exactly, with no exceptions
   * to "parent = sum of children" anywhere in it.
   */
  tree: ComputationNode;
  /**
   * The income-derivation tree, independent of `tree`: `taxable_income`
   * = gross_total_income + deduction nodes (+ a Section 288A rounding
   * adjustment node, only present if rounding changed the figure), also
   * with no exceptions to "parent = sum of children". Kept separate from
   * `tree` so `tree` never has to mix an income-scale figure into a
   * tax-scale sum.
   */
  taxableIncomeTree: ComputationNode;
};

// ---------------------------------------------------------------------
// Rules shape (per assessment year, per regime)
// ---------------------------------------------------------------------

export type SlabBracket = {
  label: string;
  /** Inclusive upper bound of this bracket, in paise. `null` = unbounded (the top bracket). */
  uptoPaise: number | null;
  /** Rate for this bracket, in basis points (1/100 of a percent). 500 = 5%. */
  rateBasisPoints: number;
};

export type RebateRules = {
  /** Full rebate applies when taxable income is <= this many paise. */
  thresholdPaise: number;
  /** Rebate is capped at this many paise (never exceeds tax actually owed). */
  maxRebatePaise: number;
  sourceSection: string;
};

/**
 * Surcharge is NOT a progressive/cumulative slab like income tax — it is
 * a single flat rate applied to the WHOLE pre-cess tax amount, determined
 * by which bracket total/taxable income falls into. That cliff structure
 * is exactly why marginal relief exists at each threshold — see
 * surcharge.ts.
 */
export type SurchargeBracket = {
  label: string;
  /** Inclusive lower bound of this bracket, in paise. */
  fromPaise: number;
  /** Rate for this bracket, in basis points. 0 for the base (no-surcharge) bracket. */
  rateBasisPoints: number;
};

export type RegimeRules = {
  /**
   * Old regime: one slab table per age category (below60/senior/superSenior
   * genuinely differ). New regime: all three keys point to the SAME table
   * (Section 115BAC does not vary by age) — see rules/ay-2026-27.ts. Kept
   * as a uniform `Record<AgeCategory, ...>` shape for both regimes so
   * compute.ts never needs regime-specific conditional logic to look up
   * "the right slab table for this input."
   */
  slabs: Record<AgeCategory, SlabBracket[]>;
  /** Applied against salary-kind income only, capped at that income. */
  standardDeductionPaise: number;
  rebate: RebateRules;
  /**
   * Whether declared Chapter VI-A style deductions (80C/80D) are honored
   * under this regime. Verified in the Phase 1C-B source audit: `true`
   * for "old" (long-standing, uncontested); `false` for "new" — Section
   * 115BAC does NOT permit these deductions (confirmed, not merely
   * unverified — see compute.ts's error message). The engine throws
   * UnsupportedTaxRuleError rather than silently applying or silently
   * dropping a declared deduction when this is `false`.
   */
  deductionsSupported: boolean;
  /** Ascending by fromPaise; the applicable bracket is the last one whose fromPaise < income (strictly — income exactly equal to a threshold stays in the lower bracket, per "exceeds ₹X" statutory phrasing). */
  surchargeBrackets: SurchargeBracket[];
};

export type AssessmentYearRules = {
  assessmentYearLabel: string;
  rulesVersion: string;
  regimes: Record<TaxRegime, RegimeRules>;
  cessRateBasisPoints: number;
  /** The only deduction section codes this engine recognizes at all, regardless of regime. */
  supportedDeductionSections: string[];
};

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/** The input itself is malformed/invalid — never a question of tax law. */
export class TaxInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxInputValidationError";
  }
}

/** The assessment year has no registered rules module. Never falls back to another year. */
export class UnsupportedAssessmentYearError extends Error {
  constructor(assessmentYearLabel: string) {
    super(`No tax rules are registered for assessment year "${assessmentYearLabel}".`);
    this.name = "UnsupportedAssessmentYearError";
  }
}

/**
 * The input is legitimate and the assessment year/regime are known, but
 * computing a correct result would require a statutory rule (surcharge
 * marginal relief, a regime-specific deduction eligibility question,
 * etc.) that has not been verified against sufficient authority yet.
 * Thrown instead of silently returning a plausible-looking but unverified
 * number — see the Phase 1C "unverified rule safety" requirement.
 */
export class UnsupportedTaxRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedTaxRuleError";
  }
}
