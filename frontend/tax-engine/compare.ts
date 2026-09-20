// Old-vs-new regime comparison.
//
// Runs the deterministic engine once per regime on the SAME income and the
// SAME taxpayer information and reports the numbers. It is purely
// numerical: nothing here says which regime someone "should" choose, and
// nothing in it may be phrased as a recommendation. Presentation decides
// how to describe the difference.
//
// PURITY: like the rest of this directory, no auth, database, network or
// service imports.
import { calculateTax } from "./engine";
import { UnsupportedTaxRuleError } from "./types";
import type { TaxInput, TaxRegime, TaxResult } from "./types";

/** Everything the engine needs except which regime to use. */
export type ComparisonInput = Omit<TaxInput, "regime">;

/**
 * Why one regime produced no result. Only regime-specific refusals appear
 * here; problems that affect both regimes alike (bad input, an unsupported
 * assessment year, an engine bug) are thrown, never reported as a refusal.
 */
export type TaxRefusal = {
  kind: "unsupported_rule";
  message: string;
};

export type RegimeOutcome =
  | { status: "ok"; result: TaxResult }
  | { status: "refused"; refusal: TaxRefusal };

export type ComparisonNumbers = {
  oldTotalTaxPaise: number;
  newTotalTaxPaise: number;
  /** Absolute difference between the two totals. Never negative. */
  differencePaise: number;
  /** Which regime has the lower total tax, or "equal" for a tie. */
  lowerTaxRegime: TaxRegime | "equal";
};

export type RegimeComparison = {
  old: RegimeOutcome;
  new: RegimeOutcome;
  /** Present only when BOTH regimes produced a result. */
  numbers: ComparisonNumbers | null;
};

/**
 * The numerical comparison of two engine results: totals, absolute difference
 * and which is lower. Null unless BOTH results exist. Exported so a stored
 * run can be compared without any arithmetic outside the engine.
 */
export function comparisonNumbers(oldResult: TaxResult | null, newResult: TaxResult | null): ComparisonNumbers | null {
  if (!oldResult || !newResult) return null;
  const oldTotalTaxPaise = oldResult.totalTaxPaise;
  const newTotalTaxPaise = newResult.totalTaxPaise;
  return {
    oldTotalTaxPaise,
    newTotalTaxPaise,
    differencePaise: Math.abs(oldTotalTaxPaise - newTotalTaxPaise),
    lowerTaxRegime:
      oldTotalTaxPaise === newTotalTaxPaise ? "equal" : oldTotalTaxPaise < newTotalTaxPaise ? "old" : "new",
  };
}

// ---------------------------------------------------------------------
// What-if: the SIGNED change between a base result and a scenario result
// ---------------------------------------------------------------------

/**
 * A scenario can only be compared with a base computed under the same assessment year, regime, engine version and
 * rules version; anything else would be subtracting unlike things.
 */
export class ScenarioMismatchError extends Error {
  constructor(readonly fields: string[]) {
    super(`A scenario can only be compared with a base computed under the same ${fields.join(", ")}.`);
    this.name = "ScenarioMismatchError";
  }
}

export type ScenarioDelta = {
  assessmentYearLabel: string;
  regime: TaxRegime;
  engineVersion: string;
  rulesVersion: string;
  base: { totalTaxPaise: number; taxableIncomePaise: number };
  scenario: { totalTaxPaise: number; taxableIncomePaise: number };
  /**
   * Scenario minus base, SIGNED: negative means the scenario pays less. Unlike `ComparisonNumbers.differencePaise`
   * this is never an absolute value, so the direction of the change is never lost.
   */
  change: {
    totalTaxPaise: number;
    taxableIncomePaise: number;
    totalDeductionsPaise: number;
    rebatePaise: number;
    surchargePaise: number;
    cessPaise: number;
  };
};

const SCENARIO_MATCH_FIELDS = ["assessmentYearLabel", "regime", "engineVersion", "rulesVersion"] as const;

/**
 * The signed change from `base` to `scenario`: two results the engine itself produced, subtracted here so that no
 * tax arithmetic is ever done outside the engine. Pure; changes neither argument. Throws ScenarioMismatchError
 * (naming every field that differs) unless both were computed under the same assessment year, regime, engine version
 * and rules version. A different age category or different income is not a mismatch: that is what a scenario is.
 */
export function scenarioDelta(base: TaxResult, scenario: TaxResult): ScenarioDelta {
  const mismatched = SCENARIO_MATCH_FIELDS.filter((field) => base[field] !== scenario[field]);
  if (mismatched.length > 0) throw new ScenarioMismatchError([...mismatched]);

  return {
    assessmentYearLabel: base.assessmentYearLabel,
    regime: base.regime,
    engineVersion: base.engineVersion,
    rulesVersion: base.rulesVersion,
    base: { totalTaxPaise: base.totalTaxPaise, taxableIncomePaise: base.taxableIncomePaise },
    scenario: { totalTaxPaise: scenario.totalTaxPaise, taxableIncomePaise: scenario.taxableIncomePaise },
    change: {
      totalTaxPaise: scenario.totalTaxPaise - base.totalTaxPaise,
      taxableIncomePaise: scenario.taxableIncomePaise - base.taxableIncomePaise,
      totalDeductionsPaise: scenario.totalDeductionsPaise - base.totalDeductionsPaise,
      rebatePaise: scenario.rebatePaise - base.rebatePaise,
      surchargePaise: scenario.surchargePaise - base.surchargePaise,
      cessPaise: scenario.cessPaise - base.cessPaise,
    },
  };
}

function runRegime(
  regime: TaxRegime,
  input: TaxInput,
  calculate: (input: TaxInput) => TaxResult,
): RegimeOutcome {
  try {
    return { status: "ok", result: calculate(input) };
  } catch (error) {
    // Only a regime-specific refusal is a legitimate "no result for this
    // regime". Everything else propagates so it can never be mistaken for
    // a valid comparison.
    if (error instanceof UnsupportedTaxRuleError) {
      return { status: "refused", refusal: { kind: "unsupported_rule", message: error.message } };
    }
    throw error;
  }
}

/**
 * @param calculate the engine entry point; injectable so tests can simulate
 *   a regime refusing. Production callers use the default.
 */
export function compareRegimes(
  input: ComparisonInput,
  calculate: (input: TaxInput) => TaxResult = calculateTax,
): RegimeComparison {
  // The new regime (Section 115BAC) does not permit Chapter VI-A deductions
  // and the engine refuses them, so it is always given none. The old regime
  // gets exactly what the caller declared.
  const oldInput: TaxInput = { ...input, regime: "old" };
  const newInput: TaxInput = { ...input, regime: "new", deductions: [] };

  const oldOutcome = runRegime("old", oldInput, calculate);
  const newOutcome = runRegime("new", newInput, calculate);

  return {
    old: oldOutcome,
    new: newOutcome,
    numbers: comparisonNumbers(
      oldOutcome.status === "ok" ? oldOutcome.result : null,
      newOutcome.status === "ok" ? newOutcome.result : null,
    ),
  };
}
