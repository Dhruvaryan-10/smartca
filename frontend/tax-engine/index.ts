// Public surface of the tax engine. Everything outside this directory
// should import from "@/tax-engine" (this file), not reach into
// individual modules like "@/tax-engine/slabs" directly.
export { calculateTax, ENGINE_VERSION } from "./engine";

export type {
  AgeCategory,
  AssessmentYearRules,
  ComputationNode,
  ComputationNodeKind,
  DeductionInput,
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
  TaxInputValidationError,
  UnsupportedAssessmentYearError,
  UnsupportedTaxRuleError,
} from "./types";
