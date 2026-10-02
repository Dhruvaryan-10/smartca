// Display and form logic for the Ledger (income and expenses). Pure: no React, no network. It only filters, groups and totals rows the
// API already returned for the signed-in user, in integer paise, and turns the add/edit form into the exact body the transactions API
// already accepts. The server re-validates everything it receives and stays the authority.
import { parseRupeesToPaise } from "./money-input";

export type LedgerType = "income" | "expense";

export type LedgerTransaction = {
  id: string;
  type: LedgerType;
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string; // YYYY-MM-DD
};

/** Today's date in the person's own time zone (not UTC), as YYYY-MM-DD. */
export function localDateKey(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Newest first; ties keep a stable order by id. */
function byDateDesc(a: LedgerTransaction, b: LedgerTransaction): number {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export type LedgerFilter = { query: string; category: string; month: string };
export const NO_FILTER: LedgerFilter = { query: "", category: "", month: "" };

export function isFiltered(filter: LedgerFilter): boolean {
  return filter.query.trim() !== "" || filter.category !== "" || filter.month !== "";
}

/** Rows of one type that match the filter, newest first. Text matches description or category, ignoring case. */
export function filterLedger(rows: readonly LedgerTransaction[], type: LedgerType, filter: LedgerFilter): LedgerTransaction[] {
  const query = filter.query.trim().toLowerCase();
  return rows
    .filter((t) => t.type === type)
    .filter((t) => !filter.category || t.category === filter.category)
    .filter((t) => !filter.month || t.occurredOn.slice(0, 7) === filter.month)
    .filter((t) => !query || t.category.toLowerCase().includes(query) || (t.description ?? "").toLowerCase().includes(query))
    .sort(byDateDesc);
}

export type MonthGroup = { key: string; totalPaise: number; rows: LedgerTransaction[] };

/** Consecutive rows grouped by calendar month (rows must already be newest first). */
export function groupByMonth(rows: readonly LedgerTransaction[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const row of rows) {
    const key = row.occurredOn.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.rows.push(row);
      last.totalPaise += row.amountPaise;
    } else {
      groups.push({ key, totalPaise: row.amountPaise, rows: [row] });
    }
  }
  return groups;
}

export type LedgerStats = {
  count: number;
  totalPaise: number;
  /** YYYY-MM of `today`. */
  monthKey: string;
  monthPaise: number;
  monthCount: number;
  topCategory: { category: string; totalPaise: number } | null;
};

export function ledgerStats(rows: readonly LedgerTransaction[], type: LedgerType, today: string): LedgerStats {
  const monthKey = today.slice(0, 7);
  const ofType = rows.filter((t) => t.type === type);
  const byCategory = new Map<string, number>();
  let totalPaise = 0;
  let monthPaise = 0;
  let monthCount = 0;
  for (const t of ofType) {
    totalPaise += t.amountPaise;
    byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.amountPaise);
    if (t.occurredOn.slice(0, 7) === monthKey) {
      monthPaise += t.amountPaise;
      monthCount += 1;
    }
  }
  let topCategory: LedgerStats["topCategory"] = null;
  for (const [category, paise] of byCategory) {
    if (!topCategory || paise > topCategory.totalPaise || (paise === topCategory.totalPaise && category < topCategory.category)) {
      topCategory = { category, totalPaise: paise };
    }
  }
  return { count: ofType.length, totalPaise, monthKey, monthPaise, monthCount, topCategory };
}

/** Categories already used for this type, most used first, then the defaults not yet used. */
export function categorySuggestions(rows: readonly LedgerTransaction[], type: LedgerType, defaults: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const t of rows) if (t.type === type) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c);
  return [...used, ...defaults.filter((d) => !counts.has(d))];
}

/** Months present for this type, newest first, as YYYY-MM. */
export function monthsPresent(rows: readonly LedgerTransaction[], type: LedgerType): string[] {
  return [...new Set(rows.filter((t) => t.type === type).map((t) => t.occurredOn.slice(0, 7)))].sort().reverse();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------------------------------------------------------------

export type TransactionFormValues = { amount: string; occurredOn: string; category: string; description: string };
export type TransactionFormErrors = Partial<Record<keyof TransactionFormValues, string>>;

/** The body POST /api/transactions and PATCH /api/transactions/[id] accept: the same fields the ledger always sent. */
export type TransactionBody = {
  type: LedgerType;
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string;
};

export function parseTransactionForm(
  values: TransactionFormValues,
  type: LedgerType,
): { ok: true; body: TransactionBody } | { ok: false; errors: TransactionFormErrors } {
  const errors: TransactionFormErrors = {};
  const amount = parseRupeesToPaise(values.amount);
  if (!amount.ok) errors.amount = amount.message;
  else if (amount.paise === 0) errors.amount = "Enter an amount greater than zero.";
  if (!isDate(values.occurredOn)) errors.occurredOn = "Choose the date.";
  const category = values.category.trim();
  if (!category) errors.category = "Enter a category.";
  if (Object.keys(errors).length > 0 || !amount.ok) return { ok: false, errors };
  const description = values.description.trim();
  return {
    ok: true,
    body: { type, amountPaise: amount.paise, category, description: description === "" ? null : description, occurredOn: values.occurredOn },
  };
}
