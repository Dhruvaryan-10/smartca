"use client";
import Navbar from "../components/Navbar";
import Sidebar from "../components/Sidebar";

import { useEffect, useState } from "react";
import Link from "next/link";

// Shape returned by GET /api/transactions (services/transactions.ts —
// Postgres/Drizzle rows, not the old Mongo shape). Money is integer
// paise on the wire, per the schema's money convention.
type Transaction = {
  id: string;
  type: "income" | "expense";
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string;
};

export default function TaxesPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // 🔹 Fetch data
  useEffect(() => {
    fetch("/api/transactions")
      .then((res) => res.json())
      .then((data) => setTransactions(Array.isArray(data) ? data : []))
      .catch(console.error);
  }, []);

  // 🔹 Total Income — sum in integer paise first, convert to rupees
  // once, since calculateTax() below expects a rupee amount and is
  // otherwise left exactly as it was (tax-engine work is a later phase).
  const totalIncomePaise = transactions
    .filter((t) => t.type === "income")
    .reduce((acc, t) => acc + t.amountPaise, 0);
  const totalIncome = totalIncomePaise / 100;

  // 🔹 Tax Calculation
  const calculateTax = (income: number) => {
    let tax = 0;

    if (income <= 250000) {
      tax = 0;
    } else if (income <= 500000) {
      tax = (income - 250000) * 0.05;
    } else if (income <= 1000000) {
      tax =
        250000 * 0.05 +
        (income - 500000) * 0.2;
    } else {
      tax =
        250000 * 0.05 +
        500000 * 0.2 +
        (income - 1000000) * 0.3;
    }

    return tax;
  };

  const estimatedTax = calculateTax(totalIncome);
  const netIncome = totalIncome - estimatedTax;

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
              Tax Summary
            </h1>
            <p className="text-slate-400">
              Overview of your tax calculations
            </p>
          </div>

          {/* CARDS */}
          <div className="grid grid-cols-3 gap-6">
            <StatCard title="Total Income" value={`₹${totalIncome}`} color="from-green-500 to-emerald-600" />
            <StatCard title="Estimated Tax" value={`₹${estimatedTax}`} color="from-pink-500 to-rose-600" />
            <StatCard title="Net Income" value={`₹${netIncome}`} color="from-blue-500 to-indigo-600" />
          </div>

          {/* TAX BREAKDOWN */}
          <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">

            <h3 className="text-teal-400 mb-4">
              Tax Slabs
            </h3>

            <div className="space-y-2 text-slate-300">

              <div className="flex justify-between">
                <span>0 - 2.5L</span>
                <span>0%</span>
              </div>

              <div className="flex justify-between">
                <span>2.5L - 5L</span>
                <span>5%</span>
              </div>

              <div className="flex justify-between">
                <span>5L - 10L</span>
                <span>20%</span>
              </div>

              <div className="flex justify-between">
                <span>10L+</span>
                <span>30%</span>
              </div>

            </div>
          </div>

          {/* SUMMARY BOX */}
          <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">

            <h3 className="text-teal-400 mb-4">
              Summary
            </h3>

            <div className="space-y-3 text-slate-300">

              <div className="flex justify-between">
                <span>Taxable Income</span>
                <span>₹{totalIncome}</span>
              </div>

              <div className="flex justify-between">
                <span>Estimated Tax</span>
                <span className="text-rose-400">
                  ₹{estimatedTax}
                </span>
              </div>

              <div className="flex justify-between font-semibold">
                <span>Net Income</span>
                <span className="text-green-400">
                  ₹{netIncome}
                </span>
              </div>

            </div>
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
    <div className={`bg-gradient-to-br ${color} p-6 rounded-2xl`}>
      <p className="text-sm">{title}</p>
      <h2 className="text-2xl font-bold mt-2">{value}</h2>
    </div>
  );
}