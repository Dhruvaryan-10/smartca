// Summary page display arithmetic. Pure — no database, session, or network. Expected values are written out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORY_TINTS, categoryTint, latestMonthComparison, moneyFlow } from "../lib/summary-view";

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
