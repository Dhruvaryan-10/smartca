// Assessment-year rule registry. Adding a future AY (e.g. 2027-28) means
// writing a new `rules/ay-2027-28.ts` module and adding one line to the
// map below — no changes to any generic calculator (slabs.ts, rebate.ts,
// cess.ts, compute.ts) are ever required.
//
// No fallback behavior: an unregistered assessment year label always
// throws UnsupportedAssessmentYearError. The engine never silently
// substitutes a different year's rules.
import { UnsupportedAssessmentYearError, type AssessmentYearRules } from "../types";
import { AY_2026_27_RULES } from "./ay-2026-27";

const RULES_BY_ASSESSMENT_YEAR: Record<string, AssessmentYearRules> = {
  "2026-27": AY_2026_27_RULES,
};

/** Labels of every assessment year this engine has rules for. */
export function getSupportedAssessmentYearLabels(): string[] {
  return Object.keys(RULES_BY_ASSESSMENT_YEAR);
}

export function resolveAssessmentYearRules(assessmentYearLabel: string): AssessmentYearRules {
  const rules = RULES_BY_ASSESSMENT_YEAR[assessmentYearLabel];
  if (!rules) {
    throw new UnsupportedAssessmentYearError(assessmentYearLabel);
  }
  return rules;
}
