// Example data for the landing page. Every figure the page shows is COMPUTED from these inputs by SmartCA's own code — the ledger
// summary (lib/summary.ts) and the deterministic tax engine (tax-engine) — exactly as the product computes a real person's figures.
// Nothing here is a screenshot or a hand-typed result; the page labels all of it as example figures.
import { compareRegimes } from "@/tax-engine";
import type { RegimeComparison, TaxResult } from "@/tax-engine";
import { summarize, type Summary, type SummaryTransaction } from "@/lib/summary";

const RUPEE = 100;

type Row = [occurredOn: string, type: "income" | "expense", rupees: number, category: string, description: string | null];

// Six months of an example salaried person's ledger (FY 2025-26, April to September).
const ROWS: Row[] = [];
const MONTHS = ["2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09"];
MONTHS.forEach((m, i) => {
  ROWS.push([`${m}-01`, "income", 1_20_000, "Salary", `${["April", "May", "June", "July", "August", "September"][i]} salary`]);
  ROWS.push([`${m}-03`, "expense", 28_000, "Rent", null]);
  ROWS.push([`${m}-09`, "expense", [8_400, 9_150, 8_900, 9_600, 8_750, 9_300][i], "Groceries", "Weekly groceries"]);
  ROWS.push([`${m}-14`, "expense", [3_900, 4_200, 3_800, 4_400, 4_100, 4_000][i], "Transport", "Metro and cabs"]);
  ROWS.push([`${m}-20`, "expense", [3_350, 3_600, 4_100, 3_900, 3_450, 3_700][i], "Utilities", "Electricity and internet"]);
});
ROWS.push(["2025-06-18", "income", 35_000, "Freelance", "Brand identity project"]);
ROWS.push(["2025-07-22", "expense", 12_500, "Health", "Annual health insurance"]);
ROWS.push(["2025-08-16", "expense", 6_800, "Shopping", "Running shoes"]);
ROWS.push(["2025-09-24", "expense", 2_400, "Shopping", "Books"]);

export const EXAMPLE_TRANSACTIONS: SummaryTransaction[] = ROWS.map(([occurredOn, type, rupees, category, description], i) => ({
  id: `example-${i}`,
  type,
  amountPaise: rupees * RUPEE,
  category,
  description,
  occurredOn,
}));

export const EXAMPLE_SUMMARY: Summary = summarize(EXAMPLE_TRANSACTIONS);

// The tax example: an annual salary with Section 80C investments, through the same engine the Tax page uses.
export const EXAMPLE_TAX_INPUT = {
  assessmentYearLabel: "2026-27",
  ageCategory: "below60" as const,
  incomeSources: [{ kind: "salary" as const, label: "Salary", amountPaise: 14_40_000 * RUPEE }],
  deductions: [{ section: "80C" as const, amountPaise: 1_50_000 * RUPEE }],
};

export const EXAMPLE_COMPARISON: RegimeComparison = compareRegimes(EXAMPLE_TAX_INPUT);

export const EXAMPLE_NEW_REGIME: TaxResult | null = EXAMPLE_COMPARISON.new.status === "ok" ? EXAMPLE_COMPARISON.new.result : null;
