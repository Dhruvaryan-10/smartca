// Pure aggregation for the Summary page. Works entirely in integer paise
// (sum first, convert only when rendering) and never touches a database,
// session, or network — it just reshapes the rows GET /api/transactions
// already returned for the signed-in user.
//
// This is display arithmetic (totals, shares), not tax computation. Tax
// numbers only ever come from the deterministic engine in /tax-engine.

export type SummaryTransaction = {
  id: string;
  type: "income" | "expense";
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string; // YYYY-MM-DD
};

export type MonthBucket = {
  /** "YYYY-MM" */
  key: string;
  incomePaise: number;
  expensePaise: number;
};

export type CategoryShare = {
  category: string;
  totalPaise: number;
  /** Whole-number percentage of total expenses, 0-100. */
  sharePercent: number;
  /** True for the rolled-up remainder row, not a real category. */
  isRemainder: boolean;
};

export type Summary = {
  transactionCount: number;
  incomePaise: number;
  expensePaise: number;
  savingsPaise: number;
  /** savings / income as a whole percentage; null when there is no income to compare against. */
  savingsRatePercent: number | null;
  /** Earliest and latest transaction dates (YYYY-MM-DD), or null when empty. */
  range: { from: string; to: string } | null;
  /** Contiguous months from first to last activity, most recent MAX_MONTHS at most. */
  months: MonthBucket[];
  /** True when older months were dropped from `months`. */
  monthsTruncated: boolean;
  categories: CategoryShare[];
  /** Newest first. */
  recent: SummaryTransaction[];
};

const MAX_MONTHS = 12;
const MAX_CATEGORIES = 5;
const RECENT_LIMIT = 6;

function monthKeyOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

function nextMonthKey(key: string): string {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

export function summarize(transactions: SummaryTransaction[]): Summary {
  const valid = transactions.filter(
    (t) => /^\d{4}-\d{2}-\d{2}/.test(t.occurredOn) && Number.isFinite(t.amountPaise),
  );

  let incomePaise = 0;
  let expensePaise = 0;
  const monthTotals = new Map<string, { incomePaise: number; expensePaise: number }>();
  const categoryTotals = new Map<string, number>();

  for (const t of valid) {
    const key = monthKeyOf(t.occurredOn);
    const bucket = monthTotals.get(key) ?? { incomePaise: 0, expensePaise: 0 };
    if (t.type === "income") {
      incomePaise += t.amountPaise;
      bucket.incomePaise += t.amountPaise;
    } else {
      expensePaise += t.amountPaise;
      bucket.expensePaise += t.amountPaise;
      categoryTotals.set(t.category, (categoryTotals.get(t.category) ?? 0) + t.amountPaise);
    }
    monthTotals.set(key, bucket);
  }

  const savingsPaise = incomePaise - expensePaise;
  const savingsRatePercent = incomePaise > 0 ? Math.round((savingsPaise / incomePaise) * 100) : null;

  const sortedByDate = [...valid].sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0));
  const range =
    sortedByDate.length > 0
      ? { from: sortedByDate[sortedByDate.length - 1].occurredOn.slice(0, 10), to: sortedByDate[0].occurredOn.slice(0, 10) }
      : null;

  // Every month between first and last activity, including quiet ones —
  // a gap in the chart would read as missing data rather than "nothing
  // happened this month".
  const allMonths: MonthBucket[] = [];
  if (range) {
    const last = monthKeyOf(range.to);
    for (let key = monthKeyOf(range.from); key <= last; key = nextMonthKey(key)) {
      const totals = monthTotals.get(key) ?? { incomePaise: 0, expensePaise: 0 };
      allMonths.push({ key, ...totals });
    }
  }
  const monthsTruncated = allMonths.length > MAX_MONTHS;
  const months = monthsTruncated ? allMonths.slice(allMonths.length - MAX_MONTHS) : allMonths;

  const rankedCategories = [...categoryTotals.entries()]
    .map(([category, totalPaise]) => ({ category, totalPaise }))
    .sort((a, b) => b.totalPaise - a.totalPaise || a.category.localeCompare(b.category));

  const percentOf = (paise: number) => (expensePaise > 0 ? Math.round((paise / expensePaise) * 100) : 0);
  const categories: CategoryShare[] = rankedCategories.slice(0, MAX_CATEGORIES).map((c) => ({
    ...c,
    sharePercent: percentOf(c.totalPaise),
    isRemainder: false,
  }));
  const remainder = rankedCategories.slice(MAX_CATEGORIES);
  if (remainder.length > 0) {
    const totalPaise = remainder.reduce((sum, c) => sum + c.totalPaise, 0);
    categories.push({ category: "Other", totalPaise, sharePercent: percentOf(totalPaise), isRemainder: true });
  }

  return {
    transactionCount: valid.length,
    incomePaise,
    expensePaise,
    savingsPaise,
    savingsRatePercent,
    range,
    months,
    monthsTruncated,
    categories,
    recent: sortedByDate.slice(0, RECENT_LIMIT),
  };
}
