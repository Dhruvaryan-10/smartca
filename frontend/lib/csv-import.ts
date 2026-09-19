// CSV import logic: turning parsed CSV records into validated transactions.
//
// Principles, all enforced here and pinned by tests/csv-import.test.ts:
//   - Amounts are exact integer paise. Nothing goes through floating point.
//   - Nothing is guessed. How amounts map to income and expense, the date
//     format, and the default category are explicit choices in the mapping;
//     a mapping that leaves any of them open is rejected, not defaulted.
//   - Every row is validated. One bad row means the file is not importable,
//     and every bad row is reported with its line number.
//   - Duplicate detection is a deterministic fingerprint, with an occurrence
//     index so identical-looking rows within one file stay separate.
//
// Pure: no I/O, no database, no framework. Money parsing reuses
// lib/money-input.ts and dates reuse lib/date-parse.ts.
import { createHash } from "node:crypto";
import { DATE_FORMATS, parseDateWithFormat } from "./date-parse";
import type { DateFormatId } from "./date-parse";
import type { CsvDelimiter, CsvRecord } from "./csv";
import { parseRupeesToPaise } from "./money-input";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type AmountMode = "signed" | "debit_credit" | "amount_with_type";
export type SignedConvention = "positive_is_income" | "positive_is_expense";
export type ColumnRole = "date" | "description" | "category" | "amount" | "debit" | "credit" | "type";
export type ColumnIndexes = Record<ColumnRole, number | null>;

export type CsvMapping = {
  delimiter: CsvDelimiter;
  dateFormat: DateFormatId;
  amountMode: AmountMode;
  /** Required when amountMode is "signed". */
  signedConvention?: SignedConvention;
  /** Zero-based column indexes; null = not mapped. */
  columns: ColumnIndexes;
  /** Used for any row without a usable category. Shown to, and chosen by, the user. */
  defaultCategory: string;
};

export type ParsedRow = {
  /** Physical line in the file. */
  line: number;
  occurredOn: string;
  type: "income" | "expense";
  amountPaise: number;
  description: string | null;
  category: string;
  usedDefaultCategory: boolean;
};

export type RowError = { line: number; message: string; column?: string };

export type ValidationResult = {
  rows: ParsedRow[];
  /** At most MAX_REPORTED_ERRORS; `errorCount` is the true total. */
  errors: RowError[];
  errorCount: number;
  dataRowCount: number;
};

export const DEFAULT_CATEGORY = "Uncategorized";
export const MAX_REPORTED_ERRORS = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 100;

const DELIMITERS: CsvDelimiter[] = [",", ";", "\t", "|"];
const AMOUNT_MODES: AmountMode[] = ["signed", "debit_credit", "amount_with_type"];
const CONVENTIONS: SignedConvention[] = ["positive_is_income", "positive_is_expense"];
const ROLES: ColumnRole[] = ["date", "description", "category", "amount", "debit", "credit", "type"];

// Roles that apply to each amount layout. Others are ignored.
const ROLES_BY_MODE: Record<AmountMode, ColumnRole[]> = {
  signed: ["date", "description", "category", "amount"],
  debit_credit: ["date", "description", "category", "debit", "credit"],
  amount_with_type: ["date", "description", "category", "amount", "type"],
};

const ROLE_LABEL: Record<ColumnRole, string> = {
  date: "date",
  description: "description",
  category: "category",
  amount: "amount",
  debit: "debit",
  credit: "credit",
  type: "type",
};

// ---------------------------------------------------------------------
// Mapping validation
// ---------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validate a mapping received from the client. Returns a normalised copy
 * (only known fields, only the columns relevant to the chosen layout) or the
 * list of problems that block the import.
 */
export function validateMapping(
  input: unknown,
  headerCount: number,
): { ok: true; mapping: CsvMapping } | { ok: false; problems: string[] } {
  if (!isPlainObject(input)) return { ok: false, problems: ["The column mapping is missing."] };

  const problems: string[] = [];

  const delimiter = input.delimiter as CsvDelimiter;
  if (!DELIMITERS.includes(delimiter)) problems.push("Choose the delimiter that separates the columns.");

  const dateFormat = input.dateFormat as DateFormatId;
  if (!DATE_FORMATS.some((f) => f.id === dateFormat)) problems.push("Choose the date format used in the file.");

  const amountMode = input.amountMode as AmountMode;
  const modeOk = AMOUNT_MODES.includes(amountMode);
  if (!modeOk) problems.push("Choose how amounts are laid out (one signed amount, debit and credit columns, or amount plus type).");

  const signedConvention = input.signedConvention as SignedConvention | undefined;
  if (modeOk && amountMode === "signed" && !CONVENTIONS.includes(signedConvention as SignedConvention)) {
    problems.push("Say whether a positive amount is income or an expense.");
  }

  const defaultCategory = typeof input.defaultCategory === "string" ? input.defaultCategory.trim() : "";
  if (defaultCategory === "") problems.push("Choose a default category for rows without one.");
  else if (defaultCategory.length > MAX_CATEGORY_LENGTH) problems.push(`The default category must be at most ${MAX_CATEGORY_LENGTH} characters.`);

  const columns = {} as ColumnIndexes;
  const rawColumns = isPlainObject(input.columns) ? input.columns : {};
  for (const role of ROLES) columns[role] = null;

  if (modeOk) {
    const used = new Map<number, ColumnRole>();
    for (const role of ROLES_BY_MODE[amountMode]) {
      const value = rawColumns[role];
      if (value === null || value === undefined) {
        if (role === "description" || role === "category") continue; // optional
        problems.push(`Choose the ${ROLE_LABEL[role]} column.`);
        continue;
      }
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= headerCount) {
        problems.push(`The ${ROLE_LABEL[role]} column is not one of the file's columns.`);
        continue;
      }
      const other = used.get(value);
      if (other) problems.push(`A column can only be used once, but it is chosen for both ${ROLE_LABEL[other]} and ${ROLE_LABEL[role]}.`);
      used.set(value, role);
      columns[role] = value;
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    mapping: {
      delimiter,
      dateFormat,
      amountMode,
      ...(amountMode === "signed" ? { signedConvention } : {}),
      columns,
      defaultCategory,
    },
  };
}

// ---------------------------------------------------------------------
// Suggestions (never applied silently: the UI shows and confirms them)
// ---------------------------------------------------------------------

const HEADER_PATTERNS: Record<Exclude<ColumnRole, never>, RegExp> = {
  type: /^(type|transaction type|txn type|dr\/cr|cr\/dr|debit\/credit|credit\/debit)$/,
  date: /^(txn |transaction |posting |value )?date$/,
  description: /(description|narration|particulars|details|remarks|memo|payee)/,
  category: /^category$/,
  amount: /^((transaction|txn) )?amount( ?\(.*\))?$/,
  debit: /\b(debit|withdrawal|withdrawals|paid out)\b|^dr$/,
  credit: /\b(credit|deposit|deposits|paid in)\b|^cr$/,
};

export type MappingSuggestion = {
  /** Only roles for which exactly one header fits. */
  columns: Partial<Record<ColumnRole, number>>;
  /** Only "debit_credit", and only when both a debit and a credit header were found. */
  amountMode?: AmountMode;
};

export function suggestMapping(headers: string[]): MappingSuggestion {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const claimed = new Set<number>();
  const columns: Partial<Record<ColumnRole, number>> = {};

  // Type is checked first so a "Debit/Credit" marker column is not also read as the debit column.
  for (const role of ["type", "date", "description", "category", "amount", "debit", "credit"] as ColumnRole[]) {
    const matches = normalized.map((h, i) => (HEADER_PATTERNS[role].test(h) && !claimed.has(i) ? i : -1)).filter((i) => i >= 0);
    if (matches.length === 1) {
      columns[role] = matches[0];
      if (role === "type") claimed.add(matches[0]);
    }
  }

  const suggestion: MappingSuggestion = { columns };
  if (columns.debit !== undefined && columns.credit !== undefined) suggestion.amountMode = "debit_credit";
  return suggestion;
}

// ---------------------------------------------------------------------
// Row validation
// ---------------------------------------------------------------------

type AmountCell = { kind: "empty" } | { kind: "amount"; paise: number; negative: boolean } | { kind: "error"; message: string };

const MINUS = "-−";

/** Read one amount cell as exact paise plus its sign. Never rounds, never guesses. */
function readAmount(cell: string): AmountCell {
  let text = cell.trim();
  if (text === "") return { kind: "empty" };

  let negative = false;
  let hadSign = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    hadSign = true;
    text = text.slice(1, -1).trim();
  }

  const leading = text[0];
  if (leading === "+" || (leading !== undefined && MINUS.includes(leading))) {
    if (leading !== "+") negative = true;
    hadSign = true;
    text = text.slice(1).trimStart();
  }
  if (text.startsWith("₹")) {
    text = text.slice(1).trimStart();
    const inner = text[0];
    if (inner === "+" || (inner !== undefined && MINUS.includes(inner))) {
      if (inner !== "+") negative = true;
      hadSign = true;
      text = text.slice(1).trimStart();
    }
  }

  const parsed = parseRupeesToPaise(text);
  if (!parsed.ok) {
    if (parsed.reason === "too_many_decimals" || parsed.reason === "too_large") return { kind: "error", message: parsed.message };
    // A bare sign, a stray second sign, letters: all just "not an amount".
    return { kind: "error", message: hadSign && parsed.reason === "empty" ? "Not a valid amount." : "Not a valid amount." };
  }
  return { kind: "amount", paise: parsed.paise, negative };
}

const INCOME_WORDS = new Set(["income", "credit", "cr"]);
const EXPENSE_WORDS = new Set(["expense", "debit", "dr"]);

/**
 * Validate every data row against the mapping. The first record is the
 * header. Rows with any problem are left out of `rows` and described in
 * `errors`; a caller must treat any error as "do not import".
 */
export function validateCsvRows(records: CsvRecord[], mapping: CsvMapping): ValidationResult {
  const errors: RowError[] = [];
  let errorCount = 0;
  const rows: ParsedRow[] = [];

  if (records.length === 0) return { rows, errors, errorCount, dataRowCount: 0 };

  const header = records[0].fields;
  const headerCount = header.length;
  const headerName = (index: number | null, fallback: string) =>
    index !== null && header[index]?.trim() ? header[index].trim() : fallback;
  const c = mapping.columns;

  const dataRecords = records.slice(1);

  for (const record of dataRecords) {
    const rowErrors: RowError[] = [];
    const fail = (message: string, column?: string) => rowErrors.push({ line: record.line, message, ...(column ? { column } : {}) });
    const cell = (index: number | null) => (index === null ? "" : (record.fields[index] ?? ""));

    if (record.fields.length !== headerCount) {
      fail(`Expected ${headerCount} columns but found ${record.fields.length}.`);
    } else {
      // Date
      const dateName = headerName(c.date, "Date");
      const dateText = cell(c.date).trim();
      let occurredOn = "";
      if (dateText === "") fail("The date is empty.", dateName);
      else {
        const parsed = parseDateWithFormat(dateText, mapping.dateFormat);
        if (parsed.ok) occurredOn = parsed.iso;
        else fail(parsed.message, dateName);
      }

      // Amount and type
      let type: "income" | "expense" | null = null;
      let amountPaise = 0;

      if (mapping.amountMode === "signed") {
        const name = headerName(c.amount, "Amount");
        const amount = readAmount(cell(c.amount));
        if (amount.kind === "empty") fail("The amount is empty.", name);
        else if (amount.kind === "error") fail(amount.message, name);
        else if (amount.paise === 0) fail("The amount must not be zero.", name);
        else {
          amountPaise = amount.paise;
          const positiveIsIncome = mapping.signedConvention === "positive_is_income";
          type = amount.negative === positiveIsIncome ? "expense" : "income";
        }
      } else if (mapping.amountMode === "debit_credit") {
        const debitName = headerName(c.debit, "Debit");
        const creditName = headerName(c.credit, "Credit");
        const debit = readAmount(cell(c.debit));
        const credit = readAmount(cell(c.credit));
        const problem = (a: AmountCell, name: string) => {
          if (a.kind === "error") {
            fail(a.message, name);
            return true;
          }
          if (a.kind === "amount" && a.negative) {
            fail("Debit and credit amounts must not be negative.", name);
            return true;
          }
          return false;
        };
        const bad = [problem(debit, debitName), problem(credit, creditName)].some(Boolean);
        if (!bad) {
          const debitPaise = debit.kind === "amount" ? debit.paise : 0;
          const creditPaise = credit.kind === "amount" ? credit.paise : 0;
          if (debitPaise > 0 && creditPaise > 0) fail("Both the debit and the credit column have an amount.");
          else if (debitPaise === 0 && creditPaise === 0) fail("Neither the debit nor the credit column has an amount.");
          else {
            type = debitPaise > 0 ? "expense" : "income";
            amountPaise = debitPaise > 0 ? debitPaise : creditPaise;
          }
        }
      } else {
        const amountName = headerName(c.amount, "Amount");
        const typeName = headerName(c.type, "Type");
        const amount = readAmount(cell(c.amount));
        const word = cell(c.type).trim().toLowerCase();
        let amountOk = false;
        if (amount.kind === "empty") fail("The amount is empty.", amountName);
        else if (amount.kind === "error") fail(amount.message, amountName);
        else if (amount.negative) fail("Use an unsigned amount with a type column, or choose the signed-amount layout instead.", amountName);
        else if (amount.paise === 0) fail("The amount must not be zero.", amountName);
        else amountOk = true;

        let resolved: "income" | "expense" | null = null;
        if (INCOME_WORDS.has(word)) resolved = "income";
        else if (EXPENSE_WORDS.has(word)) resolved = "expense";
        else fail(word === "" ? "The type is empty." : "The type isn’t recognised. Use income/credit/cr or expense/debit/dr.", typeName);

        if (amountOk && resolved && amount.kind === "amount") {
          amountPaise = amount.paise;
          type = resolved;
        }
      }

      // Description
      let description: string | null = null;
      if (c.description !== null) {
        const text = cell(c.description).trim();
        if (text.length > MAX_DESCRIPTION_LENGTH) {
          fail(`The description is longer than ${MAX_DESCRIPTION_LENGTH} characters.`, headerName(c.description, "Description"));
        } else if (text !== "") description = text;
      }

      // Category
      let category = mapping.defaultCategory;
      let usedDefaultCategory = true;
      if (c.category !== null) {
        const text = cell(c.category).trim();
        if (text.length > MAX_CATEGORY_LENGTH) {
          fail(`The category is longer than ${MAX_CATEGORY_LENGTH} characters.`, headerName(c.category, "Category"));
        } else if (text !== "") {
          category = text;
          usedDefaultCategory = false;
        }
      }

      if (rowErrors.length === 0 && type !== null) {
        rows.push({ line: record.line, occurredOn, type, amountPaise, description, category, usedDefaultCategory });
      }
    }

    errorCount += rowErrors.length;
    for (const error of rowErrors) {
      if (errors.length < MAX_REPORTED_ERRORS) errors.push(error);
    }
  }

  return { rows, errors, errorCount, dataRowCount: dataRecords.length };
}

// ---------------------------------------------------------------------
// Summary and duplicate fingerprints
// ---------------------------------------------------------------------

export type RowSummary = {
  rowCount: number;
  incomeCount: number;
  expenseCount: number;
  incomeTotalPaise: number;
  expenseTotalPaise: number;
  defaultCategoryCount: number;
};

export function summarizeRows(rows: ParsedRow[]): RowSummary {
  const summary: RowSummary = {
    rowCount: rows.length,
    incomeCount: 0,
    expenseCount: 0,
    incomeTotalPaise: 0,
    expenseTotalPaise: 0,
    defaultCategoryCount: 0,
  };
  for (const row of rows) {
    if (row.type === "income") {
      summary.incomeCount++;
      summary.incomeTotalPaise += row.amountPaise;
    } else {
      summary.expenseCount++;
      summary.expenseTotalPaise += row.amountPaise;
    }
    if (row.usedDefaultCategory) summary.defaultCategoryCount++;
  }
  return summary;
}

const normalizeDescription = (description: string | null) => (description ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** What makes two rows "the same transaction" for duplicate detection: date, type, amount and normalised description. */
export function identityKey(row: Pick<ParsedRow, "occurredOn" | "type" | "amountPaise" | "description">): string {
  return [row.occurredOn, row.type, row.amountPaise, normalizeDescription(row.description)].join("|");
}

/**
 * The fingerprint of the `slot`-th (0-based) row with this identity. A slot is
 * an occurrence identity: the first Coffee of the day is slot 0, the second is
 * slot 1. Every fingerprint, whether from a file or from an explicit override
 * (see services/imports.ts), is one of these, so overrides never invent a new
 * kind of identity and the unique index on (user, fingerprint) covers them all.
 */
export function fingerprintForSlot(key: string, slot: number): string {
  return createHash("sha256").update(`csv-v1|${key}|${slot}`).digest("hex");
}

/**
 * Attach a deterministic fingerprint to each row. It hashes the row's
 * date, type, amount and normalised description, plus how many identical
 * rows came before it in the same file. So:
 *   - re-importing the same file yields the same fingerprints, and every row
 *     is recognised as already imported;
 *   - two genuinely identical rows in one file get different fingerprints
 *     and are both kept;
 *   - the category (which the user may pick differently each time) and the
 *     file's layout never change a fingerprint.
 */
export function fingerprintRows(rows: ParsedRow[]): Array<ParsedRow & { fingerprint: string }> {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = identityKey(row);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return { ...row, fingerprint: fingerprintForSlot(key, occurrence) };
  });
}
