"use client";

import { useEffect, useState } from "react";
import Navbar from "../components/Navbar";
import Sidebar from "../components/Sidebar";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import Link from "next/link";

type Transaction = {
  _id: string;
  type: "income" | "expense";
  amount: number;
  category: string;
  date: string;
};

const COLORS = ["#14b8a6", "#6366f1", "#ec4899", "#f59e0b", "#ef4444"];

export default function ReportsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // ✅ FETCH DATA
  useEffect(() => {
    fetch("/api/transactions")
      .then((res) => res.json())
      .then((data) => setTransactions(data))
      .catch(console.error);
  }, []);

  // ✅ CALCULATIONS
  const totalIncome = transactions
    .filter((t) => t.type === "income")
    .reduce((a, t) => a + t.amount, 0);

  const totalExpense = transactions
    .filter((t) => t.type === "expense")
    .reduce((a, t) => a + t.amount, 0);

  const savings = totalIncome - totalExpense;

  const savingsRate =
    totalIncome > 0
      ? ((savings / totalIncome) * 100).toFixed(1)
      : "0";

  // ✅ MONTHLY DATA
  const monthlyData = generateMonthlyData(transactions);

  // ✅ CATEGORY DATA
  const categoryMap: Record<string, number> = {};

  transactions
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      categoryMap[t.category] =
        (categoryMap[t.category] || 0) + t.amount;
    });

  const categoryData = Object.keys(categoryMap).map((k) => ({
    name: k,
    value: categoryMap[k],
  }));

  return (
    <div className="flex min-h-screen bg-[#020617] text-white">

      {/* SIDEBAR */}
      <Sidebar />

      <div className="flex-1">

        {/* NAVBAR */}
        <Navbar />

        <main className="p-6 space-y-6">

          {/* HEADER */}
          <div>
            <h1 className="text-2xl font-bold">
              Financial Reports
            </h1>
            <p className="text-slate-400">
              Analyze your financial performance
            </p>
          </div>

          {/* STATS */}
          <div className="grid grid-cols-4 gap-6">

            <StatCard title="Total Income" value={`₹${totalIncome}`} color="text-green-400" />

            <StatCard title="Total Expense" value={`₹${totalExpense}`} color="text-rose-400" />

            <StatCard title="Savings" value={`₹${savings}`} color="text-blue-400" />

            <StatCard title="Savings Rate" value={`${savingsRate}%`} color="text-teal-400" />

          </div>

          {/* MONTHLY TREND */}
          <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">

            <h3 className="text-teal-400 mb-4">
              Monthly Trends
            </h3>

            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={monthlyData}>
                <XAxis dataKey="name" stroke="#ccc" />
                <YAxis stroke="#ccc" />
                <Tooltip />
                <Line dataKey="income" stroke="#14b8a6" />
                <Line dataKey="expense" stroke="#ec4899" />
              </LineChart>
            </ResponsiveContainer>

          </div>

          {/* EXPENSE BREAKDOWN */}
          <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">

            <h3 className="text-teal-400 mb-4">
              Expense Breakdown
            </h3>

            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={categoryData} dataKey="value" nameKey="name">
                  {categoryData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>

          </div>

        </main>
      </div>
    </div>
  );
}

/* ---------------- COMPONENTS ---------------- */





function StatCard({
  title,
  value,
  color,
}: {
  title: string;
  value: string;
  color: string;
}) {
  return (
    <div className="bg-white/5 border border-white/10 p-4 rounded-xl">
      <p className="text-sm text-slate-400">{title}</p>
      <h2 className={`text-2xl font-bold ${color}`}>
        {value}
      </h2>
    </div>
  );
}

/* ---------------- HELPER ---------------- */

function generateMonthlyData(transactions: Transaction[]) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun"];
  const map: any = {};

  transactions.forEach((t) => {
    const m = new Date(t.date).toLocaleString("default", {
      month: "short",
    });

    if (!map[m]) map[m] = { name: m, income: 0, expense: 0 };

    if (t.type === "income") map[m].income += t.amount;
    else map[m].expense += t.amount;
  });

  return months.map(
    (m) => map[m] || { name: m, income: 0, expense: 0 }
  );
}