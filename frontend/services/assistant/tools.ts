// The deterministic, READ-ONLY tool layer for the future assistant. There is no model, route or UI here: this is what a
// model will be allowed to call, and nothing else.
//
//   server-verified userId + validated args -> a tool -> existing trusted code -> a typed envelope
//
// Rules this file enforces:
//   - Every tool is `(userId, args)`. `userId` comes from the server (services/session.ts) and is NEVER an argument:
//     the validators in lib/assistant/args.ts are strict allow-lists and reject it, an executor, or any other unknown
//     field by name.
//   - Nothing here writes. It imports no write function and no database client, and a test pins that. In particular it
//     cannot reach the generic computation writer, the save path, or the Tax workspace loader.
//   - Every tax figure comes from the deterministic engine. This file only selects a regime and passes the engine's own
//     output (or its refusal) through; the one difference it reports is computed by the engine's scenarioDelta.
//   - Refusals are preserved, never worked around: an engine refusal, an unsupported year, and every typed retrieval
//     refusal come back as `status: "refused"` with their own typed reason.
//   - The ledger is the caller's own (listTransactions filters by userId in the query), filtered and capped here, and
//     projected down to the few fields an assistant needs. Its free text is UNTRUSTED data.
import { retrieveTaxLaw } from "../tax-retrieval";
import type { InsufficientReason, SectionResolution, TaxEvidence, TaxRetrievalInput, TaxRetrievalResult } from "../tax-retrieval";
import { computeTax, parseTaxRequest } from "../tax";
import { listTransactions } from "../transactions";
import { NotAuthenticatedError, ValidationError } from "../errors";
import {
  MAX_CATEGORY_CHARS,
  MAX_EVIDENCE_RETURNED,
  MAX_LEDGER_DESCRIPTION_CHARS,
  MAX_LEDGER_SOURCE_CHARS,
  MAX_MATCHED_TRANSACTIONS,
  ToolArgumentError,
  defaultSummaryPeriod,
  readCalculateTaxArgs,
  readCompareTaxArgs,
  readFinancialSummaryArgs,
  readQueryTransactionsArgs,
  readSearchTaxLawArgs,
  readSimulateTaxArgs,
} from "@/lib/assistant/args";
import type { TransactionFilter } from "@/lib/assistant/args";
import { AssistantFailure } from "@/lib/assistant/failure";
import { ASSISTANT_TOOL_NAMES, COMPARISON_NOTICE, LEDGER_DATA_NOTICE } from "@/lib/assistant/tool-contract";
import type { ToolName } from "@/lib/assistant/tool-contract";
import { summarize } from "@/lib/summary";
import type { SummaryTransaction } from "@/lib/summary";
import {
  ScenarioMismatchError,
  TaxInputValidationError,
  UnsupportedAssessmentYearError,
  UnsupportedTaxRuleError,
  calculateTax,
  scenarioDelta,
} from "@/tax-engine";
import type { ComparisonInput, RegimeComparison, ScenarioDelta, TaxRegime, TaxResult } from "@/tax-engine";

// ---------------------------------------------------------------------
// The result envelope
// ---------------------------------------------------------------------

// The names and the two notices live in a module with no imports (lib/assistant/tool-contract.ts), so that code which only
// talks about the tools does not have to import this file and, through it, the database. They are re-exported unchanged.
export { ASSISTANT_TOOL_NAMES, COMPARISON_NOTICE, LEDGER_DATA_NOTICE };
export type { ToolName };

/** Why a tool declined. Retrieval's own typed reasons are passed through unchanged. */
export type ToolRefusalReason =
  | "invalid_arguments"
  | "unsupported_assessment_year"
  | "unsupported_tax_rule"
  | "scenario_mismatch"
  | "too_many_transactions"
  | InsufficientReason;

/** Either a deterministic result, or a typed refusal. Nothing in between: a refusal never carries a partial answer. */
export type ToolResult<T> =
  | { status: "ok"; tool: ToolName; result: T }
  | { status: "refused"; tool: ToolName; reason: ToolRefusalReason; message: string; detail?: Record<string, unknown> };

const okResult = <T>(tool: ToolName, result: T): ToolResult<T> => ({ status: "ok", tool, result });
const refusal = <T>(tool: ToolName, reason: ToolRefusalReason, message: string, detail?: Record<string, unknown>): ToolResult<T> => ({
  status: "refused",
  tool,
  reason,
  message,
  ...(detail === undefined ? {} : { detail }),
});

/**
 * Turn the failures that MEAN "no" into typed refusals. Anything else (a database error, an engine self-check failure) is not
 * a refusal: it is never mistaken for a valid answer, and it is never passed on as it is either. A Drizzle error carries the
 * statement and its bound parameters (for a ledger query, the userId) in its message, so an unexpected error is replaced by an
 * AssistantFailure that keeps only a code, the error's class name and the database error code. Typed errors that already
 * mean something pass through unchanged.
 */
async function guarded<T>(tool: ToolName, work: () => Promise<ToolResult<T>>): Promise<ToolResult<T>> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ToolArgumentError || error instanceof ValidationError || error instanceof TaxInputValidationError) {
      return refusal(tool, "invalid_arguments", error.message);
    }
    if (error instanceof UnsupportedAssessmentYearError) return refusal(tool, "unsupported_assessment_year", error.message);
    if (error instanceof UnsupportedTaxRuleError) return refusal(tool, "unsupported_tax_rule", error.message);
    if (error instanceof ScenarioMismatchError) return refusal(tool, "scenario_mismatch", error.message, { fields: error.fields });
    if (error instanceof NotAuthenticatedError || error instanceof AssistantFailure) throw error;
    throw new AssistantFailure("tool_failed", error, tool);
  }
}

function requireUser(userId: unknown): string {
  if (typeof userId !== "string" || userId.trim() === "") throw new NotAuthenticatedError();
  return userId;
}

// ---------------------------------------------------------------------
// search_tax_law
// ---------------------------------------------------------------------

/** What a caller may cite: the evidence without its database id and without the ranking score (which is not a confidence). */
export type SearchEvidence = Omit<TaxEvidence, "chunkId" | "score">;

export type SearchTaxLawResult = {
  assessmentYear: string;
  corpusVersion: string;
  evidence: SearchEvidence[];
  unmatchedSectionRefs: string[];
  sectionResolutions: SectionResolution[];
};

function projectEvidence(evidence: TaxEvidence): SearchEvidence {
  return {
    evidenceId: evidence.evidenceId,
    sourceKey: evidence.sourceKey,
    title: evidence.title,
    publisher: evidence.publisher,
    url: evidence.url,
    authorityTier: evidence.authorityTier,
    sectionRef: evidence.sectionRef,
    quote: evidence.quote,
    assessmentYear: evidence.assessmentYear,
    effectiveFrom: evidence.effectiveFrom,
    retrievedAt: evidence.retrievedAt,
    corpusVersion: evidence.corpusVersion,
    verificationStatus: evidence.verificationStatus,
  };
}

// ---------------------------------------------------------------------
// The ledger: filtered, capped, projected
// ---------------------------------------------------------------------

type LedgerRow = Awaited<ReturnType<typeof listTransactions>>[number];

/** The rows that match, newest first; null when more than MAX_MATCHED_TRANSACTIONS match. Pure: `rows` are already the caller's own. */
function selectTransactions(rows: LedgerRow[], filter: Pick<TransactionFilter, "from" | "to"> & Partial<TransactionFilter>): LedgerRow[] | null {
  const wantedCategory = filter.category?.toLowerCase() ?? null;
  const matched = rows
    .filter(
      (row) =>
        (filter.from === null || row.occurredOn >= filter.from) &&
        (filter.to === null || row.occurredOn <= filter.to) &&
        (wantedCategory === null || row.category.trim().toLowerCase() === wantedCategory) &&
        (filter.type == null || row.type === filter.type),
    )
    .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return matched.length > MAX_MATCHED_TRANSACTIONS ? null : matched;
}

/** `value` cut to `max` characters with a visible ellipsis when it is longer, and whether it was. */
function capText(value: string, max: number): { text: string; truncated: boolean } {
  const characters = [...value];
  return characters.length <= max ? { text: value, truncated: false } : { text: `${characters.slice(0, max - 1).join("")}…`, truncated: true };
}

const tooMany = <T>(tool: ToolName): ToolResult<T> =>
  refusal(tool, "too_many_transactions", `More than ${MAX_MATCHED_TRANSACTIONS} transactions match. Narrow the period or the filters; nothing is silently cut off.`);

export type LedgerTransaction = {
  occurredOn: string;
  type: "income" | "expense";
  amountPaise: number;
  /** Capped at MAX_CATEGORY_CHARS. */
  category: string;
  /** Present only when the caller asked for descriptions (`includeDescription`), and then capped at MAX_LEDGER_DESCRIPTION_CHARS. */
  description?: string | null;
  /** Capped at MAX_LEDGER_SOURCE_CHARS. */
  source: string | null;
};

export type QueryTransactionsResult = {
  filter: TransactionFilter;
  /** True only when the caller asked for descriptions; otherwise no row has a `description` at all. */
  descriptionsIncluded: boolean;
  /** How many transactions match the filter, whatever the limit. */
  matched: number;
  returned: number;
  /** More rows matched than were returned. */
  truncated: boolean;
  /** Some category, source or description was cut to its cap. */
  fieldsTruncated: boolean;
  /** Code-derived over ALL matches, not just the ones returned. */
  totals: { incomePaise: number; expensePaise: number };
  transactions: LedgerTransaction[];
  dataNotice: string;
};

export type FinancialSummaryResult = {
  /** The period actually summarised. Null ends only for an empty ledger. */
  period: { from: string | null; to: string | null };
  /** True when no period was given and the default (the 12 months ending at the latest transaction) was applied. */
  periodIsDefault: boolean;
} & Omit<ReturnType<typeof summarize>, "recent">;

// ---------------------------------------------------------------------
// The tax tools
// ---------------------------------------------------------------------

export type CalculateTaxResult = { regime: TaxRegime; assessmentYear: string; input: ComparisonInput; result: TaxResult };
export type CompareTaxRegimesResult = {
  assessmentYear: { label: string; financialYearLabel: string; startDate: string; endDate: string };
  input: ComparisonInput;
  comparison: RegimeComparison;
  notice: string;
};
export type SimulateTaxResult = { regime: TaxRegime; base: { input: ComparisonInput }; scenario: { input: ComparisonInput }; delta: ScenarioDelta };

// ---------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------

export type AssistantToolDeps = {
  /** Tax-law retrieval. Code chooses it; the model never does. It receives one argument: there is no way to hand it an executor. */
  retrieve?: (input: TaxRetrievalInput) => Promise<TaxRetrievalResult>;
  /** The caller's own ledger. Code chooses it; the model never does. It receives the userId and nothing else. */
  listTransactions?: (userId: string) => Promise<LedgerRow[]>;
};

export function createAssistantTools(deps: AssistantToolDeps = {}) {
  const retrieve = deps.retrieve ?? ((input: TaxRetrievalInput) => retrieveTaxLaw(input));
  const readLedger = deps.listTransactions ?? listTransactions;

  return {
    search_tax_law: async (userId: string, args: unknown): Promise<ToolResult<SearchTaxLawResult>> => {
      requireUser(userId);
      return guarded("search_tax_law", async () => {
        const { question, assessmentYear, sectionRef } = readSearchTaxLawArgs(args);
        const found = await retrieve({ question, assessmentYear, ...(sectionRef === undefined ? {} : { sectionRef }) });
        if (found.status === "insufficient_evidence") {
          return refusal("search_tax_law", found.reason, `No usable evidence: ${found.reason}.`, {
            assessmentYear: found.assessmentYear,
            corpusVersion: found.corpusVersion,
            sectionRefs: found.sectionRefs,
            ...(found.yearMismatch === undefined ? {} : { yearMismatch: found.yearMismatch }),
            ...(found.authorityTier === undefined ? {} : { authorityTier: found.authorityTier }),
          });
        }
        const evidence = found.evidence.slice(0, MAX_EVIDENCE_RETURNED).map(projectEvidence);
        const kept = new Set(evidence.map((e) => e.evidenceId));
        return okResult("search_tax_law", {
          assessmentYear: found.assessmentYear,
          corpusVersion: found.corpusVersion,
          evidence,
          unmatchedSectionRefs: found.unmatchedSectionRefs,
          sectionResolutions: found.sectionResolutions.map((r) => ({ ...r, evidenceIds: r.evidenceIds.filter((id) => kept.has(id)) })),
        });
      });
    },

    query_transactions: async (userId: string, args: unknown): Promise<ToolResult<QueryTransactionsResult>> => {
      requireUser(userId);
      return guarded("query_transactions", async () => {
        const { limit, includeDescription, ...filter } = readQueryTransactionsArgs(args);
        const matched = selectTransactions(await readLedger(userId), filter);
        if (matched === null) return tooMany("query_transactions");

        let incomePaise = 0;
        let expensePaise = 0;
        for (const row of matched) {
          if (row.type === "income") incomePaise += row.amountPaise;
          else expensePaise += row.amountPaise;
        }
        // Deterministic fields are copied as they are. Free text is capped, and the description is only here if it was asked for.
        let fieldsTruncated = false;
        const transactions: LedgerTransaction[] = matched.slice(0, limit).map((row) => {
          const category = capText(row.category, MAX_CATEGORY_CHARS);
          const source = row.source === null ? null : capText(row.source, MAX_LEDGER_SOURCE_CHARS);
          const description = includeDescription && row.description !== null ? capText(row.description, MAX_LEDGER_DESCRIPTION_CHARS) : null;
          fieldsTruncated ||= category.truncated || Boolean(source?.truncated) || Boolean(description?.truncated);
          return {
            occurredOn: row.occurredOn,
            type: row.type,
            amountPaise: row.amountPaise,
            category: category.text,
            ...(includeDescription ? { description: description === null ? null : description.text } : {}),
            source: source === null ? null : source.text,
          };
        });
        return okResult("query_transactions", {
          filter,
          descriptionsIncluded: includeDescription,
          matched: matched.length,
          returned: transactions.length,
          truncated: matched.length > transactions.length,
          fieldsTruncated,
          totals: { incomePaise, expensePaise },
          transactions,
          dataNotice: LEDGER_DATA_NOTICE,
        });
      });
    },

    get_financial_summary: async (userId: string, args: unknown): Promise<ToolResult<FinancialSummaryResult>> => {
      requireUser(userId);
      return guarded("get_financial_summary", async () => {
        const requested = readFinancialSummaryArgs(args);
        const all = await readLedger(userId);

        // Never the whole ledger by default: with no period, the 12 calendar months ending at the latest transaction.
        // (A date taken from the data, not from a clock, so the same ledger always gives the same summary; no tax-year rule.)
        const periodIsDefault = requested.from === null;
        const latest = all.reduce<string | null>((max, row) => (max === null || row.occurredOn > max ? row.occurredOn : max), null);
        const period = !periodIsDefault ? requested : latest === null ? { from: null, to: null } : defaultSummaryPeriod(latest);

        const matched = selectTransactions(all, period);
        if (matched === null) return tooMany("get_financial_summary");

        // No description and no id goes into the summary, and the summary's "recent" list (which carries both) is not returned.
        const rows: SummaryTransaction[] = matched.map((row, index) => ({
          id: String(index),
          type: row.type,
          amountPaise: row.amountPaise,
          category: row.category,
          description: null,
          occurredOn: row.occurredOn,
        }));
        const summary = summarize(rows);
        return okResult("get_financial_summary", {
          period,
          periodIsDefault,
          transactionCount: summary.transactionCount,
          incomePaise: summary.incomePaise,
          expensePaise: summary.expensePaise,
          savingsPaise: summary.savingsPaise,
          savingsRatePercent: summary.savingsRatePercent,
          range: summary.range,
          months: summary.months,
          monthsTruncated: summary.monthsTruncated,
          // Category names are user-entered text, so they are capped like everywhere else.
          categories: summary.categories.map((c) => ({ ...c, category: capText(c.category, MAX_CATEGORY_CHARS).text })),
        });
      });
    },

    calculate_tax: async (userId: string, args: unknown): Promise<ToolResult<CalculateTaxResult>> => {
      requireUser(userId);
      return guarded("calculate_tax", async () => {
        const { regime, body } = readCalculateTaxArgs(args);
        // The existing validation, then the engine for exactly the regime asked for. Nothing is adjusted on the way: if
        // the regime cannot support the input (the new regime with declared deductions) the engine refuses and that
        // refusal is what comes back. Nothing is saved.
        const { assessmentYear, input } = parseTaxRequest(body);
        const result = calculateTax({ ...input, regime });
        return okResult("calculate_tax", { regime, assessmentYear, input, result });
      });
    },

    compare_tax_regimes: async (userId: string, args: unknown): Promise<ToolResult<CompareTaxRegimesResult>> => {
      requireUser(userId);
      return guarded("compare_tax_regimes", async () => {
        const body = readCompareTaxArgs(args);
        const computed = await computeTax(userId, body);
        const { label, financialYearLabel, startDate, endDate } = computed.assessmentYear;
        return okResult("compare_tax_regimes", {
          assessmentYear: { label, financialYearLabel, startDate, endDate },
          input: computed.input,
          comparison: computed.comparison,
          notice: COMPARISON_NOTICE,
        });
      });
    },

    simulate_tax: async (userId: string, args: unknown): Promise<ToolResult<SimulateTaxResult>> => {
      requireUser(userId);
      return guarded("simulate_tax", async () => {
        const { regime, base, scenario } = readSimulateTaxArgs(args);
        const baseInput = parseTaxRequest(base).input;
        const scenarioInput = parseTaxRequest(scenario).input;
        const baseResult = calculateTax({ ...baseInput, regime });
        const scenarioResult = calculateTax({ ...scenarioInput, regime });
        return okResult("simulate_tax", {
          regime,
          base: { input: baseInput },
          scenario: { input: scenarioInput },
          delta: scenarioDelta(baseResult, scenarioResult),
        });
      });
    },
  };
}

/** The tools, bound to real tax-law retrieval. */
export const assistantTools = createAssistantTools();
