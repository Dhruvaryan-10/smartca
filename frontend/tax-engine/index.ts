// Public surface of the tax engine. Everything outside this directory
// should import from "@/tax-engine" (this file), not reach into
// individual modules like "@/tax-engine/slabs" directly.
export { calculateTax, ENGINE_VERSION } from "./engine";
export { compareRegimes, comparisonNumbers } from "./compare";
export type { ComparisonInput, ComparisonNumbers, RegimeComparison, RegimeOutcome, TaxRefusal } from "./compare";
export { deductionCapsFor } from "./compute";
export type { DeductionCaps } from "./compute";
export { getSupportedAssessmentYearLabels, resolveAssessmentYearRules } from "./rules";

export type {
  AgeCategory,
  AssessmentYearRules,
  ComputationNode,
  ComputationNodeKind,
  Deduction80CInput,
  Deduction80DInput,
  DeductionAdjustment,
  DeductionAdjustmentComponent,
  DeductionInput,
  DeductionLimits,
  IncomeSource,
  IncomeSourceKind,
  RebateRules,
  RegimeRules,
  SlabBracket,
  SurchargeBracket,
  TaxInput,
  TaxRegime,
  TaxResult,
} from "./types";

export {
  TaxEngineInternalError,
  TaxInputValidationError,
  UnsupportedAssessmentYearError,
  UnsupportedTaxRuleError,
} from "./types";
