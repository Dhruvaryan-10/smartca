// The SYNTHETIC tool set: the six assistant tools, answering from fixtures held in this file, for synthetic mode. It reads no
// database, no environment, no file and no network, and it has no user data: the one "user" it knows is SYNTHETIC_USER_ID, and
// every figure is a constant or comes from the pure tax engine on a constant.
//
// Why it exists: the orchestrator falls back to the REAL tools (which read the caller's own ledger) when it is given none. Synthetic
// mode must never be able to reach them, so it always passes THESE explicitly (services/assistant/synthetic.ts, pinned by tests).
//
// Each tool checks its arguments with the assistant's own validators (lib/assistant/args.ts) and then serves its fixture only when
// the arguments are exactly the fixture's; anything else is a typed refusal. The results have the shape of the real tools' results
// (a database-backed contract test compares them), so the answer layer treats them exactly as it treats real ones. Nothing here is
// tax law: the one evidence passage says so in its own title and text.
import {
  ToolArgumentError,
  defaultSummaryPeriod,
  readCalculateTaxArgs,
  readCompareTaxArgs,
  readFinancialSummaryArgs,
  readQueryTransactionsArgs,
  readSearchTaxLawArgs,
  readSimulateTaxArgs,
} from "@/lib/assistant/args";
import { COMPARISON_NOTICE } from "@/lib/assistant/tool-contract";
import type { ToolName } from "@/lib/assistant/tool-contract";
import { summarize } from "@/lib/summary";
import type { SummaryTransaction } from "@/lib/summary";
import { calculateTax, compareRegimes, scenarioDelta } from "@/tax-engine";
import type { ComparisonInput } from "@/tax-engine";
import { NotAuthenticatedError } from "../errors";
import type { createAssistantTools, ToolResult } from "./tools";

/** The only user synthetic mode knows. It is not an account: no row, session or table has it. */
export const SYNTHETIC_USER_ID = "synthetic-user-0001";

// The arguments a model sends, as the tools' validators read them. The synthetic transport sends exactly these.
export const SYNTHETIC_TAX_BODY = { assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
export const SYNTHETIC_SCENARIO_BODY = { assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 } };
export const SYNTHETIC_CALC_ARGS = { regime: "old", ...SYNTHETIC_TAX_BODY };
export const SYNTHETIC_SIMULATE_ARGS = { regime: "old", base: SYNTHETIC_TAX_BODY, scenario: SYNTHETIC_SCENARIO_BODY };
export const SYNTHETIC_SEARCH_ARGS = { question: "What is the rebate under section 87A?", assessmentYear: "2026-27" };

const INPUT: ComparisonInput = {
  assessmentYearLabel: "2026-27",
  ageCategory: "below60",
  incomeSources: [{ kind: "salary", label: "Salary", amountPaise: 150_000_000 }],
  deductions: [{ section: "80C", amountPaise: 15_000_000 }],
};
const SCENARIO_INPUT: ComparisonInput = { ...INPUT, deductions: [] };

/** The one passage in the synthetic corpus. It is labelled as test data, and it is not tax law. */
const EVIDENCE = {
  evidenceId: "ev_5359e7c0f1a2b3c4",
  sourceKey: "synthetic-fixture",
  title: "SYNTHETIC FIXTURE (test data, not tax law)",
  publisher: "SmartCA synthetic fixtures",
  url: "https://synthetic.invalid/fixture",
  authorityTier: "official_guidance",
  sectionRef: "87A",
  quote: "SYNTHETIC FIXTURE: this passage is test data and is not tax law.",
  assessmentYear: "2026-27",
  effectiveFrom: null,
  retrievedAt: "2026-01-01T00:00:00.000Z",
  corpusVersion: "synthetic-v1",
  verificationStatus: "synthetic_fixture",
};

/** Three synthetic ledger rows, for the summary's totals. There is no other ledger data anywhere in synthetic mode. */
const LEDGER: SummaryTransaction[] = [
  { id: "0", type: "income", amountPaise: 5_000_000, category: "Synthetic income", description: null, occurredOn: "2026-01-10" },
  { id: "1", type: "expense", amountPaise: 1_200_000, category: "Synthetic expense", description: null, occurredOn: "2026-02-10" },
  { id: "2", type: "expense", amountPaise: 300_000, category: "Synthetic expense", description: null, occurredOn: "2026-03-05" },
];

const canon = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const ok = <T>(tool: ToolName, result: T): ToolResult<T> => ({ status: "ok", tool, result });
const refuse = <T>(tool: ToolName, reason: "invalid_arguments" | "no_corpus_for_assessment_year", message: string, detail?: Record<string, unknown>): ToolResult<T> => ({
  status: "refused", tool, reason, message, ...(detail === undefined ? {} : { detail }),
});
const NOT_FIXTURE = "The synthetic tool set only serves its own fixtures: these arguments are not one of them.";

/** A synthetic tool: only the synthetic user may call it, bad arguments are a typed refusal, and it serves its fixture. */
function serve<T>(tool: ToolName, userId: string, work: () => ToolResult<T>): ToolResult<T> {
  if (userId !== SYNTHETIC_USER_ID) throw new NotAuthenticatedError();
  try {
    return work();
  } catch (error) {
    if (error instanceof ToolArgumentError) return refuse(tool, "invalid_arguments", error.message);
    throw error;
  }
}

export function createSyntheticTools(): ReturnType<typeof createAssistantTools> {
  const tools = {
    search_tax_law: async (userId: string, args: unknown) =>
      serve("search_tax_law", userId, () => {
        const { assessmentYear } = readSearchTaxLawArgs(args);
        if (assessmentYear !== "2026-27") {
          return refuse("search_tax_law", "no_corpus_for_assessment_year", "No usable evidence: no_corpus_for_assessment_year.", { assessmentYear, corpusVersion: "synthetic-v1", sectionRefs: [] });
        }
        return ok("search_tax_law", { assessmentYear: "2026-27", corpusVersion: "synthetic-v1", evidence: [{ ...EVIDENCE }], unmatchedSectionRefs: [], sectionResolutions: [] });
      }),

    // Not enabled in v1: row-level ledger data, and its free text, never reach a model. Synthetic mode has no rows to give.
    query_transactions: async (userId: string, args: unknown) =>
      serve("query_transactions", userId, () => {
        readQueryTransactionsArgs(args);
        return refuse("query_transactions", "invalid_arguments", "This tool is not enabled in synthetic mode.");
      }),

    get_financial_summary: async (userId: string, args: unknown) =>
      serve("get_financial_summary", userId, () => {
        const { from, to } = readFinancialSummaryArgs(args);
        if (from !== null || to !== null) return refuse("get_financial_summary", "invalid_arguments", NOT_FIXTURE);
        const summary = summarize(LEDGER);
        const latest = LEDGER.reduce((max, row) => (row.occurredOn > max ? row.occurredOn : max), "");
        return ok("get_financial_summary", {
          period: defaultSummaryPeriod(latest),
          periodIsDefault: true,
          transactionCount: summary.transactionCount,
          incomePaise: summary.incomePaise,
          expensePaise: summary.expensePaise,
          savingsPaise: summary.savingsPaise,
          savingsRatePercent: summary.savingsRatePercent,
          range: summary.range,
          months: summary.months,
          monthsTruncated: summary.monthsTruncated,
          categories: [], // category names are ledger free text: withheld in v1, totals only
        });
      }),

    calculate_tax: async (userId: string, args: unknown) =>
      serve("calculate_tax", userId, () => {
        const { regime, body } = readCalculateTaxArgs(args);
        if (regime !== "old" || canon(body) !== canon(SYNTHETIC_TAX_BODY)) return refuse("calculate_tax", "invalid_arguments", NOT_FIXTURE);
        return ok("calculate_tax", { regime: "old" as const, assessmentYear: "2026-27", input: INPUT, result: calculateTax({ ...INPUT, regime: "old" }) });
      }),

    compare_tax_regimes: async (userId: string, args: unknown) =>
      serve("compare_tax_regimes", userId, () => {
        if (canon(readCompareTaxArgs(args)) !== canon(SYNTHETIC_TAX_BODY)) return refuse("compare_tax_regimes", "invalid_arguments", NOT_FIXTURE);
        return ok("compare_tax_regimes", {
          assessmentYear: { label: "2026-27", financialYearLabel: "2025-26", startDate: "2025-04-01", endDate: "2026-03-31" },
          input: INPUT,
          comparison: compareRegimes(INPUT),
          notice: COMPARISON_NOTICE,
        });
      }),

    simulate_tax: async (userId: string, args: unknown) =>
      serve("simulate_tax", userId, () => {
        const { regime, base, scenario } = readSimulateTaxArgs(args);
        if (regime !== "old" || canon(base) !== canon(SYNTHETIC_TAX_BODY) || canon(scenario) !== canon(SYNTHETIC_SCENARIO_BODY)) return refuse("simulate_tax", "invalid_arguments", NOT_FIXTURE);
        return ok("simulate_tax", {
          regime: "old" as const,
          base: { input: INPUT },
          scenario: { input: SCENARIO_INPUT },
          delta: scenarioDelta(calculateTax({ ...INPUT, regime: "old" }), calculateTax({ ...SCENARIO_INPUT, regime: "old" })),
        });
      }),
  };
  return tools as unknown as ReturnType<typeof createAssistantTools>;
}
