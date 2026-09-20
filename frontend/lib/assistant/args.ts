// Argument validation for the assistant tools (services/assistant/tools.ts). PURE: no database, no session, no network.
//
// Every tool takes `(userId, args)`. `userId` comes from the server (the verified session) and is NEVER an argument:
// these validators are strict allow-lists, so `userId`, an executor, or any other field a model might invent is
// rejected by name, not ignored.
//
// Two jobs only:
//   1. Reject unknown fields and enforce size limits.
//   2. Check the shape of the values that are the assistant's own (dates, a category, a limit, a question).
// Tax VALUES (amounts, age category, year) are deliberately not validated here: the tools hand the body to the
// existing parseTaxRequest, so tax input rules live in one place. This file only allow-lists which fields may appear.
import { parseIsoDate } from "../date-parse";

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

// Hard limits. A tool never returns or processes more than these, whatever it is asked.
/** Tighter than retrieval's own limit: a tax-LAW question is short, and a long one is where personal detail gets in. */
export const MAX_QUESTION_CHARS = 300;
/** A law question needs a few figures (a section, a year, a threshold). More than this reads as someone's own numbers. */
export const MAX_QUESTION_FIGURES = 8;
export const MAX_SECTION_REF_CHARS = 20;
export const MAX_CATEGORY_CHARS = 100;
/** Caps on the free text a ledger tool RETURNS (the category cap above applies to what it returns as well as to the filter). */
export const MAX_LEDGER_DESCRIPTION_CHARS = 200;
export const MAX_LEDGER_SOURCE_CHARS = 50;
/** The longest explicit summary period, in days, both ends counted. Also the most a default period can cover. */
export const MAX_SUMMARY_RANGE_DAYS = 366;
const SUMMARY_DEFAULT_MONTHS = 12;
export const DEFAULT_TRANSACTION_LIMIT = 20;
export const MAX_TRANSACTION_LIMIT = 50;
/** More matches than this are refused, not truncated: a total over a silently cut set would be wrong. */
export const MAX_MATCHED_TRANSACTIONS = 5000;
export const MAX_EVIDENCE_RETURNED = 5;

const ASSESSMENT_YEAR_SHAPE = /^\d{4}-\d{2}$/;
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function objectOf(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ToolArgumentError(`${where} must be an object.`);
  return value;
}

/**
 * A name a caller chose, made safe to put in an error message: printable ASCII only (a newline cannot forge a log line) and at
 * most 40 characters (a model can send a field name as long as its whole argument text). The full name is never echoed.
 */
export function shown(name: string): string {
  const printable = name.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > 40 ? `${printable.slice(0, 40)}…` : printable;
}

/** Rejects any field not on the allow-list, naming it (clipped: see `shown`). */
function onlyFields(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ToolArgumentError(`${where}: the field "${shown(key)}" is not accepted.`);
  }
}

function optionalDate(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined) return null;
  const iso = typeof value === "string" ? parseIsoDate(value) : null;
  if (iso === null) throw new ToolArgumentError(`${key} must be a real date written YYYY-MM-DD.`);
  return iso;
}

function optionalText(record: Record<string, unknown>, key: string, max: number): string | null {
  const value = record[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > max) {
    throw new ToolArgumentError(`${key} must be text of 1 to ${max} characters.`);
  }
  return value.trim();
}

// ---------------------------------------------------------------------
// search_tax_law
// ---------------------------------------------------------------------

// STRUCTURAL limits, not a PII detector: shapes no tax-law question needs. A personal detail can still be phrased around
// them; this only stops the obvious ones (an email, a PAN-shaped code, a long account or phone number, a pile of figures).
const EMAIL_LIKE = /@/;
const PAN_SHAPE = /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/;
const LONG_NUMBER = /\d{9,}/;
const FIGURE = /\d+(?:[.,]\d+)*/g;

function carriesPersonalDetail(question: string): boolean {
  return EMAIL_LIKE.test(question) || PAN_SHAPE.test(question) || LONG_NUMBER.test(question) || (question.match(FIGURE)?.length ?? 0) > MAX_QUESTION_FIGURES;
}

export type SearchTaxLawArgs = { question: string; assessmentYear: string; sectionRef?: string };

export function readSearchTaxLawArgs(args: unknown): SearchTaxLawArgs {
  const record = objectOf(args, "search_tax_law arguments");
  onlyFields(record, ["question", "assessmentYear", "sectionRef"], "search_tax_law");

  const question = optionalText(record, "question", MAX_QUESTION_CHARS);
  if (question === null) throw new ToolArgumentError("question is required.");
  // The message does not repeat the question: it may be exactly the personal detail being refused.
  if (carriesPersonalDetail(question)) {
    throw new ToolArgumentError("The question looks like it carries personal details (an email address, a PAN-shaped code, a number of 9 or more digits, or many figures). Ask the tax-law question in general terms, and use the other tools for the person's own figures.");
  }
  const assessmentYear = record.assessmentYear;
  if (typeof assessmentYear !== "string" || !ASSESSMENT_YEAR_SHAPE.test(assessmentYear)) {
    throw new ToolArgumentError('assessmentYear is required, for example "2026-27".');
  }
  const sectionRef = optionalText(record, "sectionRef", MAX_SECTION_REF_CHARS);
  return { question, assessmentYear, ...(sectionRef === null ? {} : { sectionRef }) };
}

// ---------------------------------------------------------------------
// query_transactions, get_financial_summary
// ---------------------------------------------------------------------

export type TransactionFilter = { from: string | null; to: string | null; category: string | null; type: "income" | "expense" | null };
export type QueryTransactionsArgs = TransactionFilter & { limit: number; includeDescription: boolean };
export type FinancialSummaryArgs = { from: string | null; to: string | null };

function readPeriod(record: Record<string, unknown>): { from: string | null; to: string | null } {
  const from = optionalDate(record, "from");
  const to = optionalDate(record, "to");
  if (from !== null && to !== null && from > to) throw new ToolArgumentError("from must not be after to.");
  return { from, to };
}

export function readQueryTransactionsArgs(args: unknown): QueryTransactionsArgs {
  const record = objectOf(args, "query_transactions arguments");
  onlyFields(record, ["from", "to", "category", "type", "limit", "includeDescription"], "query_transactions");

  const type = record.type;
  if (type !== undefined && type !== "income" && type !== "expense") throw new ToolArgumentError('type must be "income" or "expense".');
  const limit = record.limit;
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTION_LIMIT)) {
    throw new ToolArgumentError(`limit must be a whole number from 1 to ${MAX_TRANSACTION_LIMIT}.`);
  }
  const includeDescription = record.includeDescription;
  if (includeDescription !== undefined && typeof includeDescription !== "boolean") throw new ToolArgumentError("includeDescription must be true or false.");
  return {
    ...readPeriod(record),
    category: optionalText(record, "category", MAX_CATEGORY_CHARS),
    type: type ?? null,
    limit: limit ?? DEFAULT_TRANSACTION_LIMIT,
    includeDescription: includeDescription ?? false,
  };
}

const dayNumber = (iso: string): number => {
  const [year, month, day] = iso.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

/**
 * Either no period (the tool then applies defaultSummaryPeriod) or BOTH ends, at most MAX_SUMMARY_RANGE_DAYS apart.
 * There is no way to ask for an unbounded summary.
 */
export function readFinancialSummaryArgs(args: unknown): FinancialSummaryArgs {
  const record = objectOf(args, "get_financial_summary arguments");
  onlyFields(record, ["from", "to"], "get_financial_summary");
  const { from, to } = readPeriod(record);
  if ((from === null) !== (to === null)) throw new ToolArgumentError("Give both from and to, or neither.");
  if (from !== null && to !== null && dayNumber(to) - dayNumber(from) + 1 > MAX_SUMMARY_RANGE_DAYS) {
    throw new ToolArgumentError(`The period may span at most ${MAX_SUMMARY_RANGE_DAYS} days.`);
  }
  return { from, to };
}

/** The period used when none is given: the 12 calendar months ending at `latest` (the person's most recent transaction). No clock, no tax-year rule. */
export function defaultSummaryPeriod(latest: string): { from: string; to: string } {
  const [year, month] = latest.split("-").map(Number);
  const index = year * 12 + (month - 1) - (SUMMARY_DEFAULT_MONTHS - 1);
  return { from: `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}-01`, to: latest };
}

// ---------------------------------------------------------------------
// The tax tools: calculate_tax, compare_tax_regimes, simulate_tax
// ---------------------------------------------------------------------

// The fields parseTaxRequest reads, and no others. Values are validated by parseTaxRequest, not here.
const TAX_BODY_FIELDS = ["assessmentYear", "ageCategory", "income", "deductions"] as const;
const INCOME_FIELDS = ["salaryPaise", "businessPaise", "otherPaise"] as const;
const DEDUCTION_FIELDS = ["section80CPaise", "healthInsurance"] as const;
const HEALTH_INSURANCE_FIELDS = ["selfFamilyPaise", "parentsPaise", "spouseIsSenior", "anyParentIsSenior"] as const;

function nested(record: Record<string, unknown>, key: string, allowed: readonly string[], where: string) {
  const inner = record[key];
  // A value that is not an object is left for parseTaxRequest to refuse with its own message.
  if (isPlainObject(inner)) onlyFields(inner, allowed, `${where}.${key}`);
  return inner;
}

/** A tax request body: only the fields parseTaxRequest reads, at every level. */
function readTaxBody(value: unknown, where: string): Record<string, unknown> {
  const body = objectOf(value, where);
  onlyFields(body, TAX_BODY_FIELDS, where);
  nested(body, "income", INCOME_FIELDS, where);
  const declared = nested(body, "deductions", DEDUCTION_FIELDS, where);
  if (isPlainObject(declared)) nested(declared, "healthInsurance", HEALTH_INSURANCE_FIELDS, `${where}.deductions`);
  return body;
}

function readRegime(value: unknown): "old" | "new" {
  if (value !== "old" && value !== "new") throw new ToolArgumentError('regime must be "old" or "new".');
  return value;
}

/** compare_tax_regimes: a tax request body, and nothing else. It has no regime: it runs both. */
export function readCompareTaxArgs(args: unknown): Record<string, unknown> {
  return readTaxBody(args, "compare_tax_regimes");
}

/** calculate_tax: a tax request body plus the regime to run. */
export function readCalculateTaxArgs(args: unknown): { regime: "old" | "new"; body: Record<string, unknown> } {
  const record = objectOf(args, "calculate_tax arguments");
  const { regime, ...rest } = record;
  return { regime: readRegime(regime), body: readTaxBody(rest, "calculate_tax") };
}

/** simulate_tax: the regime, a base request and a scenario request, each a tax request body. */
export function readSimulateTaxArgs(args: unknown): { regime: "old" | "new"; base: Record<string, unknown>; scenario: Record<string, unknown> } {
  const record = objectOf(args, "simulate_tax arguments");
  onlyFields(record, ["regime", "base", "scenario"], "simulate_tax");
  return {
    regime: readRegime(record.regime),
    base: readTaxBody(record.base, "simulate_tax.base"),
    scenario: readTaxBody(record.scenario, "simulate_tax.scenario"),
  };
}
