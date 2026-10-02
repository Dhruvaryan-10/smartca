// Display arithmetic for the Summary page, layered on summarize() (lib/summary.ts). Pure and integer-paise throughout: it only
// re-expresses figures summarize() already produced (proportions for the money-flow bar, the latest month against the one before);
// it never invents a figure, projects one, or computes tax.
import type { MonthBucket } from "./summary";

export type MoneyFlow =
  | {
      /** Income covered expenses: expenses and what was kept, as shares of income. */
      kind: "kept";
      spentPercent: number;
      keptPercent: number;
      keptPaise: number;
    }
  | {
      /** Expenses exceeded income: income and the overspend, as shares of expenses. */
      kind: "overspent";
      incomePercent: number;
      overspentPercent: number;
      overspentPaise: number;
    }
  | { kind: "no-income" }
  | { kind: "empty" };

/** Whole-number shares that always add up to exactly 100 (rounding goes to the larger part). */
function split(part: number, whole: number): [number, number] {
  const first = Math.round((part / whole) * 100);
  return [first, 100 - first];
}

export function moneyFlow(incomePaise: number, expensePaise: number): MoneyFlow {
  if (incomePaise <= 0 && expensePaise <= 0) return { kind: "empty" };
  if (incomePaise <= 0) return { kind: "no-income" };
  if (expensePaise <= incomePaise) {
    const [spentPercent, keptPercent] = split(expensePaise, incomePaise);
    return { kind: "kept", spentPercent, keptPercent, keptPaise: incomePaise - expensePaise };
  }
  const [incomePercent, overspentPercent] = split(incomePaise, expensePaise);
  return { kind: "overspent", incomePercent, overspentPercent, overspentPaise: expensePaise - incomePaise };
}

export type MonthComparison = {
  current: MonthBucket;
  currentNetPaise: number;
  /** The month immediately before `current`, when it is in the window. */
  previous: MonthBucket | null;
  /** current net minus previous net; null without a previous month. */
  netChangePaise: number | null;
};

/** The latest month with activity, against the calendar month before it (summarize() fills quiet months with zeros). */
export function latestMonthComparison(months: readonly MonthBucket[]): MonthComparison | null {
  if (months.length === 0) return null;
  const current = months[months.length - 1];
  const previous = months.length >= 2 ? months[months.length - 2] : null;
  const net = (m: MonthBucket) => m.incomePaise - m.expensePaise;
  return {
    current,
    currentNetPaise: net(current),
    previous,
    netChangePaise: previous ? net(current) - net(previous) : null,
  };
}

/** Tint steps for ranked spending categories: strongest first, the rolled-up remainder always neutral. */
export const CATEGORY_TINTS = [100, 78, 60, 46, 34] as const;

export function categoryTint(rank: number, isRemainder: boolean): number | null {
  if (isRemainder) return null;
  return CATEGORY_TINTS[Math.min(rank, CATEGORY_TINTS.length - 1)];
}
