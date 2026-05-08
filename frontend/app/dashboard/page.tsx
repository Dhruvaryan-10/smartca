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

type Transaction = {
  _id: string;
  type: "income" | "expense";
  amount: number;
  category: string;
  date: string;
};

export default function Dashboard() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  useEffect(() => {
    fetch("/api/transactions")
      .then((res) => res.json())
      .then((data) => setTransactions(data))
      .catch((err) => console.error(err));
  }, []);

  // 🔹 Calculations
  const totalIncome = transactions
    .filter((t) => t.type === "income")
    .reduce((acc, t) => acc + t.amount, 0);

  const totalExpenses = transactions
    .filter((t) => t.type === "expense")
    .reduce((acc, t) => acc + t.amount, 0);

  const savings = totalIncome - totalExpenses;

  // 🔹 Monthly Data
  const monthlyData = generateMonthlyData(transactions);

  // 🔹 Pie Data
  const categoryMap: Record<string, number> = {};
  transactions
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      categoryMap[t.category] =
        (categoryMap[t.category] || 0) + t.amount;
    });

  const categoryData = Object.keys(categoryMap).map((key) => ({
    name: key,
    value: categoryMap[key],
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
                  key={item._id}
                  className="flex justify-between border-b border-white/10 py-2"
                >
                  <span>{item.category}</span>
                  <span className="text-rose-400">
                    ₹{item.amount}
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
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"];
  const map: any = {};

  transactions.forEach((t) => {
    const month = new Date(t.date).toLocaleString("default", {
      month: "short",
    });

    if (!map[month]) {
      map[month] = { name: month, income: 0, expense: 0 };
    }

    if (t.type === "income") map[month].income += t.amount;
    else map[month].expense += t.amount;
  });

  return months.map(
    (m) => map[m] || { name: m, income: 0, expense: 0 }
  );
}