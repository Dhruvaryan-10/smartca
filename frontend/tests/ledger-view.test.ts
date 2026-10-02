// Ledger display and form logic. Pure — no database, session, or network. Expected values are written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_FILTER,
  categorySuggestions,
  filterLedger,
  groupByMonth,
  isFiltered,
  ledgerStats,
  localDateKey,
  monthsPresent,
  parseTransactionForm,
  type LedgerTransaction,
} from "../lib/ledger-view";

const rupees = (r: number) => r * 100;
const t = (id: string, type: "income" | "expense", r: number, category: string, occurredOn: string, description: string | null = null): LedgerTransaction => ({
  id,
  type,
  amountPaise: rupees(r),
  category,
  description,
  occurredOn,
});

const ROWS = [
  t("1", "income", 85_000, "Salary", "2026-08-01"),
  t("2", "expense", 22_000, "Rent", "2026-08-03"),
  t("3", "expense", 640, "Groceries", "2026-09-09", "BigBasket order"),
  t("4", "income", 85_000, "Salary", "2026-09-01"),
  t("5", "expense", 22_000, "Rent", "2026-09-03"),
  t("6", "income", 12_000, "Freelance", "2026-09-20", "Logo design"),
];

test("localDateKey uses the local calendar date", () => {
  assert.equal(localDateKey(new Date(2026, 0, 5, 0, 30)), "2026-01-05");
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});

test("filterLedger keeps one type, newest first", () => {
  assert.deepEqual(filterLedger(ROWS, "income", NO_FILTER).map((r) => r.id), ["6", "4", "1"]);
  assert.deepEqual(filterLedger(ROWS, "expense", NO_FILTER).map((r) => r.id), ["3", "5", "2"]);
});

test("filterLedger matches text in description or category, ignoring case, plus category and month", () => {
  assert.deepEqual(filterLedger(ROWS, "expense", { ...NO_FILTER, query: "bigbasket" }).map((r) => r.id), ["3"]);
  assert.deepEqual(filterLedger(ROWS, "expense", { ...NO_FILTER, query: "RENT" }).map((r) => r.id), ["5", "2"]);
  assert.deepEqual(filterLedger(ROWS, "income", { ...NO_FILTER, category: "Salary" }).map((r) => r.id), ["4", "1"]);
  assert.deepEqual(filterLedger(ROWS, "income", { ...NO_FILTER, month: "2026-08" }).map((r) => r.id), ["1"]);
  assert.equal(isFiltered(NO_FILTER), false);
  assert.equal(isFiltered({ ...NO_FILTER, query: "  " }), false);
  assert.equal(isFiltered({ ...NO_FILTER, month: "2026-08" }), true);
});

test("groupByMonth groups consecutive rows and totals each month", () => {
  const groups = groupByMonth(filterLedger(ROWS, "income", NO_FILTER));
  assert.deepEqual(
    groups.map((g) => [g.key, g.totalPaise, g.rows.length]),
    [
      ["2026-09", rupees(97_000), 2],
      ["2026-08", rupees(85_000), 1],
    ],
  );
});

test("ledgerStats totals one type, this month and the largest category", () => {
  assert.deepEqual(ledgerStats(ROWS, "expense", "2026-09-25"), {
    count: 3,
    totalPaise: rupees(44_640),
    monthKey: "2026-09",
    monthPaise: rupees(22_640),
    monthCount: 2,
    topCategory: { category: "Rent", totalPaise: rupees(44_000) },
  });
  assert.equal(ledgerStats([], "income", "2026-09-25").topCategory, null);
});

test("category suggestions put used categories first, then unused defaults", () => {
  assert.deepEqual(categorySuggestions(ROWS, "income", ["Salary", "Bonus"]), ["Salary", "Freelance", "Bonus"]);
});

test("monthsPresent lists months for one type, newest first", () => {
  assert.deepEqual(monthsPresent(ROWS, "expense"), ["2026-09", "2026-08"]);
});

test("parseTransactionForm builds the same body the ledger has always sent", () => {
  assert.deepEqual(
    parseTransactionForm({ amount: "1,250.50", occurredOn: "2026-09-04", category: " Food ", description: "  " }, "expense"),
    { ok: true, body: { type: "expense", amountPaise: 125_050, category: "Food", description: null, occurredOn: "2026-09-04" } },
  );
});

test("parseTransactionForm explains each problem", () => {
  const result = parseTransactionForm({ amount: "0", occurredOn: "", category: "", description: "" }, "income");
  assert.ok(!result.ok);
  assert.equal(result.errors.amount, "Enter an amount greater than zero.");
  assert.equal(result.errors.occurredOn, "Choose the date.");
  assert.equal(result.errors.category, "Enter a category.");
  const malformed = parseTransactionForm({ amount: "12.345", occurredOn: "2026-09-04", category: "Food", description: "" }, "expense");
  assert.ok(!malformed.ok && malformed.errors.amount === "Use at most two decimal places.");
});
