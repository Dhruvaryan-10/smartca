"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Navbar from "../components/Navbar";
import Sidebar from "../components/Sidebar";

export default function IncomePage() {
  const [transactions, setTransactions] = useState<any[]>([]);

  // FORM STATE
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Job");
  const [description, setDescription] = useState("");

  // FETCH INCOME DATA
  const fetchIncome = async () => {
    const res = await fetch("/api/transactions");
    const data = await res.json();

    const incomeOnly = data.filter((t: any) => t.type === "income");
    setTransactions(incomeOnly);
  };

  useEffect(() => {
    fetchIncome();
  }, []);

  // ADD INCOME FUNCTION
  const handleAddIncome = async () => {
    if (!amount) return alert("Enter amount");

    const res = await fetch("/api/transactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "income",
        amount: Number(amount),
        category,
        date: new Date(),
      }),
    });

    if (res.ok) {
      setTitle("");
      setAmount("");
      setCategory("Job");
      setDescription("");

      fetchIncome(); // refresh data
    } else {
      alert("Failed to add income");
    }
  };

  // CALCULATIONS
  const totalIncome = transactions.reduce(
    (sum, t) => sum + t.amount,
    0
  );

  return (
    <div className="flex min-h-screen bg-[#020617] text-white">

      {/* SIDEBAR */}
      <Sidebar />

      <div className="flex-1">

        {/* NAVBAR */}
        <Navbar />

        <main className="p-6 flex gap-6">

          {/* LEFT FORM */}
          <div className="flex-1 bg-white/5 border border-white/10 p-6 rounded-2xl">

            <h2 className="text-xl font-semibold mb-6">
              Add New Income
            </h2>

            {/* TITLE */}
            <div className="mb-4">
              <label className="text-sm text-slate-400">Title</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Salary"
                className="w-full mt-1 p-2 rounded bg-black/50 border border-white/10"
              />
            </div>

            {/* AMOUNT */}
            <div className="mb-4">
              <label className="text-sm text-slate-400">Amount</label>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="₹5000"
                className="w-full mt-1 p-2 rounded bg-black/50 border border-white/10"
              />
            </div>

            {/* CATEGORY */}
            <div className="mb-4">
              <label className="text-sm text-slate-400">Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full mt-1 p-2 rounded bg-black/50 border border-white/10"
              >
                <option>Job</option>
                <option>Freelance</option>
                <option>Bonus</option>
              </select>
            </div>

            {/* DESCRIPTION */}
            <div className="mb-6">
              <label className="text-sm text-slate-400">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Monthly Salary"
                className="w-full mt-1 p-2 rounded bg-black/50 border border-white/10"
              />
            </div>

            <button
              onClick={handleAddIncome}
              className="bg-teal-400 text-black px-4 py-2 rounded-lg"
            >
              + Add Income
            </button>
          </div>

          {/* RIGHT PANEL */}
          <div className="w-80 space-y-6">

            {/* SUMMARY */}
            <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
              <h3 className="mb-4">Income Summary</h3>

              <p className="text-slate-400 text-sm">Monthly</p>
              <p className="text-green-400 text-xl">₹{totalIncome}</p>

              <p className="text-slate-400 text-sm mt-4">Yearly</p>
              <p className="text-green-400 text-xl">
                ₹{totalIncome * 12}
              </p>
            </div>

            {/* RECENT */}
            <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
              <h3 className="mb-4">Recent Income</h3>

              {transactions.length === 0 ? (
                <p className="text-slate-400">No income yet</p>
              ) : (
                transactions.slice(0, 5).map((t) => (
                  <div
                    key={t._id}
                    className="flex justify-between border-b border-white/10 py-2"
                  >
                    <span>{t.category}</span>
                    <span className="text-green-400">
                      ₹{t.amount}
                    </span>
                  </div>
                ))
              )}
            </div>

          </div>

        </main>
      </div>
    </div>
  );
}

/* ---------------- UI COMPONENTS ---------------- */

