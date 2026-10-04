// Insights rules. Pure: no database, session or network. Expected values are hand-computed.
// Regression: the "₹X a month" tip used to be 10% of ALL-TIME expenses, which broke docs/design/finance-data.md ("Monthly values
// come from monthly data, never from all-time totals"). It now uses the latest calendar month that has expenses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateInsights, latestExpenseMonth, type InsightTransaction } from "../lib/insights";

let nextId = 0;
const txn = (type: "income" | "expense", rupees: number, occurredOn: string, category = type === "income" ? "Salary" : "Food"): InsightTransaction => ({
  id: `t${nextId++}`,
  type,
  amountPaise: rupees * 100,
  category,
  description: null,
  occurredOn,
});

const monthlyTip = (insights: string[]) => insights.filter((i) => i.startsWith("💰"));

test("latestExpenseMonth: the latest calendar month is chosen across months and years, and only its rows are summed", () => {
  const latest = latestExpenseMonth([
    txn("expense", 50_000, "2025-12-31"),
    txn("expense", 1_000, "2026-02-01"),
    txn("expense", 2_500, "2026-02-28"),
    txn("expense", 90_000, "2026-01-31"),
  ]);
  assert.deepEqual(latest, { key: "2026-02", totalPaise: 350_000 });
});

test("latestExpenseMonth: calendar-month boundaries, not a 30-day window (31 Jan is January, 1 Feb is February)", () => {
  assert.deepEqual(latestExpenseMonth([txn("expense", 700, "2026-01-31"), txn("expense", 300, "2026-02-01")]), { key: "2026-02", totalPaise: 30_000 });
});

test("latestExpenseMonth: the same month of an earlier year is never merged in", () => {
  assert.deepEqual(latestExpenseMonth([txn("expense", 400, "2026-03-10"), txn("expense", 9_999, "2025-03-10")]), { key: "2026-03", totalPaise: 40_000 });
});

test("latestExpenseMonth: no expenses gives null", () => {
  assert.equal(latestExpenseMonth([]), null);
});

test("the monthly tip uses the latest month even when the all-time total is far larger", () => {
  const insights = generateInsights([
    txn("income", 300_000, "2026-01-05"),
    txn("expense", 80_000, "2026-01-10"), // all-time expenses: 92,840
    txn("expense", 10_000, "2026-08-02"),
    txn("expense", 2_840, "2026-09-21"), // latest month: September 2026, 2,840
  ]);
  const [tip] = monthlyTip(insights);
  assert.equal(tip, "💰 You spent ₹2,840 in Sep ’26. Cutting that by 10% would save about ₹284 a month.");
  assert.ok(!tip.includes("9,284") && !tip.includes("9284"), "never 10% of the all-time total");
});

test("an earlier month with bigger spending is not selected", () => {
  const [tip] = monthlyTip(generateInsights([txn("expense", 50_000, "2026-07-15"), txn("expense", 1_200, "2026-08-03")]));
  assert.match(tip, /in Aug ’26\./);
  assert.match(tip, /about ₹120 a month/);
});

test("the saving is whole rupees", () => {
  const [tip] = monthlyTip(generateInsights([txn("expense", 1_234, "2026-05-02")]));
  assert.match(tip, /about ₹123 a month/);
});

test("no expense data gives no monthly tip", () => {
  assert.deepEqual(monthlyTip(generateInsights([txn("income", 50_000, "2026-09-01")])), []);
});

test("an account with no transactions gets no tips, so the page reaches its empty state", () => {
  assert.deepEqual(generateInsights([]), []);
});

test("no tip calls an all-time figure monthly: the only 'a month' figure equals 10% of the latest month", () => {
  const insights = generateInsights([
    txn("income", 100_000, "2026-08-01"),
    txn("expense", 40_000, "2026-08-10", "Rent"),
    txn("expense", 5_000, "2026-09-10", "Food"),
  ]);
  const monthly = insights.filter((i) => /month/i.test(i));
  assert.deepEqual(monthly, ["💰 You spent ₹5,000 in Sep ’26. Cutting that by 10% would save about ₹500 a month."]);
});

test("the other rules are unchanged", () => {
  const insights = generateInsights([
    txn("income", 100_000, "2026-08-01"),
    txn("expense", 70_000, "2026-08-10", "Rent"),
    txn("expense", 5_000, "2026-09-10", "Food"),
  ]);
  assert.deepEqual(insights, [
    "👍 Your savings are decent, but you can improve further.", // 25% saved
    "📊 Highest spending is on Rent. Try optimizing this category.",
    "💰 You spent ₹5,000 in Sep ’26. Cutting that by 10% would save about ₹500 a month.",
    "⚡ Consider adding multiple income streams for stability.",
  ]);
});
