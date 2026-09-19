// AY 2026-27 (FY 2025-26) tax rules — v3.
//
// Changes from v2 (Phase 3):
//   - Added statutory Chapter VI-A deduction LIMITS as data
//     (`deductionLimits`): Section 80C (combined limit under 80CCE) and
//     the structured Section 80D limits (self/family and parents, each with
//     a standard and a senior-citizen figure).
//   - Old-regime Section 87A: above the ₹5,00,000 threshold there is no
//     rebate. This is enforced in rebate.ts; there is no old-regime
//     marginal relief (see "Section 87A" below).
//   - Surcharge evidence upgraded: the bracket table and the marginal-
//     relief wording are now confirmed against the Income Tax Department's
//     own AY 2026-27 guidance (previously two secondary sources only).
// Unchanged from v2: slabs, standard deductions, cess rate, new-regime 87A.
//
// ---------------------------------------------------------------------
// EVIDENCE RECORD
// ---------------------------------------------------------------------
// Primary source for everything below unless noted: the Income Tax
// Department e-filing portal's official AY 2026-27 guidance, fetched
// directly (2026-09-19):
//   [S1] https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1
//        "Salaried Individuals for AY 2026-27"
//   [S2] https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-2
//        "Senior Citizens and Super Senior Citizens for AY 2026-2027"
// (The Department's other site, incometaxindia.gov.in, returned HTTP 403 to
// automated fetches, so the raw statute text there could not be read; the
// figures below are the Department's published guidance, not a paraphrase
// from memory or a secondary source.)
//
// Section 87A [S1, "Applicable Rebate u/s 87A"] — "Resident Individuals are
//   also eligible for a Rebate of up to 100% of income tax subject to a
//   maximum limit depending on tax regimes":
//     New Tax Regime: ₹60,000 — "Taxable income shall not exceed 12,00,000"
//     Old Tax Regime: ₹12,500 — "Taxable income shall not exceed 5,00,000"
//   The same page describes marginal relief ONLY for surcharge. It describes
//   no marginal relief for Section 87A in the old regime, so none is
//   implemented: above ₹5,00,000 the old-regime rebate is simply nil. (The
//   new-regime 87A marginal relief is unchanged from earlier phases, where it
//   was verified against CBDT guidance; see rebate.ts.) 87A is available to
//   RESIDENT individuals only; the engine has no residency input, so that is
//   an assumption the caller/UI must state.
// Section 80C / 80CCE [S1] — "Section 80C, 80CCC, 80CCD (1)": "Combined
//   deduction limit of ₹ 1,50,000". Section 80CCD(1B) (₹50,000) is a
//   separate additional deduction and is NOT modelled.
// Section 80D [S1 and S2] — "Deduction towards payments made to Health
//   Insurance Premium & Preventive Health check up":
//     For Self / Spouse or Dependent Children: "₹ 25,000 (₹ 50,000 if any
//       person is a Senior Citizen)"
//     For Parents: "₹ 25,000 (₹50,000 if any person is a Senior Citizen)"
//     "₹ 5,000 for preventive health checkup, included in above limit"
//   NOT modelled: the preventive-check-up sub-limit (it sits inside the
//   limits above), payment-mode conditions, and the separate "medical
//   expenditure on a senior citizen where no premium is paid" route
//   (₹50,000 each for self/family and parents).
// Senior citizen [S2] — "An individual resident who is 60 years or above in
//   age but less than 80 years at any time during the previous year is
//   considered as Senior Citizen … A Super Senior Citizen is an individual
//   resident who is 80 years or above, at any time during the previous
//   year." Both count as "senior" for the 80D self/family limit.
// Cess [S1] — "Health & Education cess @ 4% to be paid on the amount of
//   income tax plus Surcharge (if any) in both the regimes."
// Surcharge [S1, "Applicable Surcharge Rates"] — up to ₹50 lakh nil;
//   ₹50 lakh–₹1 crore 10%; ₹1–2 crore 15%; ₹2–5 crore 25%; above ₹5 crore
//   25% (new regime) / 37% (old regime). Marginal relief at ₹50 lakh,
//   ₹1 crore, ₹2 crore (and ₹5 crore, old regime only): "Amount payable as
//   income tax and surcharge shall not exceed the total amount payable as
//   income tax on total income of [threshold] by more than the amount of
//   income that exceeds [threshold]".
// Slabs, standard deduction: cross-checked against the same portal in
//   earlier phases (1C and 1C-B); unchanged here.
import type { AssessmentYearRules, DeductionLimits, RegimeRules, SlabBracket, SurchargeBracket } from "../types";

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
// Surcharge brackets — confirmed against the Income Tax Department's AY
// 2026-27 guidance [S1] (see the evidence record above). New regime caps
// at 25% from ₹2Cr onward (no further step at ₹5Cr); old regime steps up
// again to 37% at ₹5Cr.
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

// ---------------------------------------------------------------------
// Statutory Chapter VI-A limits — evidence record above ([S1], [S2]).
// Applied only under the old regime (the new regime refuses declared
// deductions outright; see `deductionsSupported`).
// ---------------------------------------------------------------------
const DEDUCTION_LIMITS: DeductionLimits = {
  section80CPaise: 1_50_000 * 100,
  section80D: {
    selfFamilyPaise: { standard: 25_000 * 100, senior: 50_000 * 100 },
    parentsPaise: { standard: 25_000 * 100, senior: 50_000 * 100 },
  },
};

export const AY_2026_27_RULES: AssessmentYearRules = {
  assessmentYearLabel: "2026-27",
  rulesVersion: "ay-2026-27-v3",
  regimes: { new: NEW_REGIME, old: OLD_REGIME },
  cessRateBasisPoints: 400, // 4% Health & Education Cess
  deductionLimits: DEDUCTION_LIMITS,
  supportedDeductionSections: ["80C", "80D"],
};
