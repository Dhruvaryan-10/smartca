"use client";

import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";
import Sidebar from "../components/Sidebar";

interface Transaction {
  _id: string;
  type: "income" | "expense";
  amount: number;
  category: string;
  date: string;
}

export default function InsightsPage() {

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  // ✅ FETCH FROM YOUR API (FIXED)
  useEffect(() => {
    fetch("/api/transactions")
      .then((res) => res.json())
      .then((data) => setTransactions(data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const income = transactions.filter(t => t.type === "income");
  const expense = transactions.filter(t => t.type === "expense");

  const insights = generateInsights(income, expense);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#020617] text-white">
        Generating AI Insights...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#020617] text-white">

      <Navbar />

      <div className="flex">

        <Sidebar active="insights" />

        <main className="flex-1 p-10 space-y-8">

          {/* HEADER */}
          <div>
            <h2 className="text-3xl font-bold">
              AI Financial Insights 🧠
            </h2>
            <p className="text-slate-400">
              Smart suggestions based on your spending
            </p>
          </div>

          {/* INSIGHTS */}
          <div className="grid grid-cols-2 gap-6">

            {insights.length === 0 ? (
              <InsightCard text="💡 Add transactions to unlock AI insights." />
            ) : (
              insights.map((insight, index) => (
                <InsightCard key={index} text={insight} />
              ))
            )}

          </div>

        </main>

      </div>
    </div>
  );
}

/* ========================= */
/* SMART AI LOGIC (UPGRADED) */
/* ========================= */

function generateInsights(
  income: Transaction[],
  expense: Transaction[]
) {

  const insights: string[] = [];

  const totalIncome = income.reduce((s, i) => s + i.amount, 0);
  const totalExpense = expense.reduce((s, i) => s + i.amount, 0);
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
  const categoryMap: Record<string, number> = {};

  expense.forEach((e) => {
    categoryMap[e.category] =
      (categoryMap[e.category] || 0) + e.amount;
  });

  let maxCategory = "";
  let maxValue = 0;

  for (const key in categoryMap) {
    if (categoryMap[key] > maxValue) {
      maxValue = categoryMap[key];
      maxCategory = key;
    }
  }

  if (maxCategory) {
    insights.push(
      `📊 Highest spending is on ${maxCategory}. Try optimizing this category.`
    );
  }

  /* 3️⃣ Overspending Warning */
  if (totalExpense > totalIncome) {
    insights.push(
      "🚨 Your expenses exceed income. Immediate budgeting needed."
    );
  }

  /* 4️⃣ No Income Case */
  if (totalIncome === 0) {
    insights.push(
      "💡 Add income sources to unlock meaningful insights."
    );
  }

  /* 5️⃣ Smart Saving Suggestion */
  if (totalExpense > 0) {
    insights.push(
      `💰 You could save ₹${Math.round(
        totalExpense * 0.1
      )} monthly by cutting 10% expenses.`
    );
  }

  /* 6️⃣ Income Stability */
  if (income.length < 2 && totalIncome > 0) {
    insights.push(
      "⚡ Consider adding multiple income streams for stability."
    );
  }

  /* 7️⃣ Frequent Small Expenses */
  if (expense.length > 5) {
    insights.push(
      "🧾 You have many small expenses. Track subscriptions and daily spending."
    );
  }

  return insights;
}

/* ========================= */
/* COMPONENT */
/* ========================= */

function InsightCard({ text }: { text: string }) {
  return (
    <div className="bg-white/5 border border-white/10 p-6 rounded-2xl hover:scale-[1.02] transition">
      <p className="text-lg">{text}</p>
    </div>
  );
}