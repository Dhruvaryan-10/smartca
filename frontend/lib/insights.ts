// The Insights page's fixed rules. Pure: it reshapes the rows GET /api/transactions already returned for the signed-in user.
// Each tip starts with a symbol the page turns into a worded tone (Good / Watch / Tip).
//
// Every figure is computed in integer paise and formatted once. A figure called monthly comes from one calendar month's
// data (docs/design/finance-data.md: "Monthly values come from monthly data, never from all-time totals").
import { formatMonthLabel, formatRupees } from "./format";

export type InsightTransaction = {
  id: string;
  type: "income" | "expense";
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string; // YYYY-MM-DD
};

const MONTH_KEY = /^(\d{4}-\d{2})-\d{2}/;

/** The most recent calendar month ("YYYY-MM") with any expense, and that month's expense total. */
export function latestExpenseMonth(expenses: readonly InsightTransaction[]): { key: string; totalPaise: number } | null {
  let latest: string | null = null;
  for (const e of expenses) {
    const key = MONTH_KEY.exec(e.occurredOn)?.[1];
    if (key && (latest === null || key > latest)) latest = key;
  }
  if (latest === null) return null;
  const totalPaise = expenses.reduce((sum, e) => (MONTH_KEY.exec(e.occurredOn)?.[1] === latest ? sum + e.amountPaise : sum), 0);
  return { key: latest, totalPaise };
}

export function generateInsights(transactions: readonly InsightTransaction[]): string[] {
  // No transactions at all: the page shows its empty state ("Add transactions to unlock insights") instead of a tip.
  if (transactions.length === 0) return [];

  const income = transactions.filter((t) => t.type === "income");
  const expense = transactions.filter((t) => t.type === "expense");

  const insights: string[] = [];

  // Sum in integer paise first, convert to rupees once.
  const totalIncome = income.reduce((s, i) => s + i.amountPaise, 0) / 100;
  const totalExpense = expense.reduce((s, i) => s + i.amountPaise, 0) / 100;
  const savings = totalIncome - totalExpense;

  /* Savings health */
  if (totalIncome > 0) {
    const rate = (savings / totalIncome) * 100;

    if (rate < 20) {
      insights.push("⚠️ Your savings rate is below 20%. Consider reducing discretionary expenses.");
    } else if (rate < 40) {
      insights.push("👍 Your savings are decent, but you can improve further.");
    } else {
      insights.push("🔥 Excellent! You have a strong savings habit.");
    }
  }

  /* Top expense category: summed in paise, only compared, never displayed as a value */
  const categoryMapPaise: Record<string, number> = {};
  expense.forEach((e) => {
    categoryMapPaise[e.category] = (categoryMapPaise[e.category] || 0) + e.amountPaise;
  });

  let maxCategory = "";
  let maxValue = 0;
  for (const key in categoryMapPaise) {
    if (categoryMapPaise[key] > maxValue) {
      maxValue = categoryMapPaise[key];
      maxCategory = key;
    }
  }

  if (maxCategory) {
    insights.push(`📊 Highest spending is on ${maxCategory}. Try optimizing this category.`);
  }

  if (totalExpense > totalIncome) {
    insights.push("🚨 Your expenses exceed income. Immediate budgeting needed.");
  }

  if (totalIncome === 0) {
    insights.push("💡 Add income sources to unlock meaningful insights.");
  }

  /* Monthly saving from a 10% cut: based on the latest calendar month's expenses, never the all-time total */
  const latest = latestExpenseMonth(expense);
  if (latest && latest.totalPaise > 0) {
    const savingPaise = Math.round(latest.totalPaise / 10 / 100) * 100; // whole rupees, as before
    insights.push(
      `💰 You spent ${formatRupees(latest.totalPaise)} in ${formatMonthLabel(latest.key, true)}. ` +
        `Cutting that by 10% would save about ${formatRupees(savingPaise)} a month.`,
    );
  }

  if (income.length < 2 && totalIncome > 0) {
    insights.push("⚡ Consider adding multiple income streams for stability.");
  }

  if (expense.length > 5) {
    insights.push("🧾 You have many small expenses. Track subscriptions and daily spending.");
  }

  return insights;
}
