// Tax computation service: the server-side boundary between an authenticated
// request and the deterministic tax engine.
//
//   authenticated user -> validated request -> THIS SERVICE -> tax engine
//     -> trusted result -> (optional, explicit) persistence
//
// Rules this file enforces:
//   - The client sends INPUTS only. Everything else the client might claim
//     (user id, assessment-year row id, engine or rules version, a result, a
//     tree, a regime) is ignored: request parsing reads a fixed allow-list
//     of fields and nothing else.
//   - Every amount is validated as an exact integer number of paise.
//   - Results are computed here, from those inputs, by the engine. Only an
//     engine-produced result is ever persisted, and only on an explicit save.
//   - Every read and write is scoped to the explicit `userId`, which callers
//     must obtain from the server-verified session (services/session.ts).
//   - Nothing here does tax arithmetic. Totals, shares and differences come
//     from the engine; the ledger suggestion is a plain sum for display and
//     is never fed into a computation.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { assessmentYears } from "@/db/schema";
import { MAX_MONEY_PAISE } from "@/lib/money-input";
import {
  compareRegimes,
  comparisonNumbers,
  getSupportedAssessmentYearLabels,
  UnsupportedAssessmentYearError,
} from "@/tax-engine";
import type {
  AgeCategory,
  ComparisonInput,
  ComparisonNumbers,
  DeductionInput,
  IncomeSource,
  RegimeComparison,
  TaxResult,
} from "@/tax-engine";
import { NotAuthenticatedError, ValidationError } from "./errors";
import { removeDeductionForSection, upsertDeduction } from "./deductions";
import { listTaxComputationsForYear, saveTaxComputationRun } from "./tax-computations";
import { listTransactions } from "./transactions";

// ---------------------------------------------------------------------
// Response types (imported by the client with `import type` only)
// ---------------------------------------------------------------------

export type AssessmentYearInfo = {
  /** e.g. "2026-27" */
  label: string;
  /** The income year it taxes, e.g. "2025-26". */
  financialYearLabel: string;
  /** First and last day of the financial year (YYYY-MM-DD). */
  startDate: string;
  endDate: string;
};

export type TaxComputeResponse = {
  assessmentYear: AssessmentYearInfo;
  /** The server-validated input the engine ran on. */
  input: ComparisonInput;
  comparison: RegimeComparison;
};

export type SavedRunSummary = {
  runId: string;
  /** ISO timestamp. */
  savedAt: string;
  regimes: Array<"old" | "new">;
};

export type TaxSaveResponse = TaxComputeResponse & { saved: SavedRunSummary };

/** A stored computation, exactly as it was saved. Never recomputed for display. */
export type SavedTaxRun = {
  runId: string;
  savedAt: string;
  input: ComparisonInput;
  results: { old: TaxResult | null; new: TaxResult | null };
  /** Built from the STORED totals by the engine's own helper; null unless both regimes were saved. */
  numbers: ComparisonNumbers | null;
};

export type LedgerIncomeSuggestion = {
  fromDate: string;
  toDate: string;
  transactionCount: number;
  incomeTotalPaise: number;
  /** Largest first. */
  categories: Array<{ category: string; totalPaise: number }>;
};

export type TaxWorkspace = {
  assessmentYear: AssessmentYearInfo;
  supportedAssessmentYears: string[];
  /**
   * Income the user recorded in the ledger for this financial year. A
   * SUGGESTION only: ledger categories are not tax classifications and this
   * is never used by a computation.
   */
  ledgerSuggestion: LedgerIncomeSuggestion | null;
  /** Most recent first, at most MAX_SAVED_RUNS. */
  savedRuns: SavedTaxRun[];
};

const MAX_SAVED_RUNS = 5;

// ---------------------------------------------------------------------
// Request parsing (pure)
// ---------------------------------------------------------------------

export type ParsedTaxRequest = {
  assessmentYear: string;
  input: ComparisonInput;
};

const AGE_CATEGORIES: AgeCategory[] = ["below60", "senior", "superSenior"];
const ASSESSMENT_YEAR_SHAPE = /^\d{4}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Optional exact-paise field: absent means 0. */
function readPaise(container: Record<string, unknown>, key: string, where: string): number {
  const value = container[key];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY_PAISE) {
    throw new ValidationError(`${where}.${key} must be a whole number of paise between 0 and ${MAX_MONEY_PAISE}.`);
  }
  return value;
}

function readFlag(container: Record<string, unknown>, key: string, where: string): boolean {
  const value = container[key];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new ValidationError(`${where}.${key} must be true or false.`);
  return value;
}

function readSection(container: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = container[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new ValidationError(`${key} must be an object.`);
  return value;
}

/**
 * Turn an untrusted request body into engine input. Reads only the fields
 * below; any other field, including anything that looks like a user id,
 * assessment-year id, version, result or regime, is dropped.
 */
export function parseTaxRequest(body: unknown): ParsedTaxRequest {
  if (!isPlainObject(body)) throw new ValidationError("The request body must be a JSON object.");

  const assessmentYear = body.assessmentYear;
  if (typeof assessmentYear !== "string" || !ASSESSMENT_YEAR_SHAPE.test(assessmentYear)) {
    throw new ValidationError('assessmentYear is required, for example "2026-27".');
  }
  if (!getSupportedAssessmentYearLabels().includes(assessmentYear)) {
    throw new UnsupportedAssessmentYearError(assessmentYear);
  }

  const ageCategory = body.ageCategory;
  if (typeof ageCategory !== "string" || !AGE_CATEGORIES.includes(ageCategory as AgeCategory)) {
    throw new ValidationError(`ageCategory must be one of ${AGE_CATEGORIES.join(", ")}.`);
  }

  const income = readSection(body, "income");
  if (!income) throw new ValidationError("income is required.");
  const incomeSources: IncomeSource[] = [];
  const salaryPaise = readPaise(income, "salaryPaise", "income");
  const businessPaise = readPaise(income, "businessPaise", "income");
  const otherPaise = readPaise(income, "otherPaise", "income");
  if (salaryPaise > 0) incomeSources.push({ kind: "salary", label: "Salary", amountPaise: salaryPaise });
  if (businessPaise > 0) incomeSources.push({ kind: "business", label: "Business or professional income", amountPaise: businessPaise });
  if (otherPaise > 0) incomeSources.push({ kind: "other", label: "Other income", amountPaise: otherPaise });
  if (incomeSources.length === 0) throw new ValidationError("Enter at least one income amount above zero.");

  const deductions: DeductionInput[] = [];
  const declared = readSection(body, "deductions");
  if (declared) {
    const section80CPaise = readPaise(declared, "section80CPaise", "deductions");
    if (section80CPaise > 0) deductions.push({ section: "80C", amountPaise: section80CPaise });

    const health = readSection(declared, "healthInsurance");
    if (health) {
      const selfFamilyPaise = readPaise(health, "selfFamilyPaise", "deductions.healthInsurance");
      const parentsPaise = readPaise(health, "parentsPaise", "deductions.healthInsurance");
      const spouseIsSenior = readFlag(health, "spouseIsSenior", "deductions.healthInsurance");
      const anyParentIsSenior = readFlag(health, "anyParentIsSenior", "deductions.healthInsurance");
      if (selfFamilyPaise > 0 || parentsPaise > 0) {
        deductions.push({ section: "80D", selfFamilyPaise, parentsPaise, spouseIsSenior, anyParentIsSenior });
      }
    }
  }

  return {
    assessmentYear,
    input: { assessmentYearLabel: assessmentYear, ageCategory: ageCategory as AgeCategory, incomeSources, deductions },
  };
}

// ---------------------------------------------------------------------
// Assessment years
// ---------------------------------------------------------------------

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || !userId.trim()) throw new NotAuthenticatedError();
  return userId;
}

type AssessmentYearRow = typeof assessmentYears.$inferSelect;

/**
 * Resolve an assessment year by label on the server. The engine's rule
 * registry decides what can be computed; this row supplies the dates and the
 * foreign key for persistence. If the registry knows a year the database
 * does not (for example the seed was not run) it is reported as unsupported
 * rather than guessed at.
 */
async function loadAssessmentYear(label: string): Promise<AssessmentYearRow> {
  const [row] = await db.select().from(assessmentYears).where(eq(assessmentYears.label, label));
  if (!row) throw new UnsupportedAssessmentYearError(label);
  return row;
}

function describeAssessmentYear(row: AssessmentYearRow): AssessmentYearInfo {
  return {
    label: row.label,
    financialYearLabel: `${row.startDate.slice(0, 4)}-${row.endDate.slice(2, 4)}`,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

// ---------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------

async function prepare(userId: string, body: unknown) {
  requireUserId(userId);
  const { assessmentYear, input } = parseTaxRequest(body);
  const year = await loadAssessmentYear(assessmentYear);
  const comparison = compareRegimes(input);
  const response: TaxComputeResponse = { assessmentYear: describeAssessmentYear(year), input, comparison };
  return { year, response };
}

/**
 * Run the deterministic engine, for both regimes, on the posted input.
 * Stateless: nothing is stored.
 */
export async function computeTax(userId: string, body: unknown): Promise<TaxComputeResponse> {
  return (await prepare(userId, body)).response;
}

// ---------------------------------------------------------------------
// Save (explicit)
// ---------------------------------------------------------------------

function declaredAmountFor(input: ComparisonInput, section: "80C" | "80D"): number {
  const deduction = input.deductions.find((d) => d.section === section);
  if (!deduction) return 0;
  return deduction.section === "80C" ? deduction.amountPaise : deduction.selfFamilyPaise + deduction.parentsPaise;
}

/**
 * Compute on the server, then persist the engine's own result for each
 * regime that produced one, plus the user's declared deductions for the
 * year. Nothing the client says about results is read.
 */
export async function saveTaxComputation(userId: string, body: unknown): Promise<TaxSaveResponse> {
  const { year, response } = await prepare(userId, body);

  const results: TaxResult[] = [];
  if (response.comparison.old.status === "ok") results.push(response.comparison.old.result);
  if (response.comparison.new.status === "ok") results.push(response.comparison.new.result);
  if (results.length === 0) {
    throw new ValidationError("Nothing to save: neither regime produced a result.");
  }

  const runId = randomUUID();
  const rows = await db.transaction(async (tx) => {
    const saved = await saveTaxComputationRun(
      userId,
      { assessmentYearId: year.id, runId, input: response.input, results },
      tx,
    );
    // The declared deductions for this year mirror what was just saved:
    // present sections are updated in place, withdrawn ones are removed.
    for (const section of ["80C", "80D"] as const) {
      const amountPaise = declaredAmountFor(response.input, section);
      if (amountPaise > 0) {
        await upsertDeduction(userId, { assessmentYearId: year.id, section, amountPaise }, tx);
      } else {
        await removeDeductionForSection(userId, year.id, section, tx);
      }
    }
    return saved;
  });

  return {
    ...response,
    saved: { runId, savedAt: rows[0].createdAt.toISOString(), regimes: results.map((r) => r.regime) },
  };
}

// ---------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------

type StoredComputation = { runId: string; input: ComparisonInput; result: TaxResult };

/** Read a stored row back. Anything that isn't the shape this code writes is skipped, not trusted. */
function readStoredComputation(data: unknown): StoredComputation | null {
  if (!isPlainObject(data) || data.schemaVersion !== 1) return null;
  if (typeof data.runId !== "string" || !isPlainObject(data.input) || !isPlainObject(data.result)) return null;
  const regime = data.result.regime;
  if (regime !== "old" && regime !== "new") return null;
  return { runId: data.runId, input: data.input as unknown as ComparisonInput, result: data.result as unknown as TaxResult };
}

async function loadSavedRuns(userId: string, assessmentYearId: string): Promise<SavedTaxRun[]> {
  const rows = await listTaxComputationsForYear(userId, assessmentYearId); // newest first
  const runs = new Map<string, SavedTaxRun>();

  for (const row of rows) {
    const stored = readStoredComputation(row.computationData);
    if (!stored) continue;
    let run = runs.get(stored.runId);
    if (!run) {
      run = {
        runId: stored.runId,
        savedAt: row.createdAt.toISOString(),
        input: stored.input,
        results: { old: null, new: null },
        numbers: null,
      };
      runs.set(stored.runId, run);
    }
    run.results[stored.result.regime] = stored.result;
  }

  const recent = [...runs.values()].slice(0, MAX_SAVED_RUNS);
  for (const run of recent) run.numbers = comparisonNumbers(run.results.old, run.results.new);
  return recent;
}

async function loadLedgerSuggestion(userId: string, year: AssessmentYearRow): Promise<LedgerIncomeSuggestion | null> {
  const transactions = await listTransactions(userId);
  const incomeInYear = transactions.filter(
    (t) => t.type === "income" && t.occurredOn >= year.startDate && t.occurredOn <= year.endDate,
  );
  if (incomeInYear.length === 0) return null;

  const totals = new Map<string, number>();
  let incomeTotalPaise = 0;
  for (const t of incomeInYear) {
    incomeTotalPaise += t.amountPaise;
    totals.set(t.category, (totals.get(t.category) ?? 0) + t.amountPaise);
  }
  const categories = [...totals.entries()]
    .map(([category, totalPaise]) => ({ category, totalPaise }))
    .sort((a, b) => b.totalPaise - a.totalPaise || a.category.localeCompare(b.category));

  return {
    fromDate: year.startDate,
    toDate: year.endDate,
    transactionCount: incomeInYear.length,
    incomeTotalPaise,
    categories,
  };
}

/**
 * Everything the Tax page needs to render: the supported assessment year, a
 * ledger suggestion for that year, and the user's own saved computations.
 * Defaults to the newest year the engine supports.
 */
export async function getTaxWorkspace(userId: string, requestedLabel?: string): Promise<TaxWorkspace> {
  requireUserId(userId);

  const supported = getSupportedAssessmentYearLabels();
  const label = requestedLabel ?? [...supported].sort().at(-1);
  if (!label || !supported.includes(label)) throw new UnsupportedAssessmentYearError(label ?? "");

  const year = await loadAssessmentYear(label);
  const [savedRuns, ledgerSuggestion] = await Promise.all([
    loadSavedRuns(userId, year.id),
    loadLedgerSuggestion(userId, year),
  ]);

  return {
    assessmentYear: describeAssessmentYear(year),
    supportedAssessmentYears: supported,
    ledgerSuggestion,
    savedRuns,
  };
}
