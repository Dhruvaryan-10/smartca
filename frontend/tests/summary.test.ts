// Summary aggregation tests. Pure — no database, session, or network.
// Expected values are hand-computed from the fixtures below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, type SummaryTransaction } from "../lib/summary";

const rupees = (r: number) => r * 100;

let nextId = 0;
function txn(
  type: "income" | "expense",
  amountRupees: number,
  occurredOn: string,
  category = type === "income" ? "Salary" : "Food",
): SummaryTransaction {
  return { id: `t${nextId++}`, type, amountPaise: rupees(amountRupees), category, description: null, occurredOn };
}

test("empty input gives an empty summary, not zeros dressed up as data", () => {
  const s = summarize([]);
  assert.equal(s.transactionCount, 0);
  assert.equal(s.range, null);
  assert.deepEqual(s.months, []);
  assert.deepEqual(s.categories, []);
  assert.deepEqual(s.recent, []);
  assert.equal(s.savingsRatePercent, null);
});

test("totals and savings are summed in paise", () => {
  const s = summarize([
    txn("income", 1_00_000, "2026-04-01"),
    txn("income", 50_000, "2026-05-01"),
    txn("expense", 30_000, "2026-04-10"),
    txn("expense", 45_000, "2026-05-12"),
  ]);
  assert.equal(s.incomePaise, rupees(1_50_000));
  assert.equal(s.expensePaise, rupees(75_000));
  assert.equal(s.savingsPaise, rupees(75_000));
  assert.equal(s.savingsRatePercent, 50);
  assert.equal(s.transactionCount, 4);
});

test("savings can be negative, and rate is null with no income", () => {
  const overspent = summarize([txn("income", 10_000, "2026-04-01"), txn("expense", 25_000, "2026-04-02")]);
  assert.equal(overspent.savingsPaise, -rupees(15_000));
  assert.equal(overspent.savingsRatePercent, -150);

  const noIncome = summarize([txn("expense", 5_000, "2026-04-02")]);
  assert.equal(noIncome.savingsRatePercent, null);
});

test("months are contiguous from first to last activity, including quiet ones", () => {
  const s = summarize([txn("income", 100, "2026-01-15"), txn("expense", 40, "2026-04-02")]);
  assert.deepEqual(
    s.months.map((m) => m.key),
    ["2026-01", "2026-02", "2026-03", "2026-04"],
  );
  assert.equal(s.months[1].incomePaise, 0);
  assert.equal(s.months[1].expensePaise, 0);
  assert.equal(s.months[3].expensePaise, rupees(40));
  assert.equal(s.monthsTruncated, false);
});

test("months keep years apart and roll December into January", () => {
  const s = summarize([txn("income", 100, "2025-12-31"), txn("income", 200, "2026-01-01")]);
  assert.deepEqual(
    s.months.map((m) => m.key),
    ["2025-12", "2026-01"],
  );
  assert.equal(s.months[0].incomePaise, rupees(100));
  assert.equal(s.months[1].incomePaise, rupees(200));
});

test("only the most recent 12 months are charted, and truncation is reported", () => {
  const s = summarize([txn("income", 100, "2024-01-10"), txn("income", 100, "2026-01-10")]);
  assert.equal(s.months.length, 12);
  assert.equal(s.months[0].key, "2025-02");
  assert.equal(s.months[11].key, "2026-01");
  assert.equal(s.monthsTruncated, true);
  // Totals still cover everything, not just the charted window.
  assert.equal(s.incomePaise, rupees(200));
});

test("categories rank by spend, roll up the tail, and only count expenses", () => {
  const rows = [
    txn("expense", 600, "2026-04-01", "Rent"),
    txn("expense", 200, "2026-04-02", "Food"),
    txn("expense", 100, "2026-04-03", "Travel"),
    txn("expense", 40, "2026-04-04", "Bills"),
    txn("expense", 30, "2026-04-05", "Health"),
    txn("expense", 20, "2026-04-06", "Fun"),
    txn("expense", 10, "2026-04-07", "Misc"),
    txn("income", 5_000, "2026-04-08", "Salary"),
  ];
  const s = summarize(rows);
  assert.deepEqual(
    s.categories.map((c) => c.category),
    ["Rent", "Food", "Travel", "Bills", "Health", "Other"],
  );
  assert.equal(s.categories[0].sharePercent, 60);
  const other = s.categories[5];
  assert.equal(other.isRemainder, true);
  assert.equal(other.totalPaise, rupees(30)); // Fun 20 + Misc 10
  assert.equal(other.sharePercent, 3);
});

test("recent activity is newest first and capped", () => {
  const rows = Array.from({ length: 9 }, (_, i) => txn("expense", 10 + i, `2026-04-${String(i + 1).padStart(2, "0")}`));
  const s = summarize(rows);
  assert.equal(s.recent.length, 6);
  assert.equal(s.recent[0].occurredOn, "2026-04-09");
  assert.equal(s.recent[5].occurredOn, "2026-04-04");
  assert.deepEqual(s.range, { from: "2026-04-01", to: "2026-04-09" });
});

test("rows with an unreadable date or amount are ignored rather than poisoning totals", () => {
  const bad: SummaryTransaction = { id: "bad", type: "income", amountPaise: Number.NaN, category: "x", description: null, occurredOn: "2026-04-01" };
  const badDate: SummaryTransaction = { id: "bad2", type: "income", amountPaise: 100, category: "x", description: null, occurredOn: "yesterday" };
  const s = summarize([bad, badDate, txn("income", 50, "2026-04-01")]);
  assert.equal(s.transactionCount, 1);
  assert.equal(s.incomePaise, rupees(50));
});
