// Summary page display arithmetic. Pure — no database, session, or network. Expected values are written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORY_TINTS, categoryTint, donutSegments, incomeCategories, latestMonthComparison, moneyFlow } from "../lib/summary-view";

const rupees = (r: number) => r * 100;

test("moneyFlow splits income into spent and kept, adding to exactly 100", () => {
  assert.deepEqual(moneyFlow(rupees(1_00_000), rupees(62_000)), {
    kind: "kept",
    spentPercent: 62,
    keptPercent: 38,
    keptPaise: rupees(38_000),
  });
  // Rounding never leaves the two shares at 99 or 101.
  const third = moneyFlow(rupees(3), rupees(1));
  assert.ok(third.kind === "kept" && third.spentPercent + third.keptPercent === 100);
});

test("moneyFlow treats spending everything as 100% spent, 0% kept", () => {
  assert.deepEqual(moneyFlow(rupees(50_000), rupees(50_000)), { kind: "kept", spentPercent: 100, keptPercent: 0, keptPaise: 0 });
});

test("moneyFlow expresses an overspend against expenses", () => {
  assert.deepEqual(moneyFlow(rupees(40_000), rupees(50_000)), {
    kind: "overspent",
    incomePercent: 80,
    overspentPercent: 20,
    overspentPaise: rupees(10_000),
  });
});

test("moneyFlow has explicit states for no income and no activity", () => {
  assert.deepEqual(moneyFlow(0, rupees(500)), { kind: "no-income" });
  assert.deepEqual(moneyFlow(0, 0), { kind: "empty" });
});

test("latestMonthComparison compares the last month with the one before it", () => {
  const result = latestMonthComparison([
    { key: "2026-01", incomePaise: rupees(50_000), expensePaise: rupees(30_000) },
    { key: "2026-02", incomePaise: rupees(50_000), expensePaise: rupees(42_000) },
  ]);
  assert.deepEqual(result, {
    current: { key: "2026-02", incomePaise: rupees(50_000), expensePaise: rupees(42_000) },
    currentNetPaise: rupees(8_000),
    previous: { key: "2026-01", incomePaise: rupees(50_000), expensePaise: rupees(30_000) },
    netChangePaise: rupees(-12_000),
  });
});

test("latestMonthComparison has no change without a previous month, and nothing without months", () => {
  const single = latestMonthComparison([{ key: "2026-03", incomePaise: 0, expensePaise: rupees(900) }]);
  assert.equal(single?.previous, null);
  assert.equal(single?.netChangePaise, null);
  assert.equal(single?.currentNetPaise, rupees(-900));
  assert.equal(latestMonthComparison([]), null);
});

test("category tints step down by rank and the remainder is neutral", () => {
  assert.equal(categoryTint(0, false), 100);
  assert.equal(categoryTint(1, false), 78);
  assert.equal(categoryTint(9, false), CATEGORY_TINTS[CATEGORY_TINTS.length - 1]);
  assert.equal(categoryTint(5, true), null);
});

test("incomeCategories ranks income by category and rolls the rest into Other", () => {
  const t = (id: string, rupeesAmount: number, category: string, type: "income" | "expense" = "income") => ({ id, type, amountPaise: rupees(rupeesAmount), category, description: null, occurredOn: "2026-09-01" });
  const rows = [
    t("1", 90_000, "Salary"),
    t("2", 10_000, "Freelance"),
    t("3", 500, "Interest"),
    t("4", 400, "Dividends"),
    t("5", 300, "Refund"),
    t("6", 200, "Gift"),
    t("7", 100, "Cashback"),
    t("8", 50_000, "Rent", "expense"),
  ];
  const shares = incomeCategories(rows);
  assert.deepEqual(
    shares.map((s) => [s.category, s.totalPaise / 100, s.sharePercent, s.isRemainder]),
    [
      ["Salary", 90_000, 89, false],
      ["Freelance", 10_000, 10, false],
      ["Interest", 500, 0, false],
      ["Dividends", 400, 0, false],
      ["Refund", 300, 0, false],
      ["Other", 300, 0, true],
    ],
  );
  assert.deepEqual(incomeCategories([t("x", 100, "Rent", "expense")]), []);
});

test("donutSegments are proportional, ordered and leave small gaps", () => {
  const segs = donutSegments([300, 100], 0.01);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].start, 0);
  assert.ok(Math.abs(segs[0].length - (0.75 - 0.01)) < 1e-9);
  assert.equal(segs[1].start, 0.75);
  assert.ok(Math.abs(segs[1].length - (0.25 - 0.01)) < 1e-9);
  assert.deepEqual(donutSegments([500]), [{ start: 0, length: 1 }]);
  assert.deepEqual(donutSegments([]), []);
  assert.ok(donutSegments([1_000_000, 1])[1].length > 0, "a tiny segment never vanishes");
});
