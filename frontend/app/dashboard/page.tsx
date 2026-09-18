"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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

const COLORS = ["#14b8a6", "#6366f1", "#ec4899", "#f59e0b", "#ef4444"];

// Shape returned by GET /api/transactions (services/transactions.ts —
// Postgres/Drizzle rows, not the old Mongo shape). Money is integer
// paise on the wire, per the schema's money convention; convert to
// rupees only for display/calculation, here at the UI boundary.
type Transaction = {
  id: string;
  type: "income" | "expense";
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string;
};

const paiseToRupees = (paise: number) => paise / 100;

export default function Dashboard() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  useEffect(() => {
    fetch("/api/transactions")
      .then((res) => res.json())
      .then((data) => setTransactions(Array.isArray(data) ? data : []))
      .catch((err) => console.error(err));
  }, []);

  // 🔹 Calculations — sum in integer paise first (never accumulate
  // rounding error across many rupee-converted additions), convert to
  // rupees once at the end for display. reduce() over an empty array
  // returns 0, not NaN, once amountPaise is a real number on every row.
  const totalIncomePaise = transactions
    .filter((t) => t.type === "income")
    .reduce((acc, t) => acc + t.amountPaise, 0);

  const totalExpensesPaise = transactions
    .filter((t) => t.type === "expense")
    .reduce((acc, t) => acc + t.amountPaise, 0);

  const totalIncome = paiseToRupees(totalIncomePaise);
  const totalExpenses = paiseToRupees(totalExpensesPaise);
  const savings = totalIncome - totalExpenses;

  // 🔹 Monthly Data
  const monthlyData = generateMonthlyData(transactions);

  // 🔹 Pie Data
  const categoryMapPaise: Record<string, number> = {};
  transactions
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      categoryMapPaise[t.category] =
        (categoryMapPaise[t.category] || 0) + t.amountPaise;
    });

  const categoryData = Object.keys(categoryMapPaise).map((key) => ({
    name: key,
    value: paiseToRupees(categoryMapPaise[key]),
  }));

  const recentExpenses = transactions
    .filter((t) => t.type === "expense")
    .slice(0, 5);

  return (
    <div className="flex min-h-screen bg-[#020617] text-white">

      {/* SIDEBAR */}
      <Sidebar />

      <div className="flex-1">

        <Navbar/>

        <main className="p-6 space-y-6">

          

          {/* CARDS */}
          <div className="grid grid-cols-3 gap-6">
            <StatCard title="Total Income" value={`₹${totalIncome}`} color="from-green-500 to-emerald-600" />
            <StatCard title="Total Expenses" value={`₹${totalExpenses}`} color="from-pink-500 to-rose-600" />
            <StatCard title="Savings" value={`₹${savings}`} color="from-blue-500 to-indigo-600" />
          </div>

          {/* CHARTS */}
          <div className="grid grid-cols-2 gap-6">

            {/* LINE CHART */}
            <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
              <h3 className="text-teal-400 mb-4">
                Monthly Income vs Expense
              </h3>

              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={monthlyData}>
                  <XAxis dataKey="name" stroke="#ccc" />
                  <YAxis stroke="#ccc" />
                  <Tooltip />
                  <Line type="monotone" dataKey="income" stroke="#14b8a6" />
                  <Line type="monotone" dataKey="expense" stroke="#ec4899" />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* PIE CHART */}
            <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
              <h3 className="text-teal-400 mb-4">
                Spending Categories
              </h3>

              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={categoryData} dataKey="value" nameKey="name">
                    {categoryData.map((_, index) => (
                      <Cell key={index} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>

          </div>

          {/* RECENT EXPENSES */}
          <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
            <h3 className="text-teal-400 mb-4">
              Recent Expenses
            </h3>

            {recentExpenses.length === 0 ? (
              <p className="text-slate-400">
                No expenses added yet
              </p>
            ) : (
              recentExpenses.map((item) => (
                <div
                  key={item.id}
                  className="flex justify-between border-b border-white/10 py-2"
                >
                  <span>{item.category}</span>
                  <span className="text-rose-400">
                    ₹{paiseToRupees(item.amountPaise)}
                  </span>
                </div>
              ))
            )}
          </div>

        </main>
      </div>
    </div>
  );
}





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
    <div className={`bg-gradient-to-br ${color} p-6 rounded-2xl`}>
      <p className="text-sm opacity-80">{title}</p>
      <h3 className="text-3xl font-bold mt-2">{value}</h3>
    </div>
  );
}

function generateMonthlyData(transactions: Transaction[]) {
  // All 12 months, not just Jan-Jun — the old 6-month list silently
  // dropped any transaction dated July-December regardless of amount.
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  // Bucket by numeric month index (0-11), not by a locale-formatted
  // name string — toLocaleString("default",{month:"short"}) renders
  // September as "Sept" (4 letters) in some ICU/locale data, which
  // would never match a hardcoded "Sep" key and silently drop that
  // month's totals. Indexing sidesteps that entirely (same fix as
  // reports/page.tsx).
  const paiseByMonthIndex: { income: number; expense: number }[] = months.map(
    () => ({ income: 0, expense: 0 })
  );

  transactions.forEach((t) => {
    const monthIndex = new Date(t.occurredOn).getMonth();
    if (monthIndex < 0 || monthIndex > 11) return;

    if (t.type === "income") paiseByMonthIndex[monthIndex].income += t.amountPaise;
    else paiseByMonthIndex[monthIndex].expense += t.amountPaise;
  });

  return months.map((name, i) => ({
    name,
    income: paiseToRupees(paiseByMonthIndex[i].income),
    expense: paiseToRupees(paiseByMonthIndex[i].expense),
  }));
}