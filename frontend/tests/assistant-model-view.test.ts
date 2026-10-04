// How a filtered tool result is written for the model (lib/assistant/model-view.ts). PURE: no database, no network.
// Pinned: amounts are re-rendered exactly as SmartCA's pages write them; nothing is added, dropped or recomputed; the input is never
// mutated; and only integer "...Paise" values change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { presentForModel } from "../lib/assistant/model-view";
import { formatRupees } from "../lib/format";

test("every integer ...Paise field is written in rupees under its name without the suffix, at any depth", () => {
  const summary = {
    status: "ok",
    tool: "get_financial_summary",
    result: {
      incomePaise: 15_000_000,
      expensePaise: 2_500_000,
      savingsPaise: -1_234_567,
      savingsRatePercent: 83,
      months: [{ key: "2026-09", incomePaise: 15_000_000, expensePaise: 2_500_000 }],
      categories: [{ category: "Groceries", totalPaise: 2_000_000, sharePercent: 80 }],
    },
  };
  assert.deepEqual(presentForModel(summary), {
    status: "ok",
    tool: "get_financial_summary",
    result: {
      income: "₹1,50,000",
      expense: "₹25,000",
      savings: formatRupees(-1_234_567),
      savingsRatePercent: 83,
      months: [{ key: "2026-09", income: "₹1,50,000", expense: "₹25,000" }],
      categories: [{ category: "Groceries", total: "₹20,000", sharePercent: 80 }],
    },
  });
  assert.equal(formatRupees(-1_234_567), "−₹12,345.67", "paise are kept, never rounded away");
});

test("nothing else changes: other fields, text, nulls, non-integer or non-number ...Paise values, and the input itself", () => {
  const input = { a: "text ₹ 100", n: 5, z: null, list: [1, "x"], oddPaise: "12", fractionPaise: 1.5, nested: { flag: true } };
  const before = structuredClone(input);
  assert.deepEqual(presentForModel(input), input);
  assert.deepEqual(input, before, "the input is not mutated");
});

test("a field already present under the shorter name is never overwritten: the paise field keeps its own name", () => {
  assert.deepEqual(presentForModel({ total: "label", totalPaise: 500 }), { total: "label", totalPaise: "₹5" });
});

test("the same number of fields comes out as went in: no field is added or dropped", () => {
  const count = (v: unknown): number => (Array.isArray(v) ? v.reduce((s: number, x) => s + count(x), 0) : typeof v === "object" && v !== null ? Object.values(v).reduce((s: number, x) => s + 1 + count(x), 0) : 0);
  const sample = { status: "ok", result: { incomePaise: 1, rows: [{ amountPaise: 2, category: "c" }, { amountPaise: 3, category: "d" }] } };
  assert.equal(count(presentForModel(sample)), count(sample));
});
