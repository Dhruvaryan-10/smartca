// AY 2026-27 (FY 2025-26) tax rules — v2.
//
// Changes from v1 (see MIGRATION-CHECKPOINT.md-style history in git for
// the full Phase 1C-B verification report this is based on):
//   - Added senior/super-senior old-regime slab tables (new-regime
//     slabs remain deliberately identical across all age categories —
//     Section 115BAC does not vary by age; a Phase 1C-B fetch artifact
//     suggesting otherwise was investigated and explicitly rejected).
//   - Added surcharge bracket tables, per regime.
//   - Standard deduction, base slabs (below-60 old + new), and Section
//     87A threshold/cap figures: all re-confirmed unchanged from v1.
//
// SOURCING: new/old (below-60) slabs, standard deduction, and 87A
// threshold/cap figures were cross-checked against the Income Tax
// Department's own e-filing portal (incometax.gov.in, fetched directly)
// in both Phase 1C and Phase 1C-B. Senior/super-senior old-regime slabs
// were fetched directly from the same portal's "Senior Citizens and
// Super Senior Citizens for AY 2026-2027" page in Phase 1C-B, and
// independently corroborated by a second search. Surcharge bracket
// figures are corroborated by TWO independent secondary sources across
// both phases but were NOT independently fetched from a primary
// government document — implemented per explicit Phase 1C-C direction,
// with that evidence-level caveat documented honestly here rather than
// overstated as fully primary-verified.
import type { AssessmentYearRules, RegimeRules, SlabBracket, SurchargeBracket } from "../types";

// ---------------------------------------------------------------------
// New-regime slabs (Section 115BAC) — identical for every age category.
// ---------------------------------------------------------------------
const NEW_REGIME_SLABS: SlabBracket[] = [
  { label: "₹0 - ₹4,00,000 @ 0%", uptoPaise: 4_00_000 * 100, rateBasisPoints: 0 },
  { label: "₹4,00,000 - ₹8,00,000 @ 5%", uptoPaise: 8_00_000 * 100, rateBasisPoints: 500 },
  { label: "₹8,00,000 - ₹12,00,000 @ 10%", uptoPaise: 12_00_000 * 100, rateBasisPoints: 1000 },
  { label: "₹12,00,000 - ₹16,00,000 @ 15%", uptoPaise: 16_00_000 * 100, rateBasisPoints: 1500 },
  { label: "₹16,00,000 - ₹20,00,000 @ 20%", uptoPaise: 20_00_000 * 100, rateBasisPoints: 2000 },
  { label: "₹20,00,000 - ₹24,00,000 @ 25%", uptoPaise: 24_00_000 * 100, rateBasisPoints: 2500 },
  { label: "Above ₹24,00,000 @ 30%", uptoPaise: null, rateBasisPoints: 3000 },
];

// ---------------------------------------------------------------------
// Old-regime slabs — genuinely age-dependent.
// ---------------------------------------------------------------------
const OLD_REGIME_SLABS_BELOW_60: SlabBracket[] = [
  { label: "₹0 - ₹2,50,000 @ 0%", uptoPaise: 2_50_000 * 100, rateBasisPoints: 0 },
  { label: "₹2,50,000 - ₹5,00,000 @ 5%", uptoPaise: 5_00_000 * 100, rateBasisPoints: 500 },
  { label: "₹5,00,000 - ₹10,00,000 @ 20%", uptoPaise: 10_00_000 * 100, rateBasisPoints: 2000 },
  { label: "Above ₹10,00,000 @ 30%", uptoPaise: null, rateBasisPoints: 3000 },
];

const OLD_REGIME_SLABS_SENIOR: SlabBracket[] = [
  { label: "₹0 - ₹3,00,000 @ 0% (senior citizen)", uptoPaise: 3_00_000 * 100, rateBasisPoints: 0 },
  { label: "₹3,00,000 - ₹5,00,000 @ 5%", uptoPaise: 5_00_000 * 100, rateBasisPoints: 500 },
  { label: "₹5,00,000 - ₹10,00,000 @ 20%", uptoPaise: 10_00_000 * 100, rateBasisPoints: 2000 },
  { label: "Above ₹10,00,000 @ 30%", uptoPaise: null, rateBasisPoints: 3000 },
];

const OLD_REGIME_SLABS_SUPER_SENIOR: SlabBracket[] = [
  { label: "₹0 - ₹5,00,000 @ 0% (super senior citizen)", uptoPaise: 5_00_000 * 100, rateBasisPoints: 0 },
  { label: "₹5,00,000 - ₹10,00,000 @ 20%", uptoPaise: 10_00_000 * 100, rateBasisPoints: 2000 },
  { label: "Above ₹10,00,000 @ 30%", uptoPaise: null, rateBasisPoints: 3000 },
];

// ---------------------------------------------------------------------
// Surcharge brackets — corroborated by two independent secondary
// sources, NOT primary-fetched (see sourcing note above). New regime
// caps at 25% from ₹2Cr onward (no further step at ₹5Cr); old regime
// steps up again to 37% at ₹5Cr.
// ---------------------------------------------------------------------
const SURCHARGE_BRACKETS_NEW: SurchargeBracket[] = [
  { label: "up to ₹50,00,000", fromPaise: 0, rateBasisPoints: 0 },
  { label: "₹50,00,000 - ₹1,00,00,000", fromPaise: 50_00_000 * 100, rateBasisPoints: 1000 },
  { label: "₹1,00,00,000 - ₹2,00,00,000", fromPaise: 1_00_00_000 * 100, rateBasisPoints: 1500 },
  { label: "Above ₹2,00,00,000 (new regime cap)", fromPaise: 2_00_00_000 * 100, rateBasisPoints: 2500 },
];

const SURCHARGE_BRACKETS_OLD: SurchargeBracket[] = [
  { label: "up to ₹50,00,000", fromPaise: 0, rateBasisPoints: 0 },
  { label: "₹50,00,000 - ₹1,00,00,000", fromPaise: 50_00_000 * 100, rateBasisPoints: 1000 },
  { label: "₹1,00,00,000 - ₹2,00,00,000", fromPaise: 1_00_00_000 * 100, rateBasisPoints: 1500 },
  { label: "₹2,00,00,000 - ₹5,00,00,000", fromPaise: 2_00_00_000 * 100, rateBasisPoints: 2500 },
  { label: "Above ₹5,00,00,000 (old regime)", fromPaise: 5_00_00_000 * 100, rateBasisPoints: 3700 },
];

const NEW_REGIME: RegimeRules = {
  slabs: { below60: NEW_REGIME_SLABS, senior: NEW_REGIME_SLABS, superSenior: NEW_REGIME_SLABS },
  standardDeductionPaise: 75_000 * 100,
  rebate: {
    thresholdPaise: 12_00_000 * 100,
    maxRebatePaise: 60_000 * 100,
    sourceSection: "Section 87A",
  },
  // Verified in Phase 1C-B: Section 115BAC does NOT permit Chapter VI-A
  // deductions like 80C/80D (narrow exceptions, e.g. employer NPS
  // contributions under 80CCD(2), are not in this engine's scope at all).
  deductionsSupported: false,
  surchargeBrackets: SURCHARGE_BRACKETS_NEW,
};

const OLD_REGIME: RegimeRules = {
  slabs: { below60: OLD_REGIME_SLABS_BELOW_60, senior: OLD_REGIME_SLABS_SENIOR, superSenior: OLD_REGIME_SLABS_SUPER_SENIOR },
  standardDeductionPaise: 50_000 * 100,
  rebate: {
    thresholdPaise: 5_00_000 * 100,
    maxRebatePaise: 12_500 * 100,
    sourceSection: "Section 87A",
  },
  // Long-standing, uncontested — unlike the new regime.
  deductionsSupported: true,
  surchargeBrackets: SURCHARGE_BRACKETS_OLD,
};

export const AY_2026_27_RULES: AssessmentYearRules = {
  assessmentYearLabel: "2026-27",
  rulesVersion: "ay-2026-27-v2",
  regimes: { new: NEW_REGIME, old: OLD_REGIME },
  cessRateBasisPoints: 400, // 4% Health & Education Cess
  supportedDeductionSections: ["80C", "80D"],
};
