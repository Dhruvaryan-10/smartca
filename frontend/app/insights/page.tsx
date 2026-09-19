"use client";

import { useEffect, useState } from "react";
import AppShell from "../components/AppShell";
import { PageHeader } from "../components/ui/PageHeader";
import { Card } from "../components/ui/Card";
import { LoadingState } from "../components/ui/States";

// Shape returned by GET /api/transactions (services/transactions.ts —
// Postgres/Drizzle rows, not the old Mongo shape). Money is integer
// paise on the wire, per the schema's money convention.
interface Transaction {
  id: string;
  type: "income" | "expense";
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string;
}

export default function InsightsPage() {

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/transactions")
      .then((res) => res.json())
      .then((data) => setTransactions(Array.isArray(data) ? data : []))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const income = transactions.filter(t => t.type === "income");
  const expense = transactions.filter(t => t.type === "expense");

  const insights = generateInsights(income, expense);

  return (
    <AppShell>
      <PageHeader title="Ask" description="Rule-based suggestions based on your spending patterns." />

      {loading ? (
        <LoadingState label="Generating insights…" />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {insights.length === 0 ? (
            <InsightCard text="Add transactions to unlock insights." />
          ) : (
            insights.map((insight, index) => <InsightCard key={index} text={insight} />)
          )}
        </div>
      )}
    </AppShell>
  );
}

function generateInsights(
  income: Transaction[],
  expense: Transaction[]
) {

  const insights: string[] = [];

  // Sum in integer paise first, convert to rupees once — every
  // threshold/message below is unchanged, just fed correct amounts now.
  const totalIncome = income.reduce((s, i) => s + i.amountPaise, 0) / 100;
  const totalExpense = expense.reduce((s, i) => s + i.amountPaise, 0) / 100;
  const savings = totalIncome - totalExpense;

  /* 1️⃣ Savings Health */
  if (totalIncome > 0) {
    const rate = (savings / totalIncome) * 100;

    if (rate < 20) {
      insights.push(
        "⚠️ Your savings rate is below 20%. Consider reducing discretionary expenses."
      );
    } else if (rate < 40) {
      insights.push(
        "👍 Your savings are decent, but you can improve further."
      );
    } else {
      insights.push(
        "🔥 Excellent! You have a strong savings habit."
      );
    }
  }

  /* 2️⃣ Top Expense Category */
  // Summed in paise — never displayed as a value, only compared to find
  // the max, so no rupee conversion is needed here.
  const categoryMapPaise: Record<string, number> = {};

  expense.forEach((e) => {
    categoryMapPaise[e.category] =
      (categoryMapPaise[e.category] || 0) + e.amountPaise;
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
    insights.push(
      `📊 Highest spending is on ${maxCategory}. Try optimizing this category.`
    );
  }

  if (totalExpense > totalIncome) {
    insights.push(
      "🚨 Your expenses exceed income. Immediate budgeting needed."
    );
  }

  if (totalIncome === 0) {
    insights.push(
      "💡 Add income sources to unlock meaningful insights."
    );
  }

  if (totalExpense > 0) {
    insights.push(
      `💰 You could save ₹${Math.round(
        totalExpense * 0.1
      )} monthly by cutting 10% expenses.`
    );
  }

  if (income.length < 2 && totalIncome > 0) {
    insights.push(
      "⚡ Consider adding multiple income streams for stability."
    );
  }

  if (expense.length > 5) {
    insights.push(
      "🧾 You have many small expenses. Track subscriptions and daily spending."
    );
  }

  return insights;
}


function InsightCard({ text }: { text: string }) {
  return (
    <Card className="p-6">
      <p className="text-sm text-foreground">{text}</p>
    </Card>
  );
}