// Display arithmetic for the Summary page, layered on summarize() (lib/summary.ts). Pure and integer-paise throughout: it only
// re-expresses figures summarize() already produced (proportions for the money-flow bar, the latest month against the one before);
// it never invents a figure, projects one, or computes tax.
import type { CategoryShare, MonthBucket, SummaryTransaction } from "./summary";

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

// ---------------------------------------------------------------------------------------------------------------------------------
// Income composition
// ---------------------------------------------------------------------------------------------------------------------------------

const MAX_INCOME_CATEGORIES = 5;

/**
 * Income grouped by the category the person gave each entry, ranked and rolled up exactly the way summarize() ranks expense
 * categories (top five, the rest as "Other", whole-number shares of the total). Uses the same validity filter as summarize(), so
 * the totals agree with the Summary's income figure.
 */
export function incomeCategories(transactions: readonly SummaryTransaction[]): CategoryShare[] {
  const totals = new Map<string, number>();
  let incomePaise = 0;
  for (const t of transactions) {
    if (t.type !== "income" || !/^\d{4}-\d{2}-\d{2}/.test(t.occurredOn) || !Number.isFinite(t.amountPaise)) continue;
    incomePaise += t.amountPaise;
    totals.set(t.category, (totals.get(t.category) ?? 0) + t.amountPaise);
  }
  const ranked = [...totals.entries()]
    .map(([category, totalPaise]) => ({ category, totalPaise }))
    .sort((a, b) => b.totalPaise - a.totalPaise || a.category.localeCompare(b.category));
  const percentOf = (paise: number) => (incomePaise > 0 ? Math.round((paise / incomePaise) * 100) : 0);
  const shares: CategoryShare[] = ranked.slice(0, MAX_INCOME_CATEGORIES).map((c) => ({ ...c, sharePercent: percentOf(c.totalPaise), isRemainder: false }));
  const rest = ranked.slice(MAX_INCOME_CATEGORIES);
  if (rest.length > 0) {
    const totalPaise = rest.reduce((sum, c) => sum + c.totalPaise, 0);
    shares.push({ category: "Other", totalPaise, sharePercent: percentOf(totalPaise), isRemainder: true });
  }
  return shares;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Donut geometry
// ---------------------------------------------------------------------------------------------------------------------------------

export type DonutSegment = { start: number; length: number };

/**
 * Segment positions for a donut, as fractions of the circumference, in proportion to exact paise (not rounded shares). Each segment
 * gives up `gap` of its length (capped so a tiny segment never vanishes), so neighbours read as separate pieces.
 */
export function donutSegments(values: readonly number[], gap = 0.006): DonutSegment[] {
  const total = values.reduce((sum, v) => sum + Math.max(0, v), 0);
  if (total <= 0) return [];
  const single = values.filter((v) => v > 0).length === 1;
  let cursor = 0;
  return values.map((v) => {
    const share = Math.max(0, v) / total;
    const g = single ? 0 : Math.min(gap, share / 3);
    const segment = { start: cursor, length: Math.max(0, share - g) };
    cursor += share;
    return segment;
  });
}
