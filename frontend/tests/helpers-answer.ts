// Fixture builders for the answer-layer tests (assistant-answer.test.ts, assistant-answer-eval.test.ts). Not a test file:
// the test glob only runs *.test.ts.
//
// Tool records are built from the REAL deterministic engine (calculateTax, compareRegimes, scenarioDelta) and the real
// notice constants, in exactly the envelope shapes the Phase 6B tools return, so the numbers in every fixture are genuine
// paise values and the answer layer is exercised on what it will really receive. No database, no model, no network.
// PURE: it imports no database client and loads no environment, so tests built on it run with no DATABASE_URL (a test pins that).
import { COMPARISON_NOTICE, LEDGER_DATA_NOTICE } from "../lib/assistant/tool-contract";
import { calculateTax, compareRegimes, scenarioDelta } from "../tax-engine";
import type { TaxInput, TaxRegime } from "../tax-engine";
import type { ToolRecord } from "../lib/assistant/answer";

export const RUPEE = 100;
export { COMPARISON_NOTICE, LEDGER_DATA_NOTICE };

/** Paise -> "₹12,34,567" (Indian grouping), the way a model would write it. */
export function inr(paise: number): string {
  const rupees = Math.trunc(Math.abs(paise) / 100);
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  const cents = Math.abs(paise) % 100;
  return `${paise < 0 ? "-" : ""}₹${grouped}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

export type Scenario = { salaryRupees?: number; deductionRupees?: number; ageCategory?: TaxInput["ageCategory"] };
export function engineInput(s: Scenario = {}): Omit<TaxInput, "regime"> {
  const { salaryRupees = 1_500_000, deductionRupees = 150_000, ageCategory = "below60" } = s;
  return {
    assessmentYearLabel: "2026-27",
    ageCategory,
    incomeSources: [{ kind: "salary", label: "Salary", amountPaise: salaryRupees * RUPEE }],
    deductions: deductionRupees > 0 ? [{ section: "80C", amountPaise: deductionRupees * RUPEE }] : [],
  };
}

const record = (round: number, callId: string, tool: string, result: unknown): ToolRecord => ({ round, callId, tool, result });
const okEnvelope = (tool: string, result: unknown) => ({ status: "ok", tool, result });
const refusedEnvelope = (tool: string, reason: string, message: string, detail?: Record<string, unknown>) => ({
  status: "refused", tool, reason, message, ...(detail === undefined ? {} : { detail }),
});

// --- tax tools ------------------------------------------------------------------------

/** What calculate_tax returns. The new regime is given no deductions (the engine refuses them there). */
export function calcRecord(regime: TaxRegime, s: Scenario = {}, callId = "calc1", round = 1): ToolRecord {
  const input = engineInput(regime === "new" ? { ...s, deductionRupees: 0 } : s);
  return record(round, callId, "calculate_tax", okEnvelope("calculate_tax", { regime, assessmentYear: "2026-27", input, result: calculateTax({ ...input, regime }) }));
}
export const calcResult = (regime: TaxRegime, s: Scenario = {}) => calculateTax({ ...engineInput(regime === "new" ? { ...s, deductionRupees: 0 } : s), regime });

export function compareRecord(s: Scenario = {}, callId = "cmp1", round = 1): ToolRecord {
  const input = engineInput(s);
  return record(round, callId, "compare_tax_regimes", okEnvelope("compare_tax_regimes", {
    assessmentYear: { label: "2026-27", financialYearLabel: "2025-26", startDate: "2025-04-01", endDate: "2026-03-31" },
    input,
    comparison: compareRegimes(input),
    notice: COMPARISON_NOTICE,
  }));
}
export const compareResult = (s: Scenario = {}) => compareRegimes(engineInput(s));

export function simulateRecord(base: Scenario, scenario: Scenario, regime: TaxRegime = "old", callId = "sim1", round = 1): ToolRecord {
  const baseInput = engineInput(base);
  const scenarioInput = engineInput(scenario);
  return record(round, callId, "simulate_tax", okEnvelope("simulate_tax", {
    regime,
    base: { input: baseInput },
    scenario: { input: scenarioInput },
    delta: scenarioDelta(calculateTax({ ...baseInput, regime }), calculateTax({ ...scenarioInput, regime })),
  }));
}
export const simulateDelta = (base: Scenario, scenario: Scenario, regime: TaxRegime = "old") =>
  scenarioDelta(calculateTax({ ...engineInput(base), regime }), calculateTax({ ...engineInput(scenario), regime }));

export const taxRefusal = (tool: string, reason = "unsupported_tax_rule", message = "The new regime does not allow Chapter VI-A deductions.", callId = "ref1", round = 1): ToolRecord =>
  record(round, callId, tool, refusedEnvelope(tool, reason, message));

// --- search_tax_law -------------------------------------------------------------------

export type EvidenceOptions = { tier?: "statute" | "notification_circular" | "official_guidance"; quote?: string; sectionRef?: string | null };
export function evidenceId(n: number): string {
  return `ev_${n.toString(16).padStart(16, "0")}`;
}
/** Evidence exactly as search_tax_law returns it (chunkId and score already dropped). */
export function evidence(n: number, o: EvidenceOptions = {}) {
  return {
    evidenceId: evidenceId(n),
    sourceKey: "itd-efiling-salaried-individuals-ay-2026-27",
    title: "Salaried Individuals for AY 2026-27",
    publisher: "Income Tax Department e-Filing portal",
    url: "https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-1",
    authorityTier: o.tier ?? "official_guidance",
    sectionRef: o.sectionRef === undefined ? "87A" : o.sectionRef,
    quote: o.quote ?? "New Tax Regime | ₹ 60,000 | Taxable income shall not exceed 12,00,000",
    assessmentYear: "2026-27",
    effectiveFrom: null,
    retrievedAt: "2026-09-19T00:00:00.000Z",
    corpusVersion: "ay-2026-27-v1",
    verificationStatus: "primary_verified",
  };
}
export const searchRecord = (evidenceList: Array<ReturnType<typeof evidence>>, callId = "srch1", round = 1): ToolRecord =>
  record(round, callId, "search_tax_law", okEnvelope("search_tax_law", {
    assessmentYear: "2026-27", corpusVersion: "ay-2026-27-v1", evidence: evidenceList, unmatchedSectionRefs: [], sectionResolutions: [],
  }));
export const searchRefusal = (reason: string, detail: Record<string, unknown> = {}, callId = "srch1", round = 1): ToolRecord =>
  record(round, callId, "search_tax_law", refusedEnvelope("search_tax_law", reason, `No usable evidence: ${reason}.`, {
    assessmentYear: "2026-27", corpusVersion: "ay-2026-27-v1", sectionRefs: [], ...detail,
  }));

// --- ledger tools ---------------------------------------------------------------------

export type LedgerRow = { occurredOn: string; type: "income" | "expense"; amountPaise: number; category: string; description?: string | null; source: string | null };
export function transactionsRecord(rows: LedgerRow[], callId = "txn1", round = 1): ToolRecord {
  let incomePaise = 0;
  let expensePaise = 0;
  for (const r of rows) {
    if (r.type === "income") incomePaise += r.amountPaise;
    else expensePaise += r.amountPaise;
  }
  return record(round, callId, "query_transactions", okEnvelope("query_transactions", {
    filter: { from: null, to: null, category: null, type: null },
    descriptionsIncluded: rows.some((r) => r.description !== undefined),
    matched: rows.length, returned: rows.length, truncated: false, fieldsTruncated: false,
    totals: { incomePaise, expensePaise },
    transactions: rows,
    dataNotice: LEDGER_DATA_NOTICE,
  }));
}
export function summaryRecord(o: { incomePaise: number; expensePaise: number; categories?: Array<{ category: string; totalPaise: number }> }, callId = "sum1", round = 1): ToolRecord {
  const categories = (o.categories ?? [{ category: "Rent", totalPaise: o.expensePaise }]).map((c) => ({ ...c, sharePercent: 100, isRemainder: false }));
  return record(round, callId, "get_financial_summary", okEnvelope("get_financial_summary", {
    period: { from: "2025-04-01", to: "2026-03-20" }, periodIsDefault: true,
    transactionCount: 3, incomePaise: o.incomePaise, expensePaise: o.expensePaise, savingsPaise: o.incomePaise - o.expensePaise, savingsRatePercent: 33,
    range: { from: "2025-05-01", to: "2026-03-20" }, months: [], monthsTruncated: false, categories,
  }));
}
