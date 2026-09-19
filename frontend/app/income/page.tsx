"use client";

import { useEffect, useState } from "react";
import AppShell from "../components/AppShell";
import LedgerTabs from "../components/LedgerTabs";
import { PageHeader } from "../components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input, Select, Label } from "../components/ui/Input";

// Shape returned by GET /api/transactions (services/transactions.ts —
// Postgres/Drizzle rows, not the old Mongo shape). Money is integer
// paise on the wire, per the schema's money convention; convert to
// rupees only for display, here at the UI boundary.
type Transaction = {
  id: string;
  type: "income" | "expense";
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string;
};

export default function IncomePage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // FORM STATE
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Job");
  const [description, setDescription] = useState("");

  // FETCH INCOME DATA
  const fetchIncome = async () => {
    const res = await fetch("/api/transactions");
    const data = await res.json();

    const incomeOnly = (Array.isArray(data) ? data : []).filter(
      (t: Transaction) => t.type === "income"
    );
    setTransactions(incomeOnly);
  };

  useEffect(() => {
    fetchIncome();
  }, []);

  // ADD INCOME FUNCTION
  const handleAddIncome = async () => {
    if (!amount) return alert("Enter amount");

    // The form collects rupees (placeholder "₹5000"); the API/service
    // contract is integer paise (₹1 = 100 paise) — convert here, at the
    // UI boundary, per the schema's money convention.
    const amountPaise = Math.round(Number(amount) * 100);
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      alert("Enter a valid amount");
      return;
    }

    const res = await fetch("/api/transactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "income",
        amountPaise,
        category,
        description: description || title || null,
        occurredOn: new Date().toISOString().slice(0, 10),
      }),
    });

    if (res.ok) {
      setTitle("");
      setAmount("");
      setCategory("Job");
      setDescription("");

      fetchIncome(); // refresh data
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Failed to add income");
    }
  };

  // CALCULATIONS
  const totalIncome =
    transactions.reduce((sum, t) => sum + t.amountPaise, 0) / 100;

  return (
    <AppShell>
      <PageHeader title="Ledger" description="Track income, expenses and view reports." />
      <LedgerTabs />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* LEFT FORM */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Add New Income</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="income-title">Title</Label>
              <Input id="income-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Salary" />
            </div>

            <div>
              <Label htmlFor="income-amount">Amount</Label>
              <Input
                id="income-amount"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="₹5000"
                inputMode="decimal"
              />
            </div>

            <div>
              <Label htmlFor="income-category">Category</Label>
              <Select id="income-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option>Job</option>
                <option>Freelance</option>
                <option>Bonus</option>
              </Select>
            </div>

            <div>
              <Label htmlFor="income-description">Description</Label>
              <Input
                id="income-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Monthly Salary"
              />
            </div>

            <Button onClick={handleAddIncome}>+ Add Income</Button>
          </CardContent>
        </Card>

        {/* RIGHT PANEL */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Income Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <p className="text-sm text-muted-foreground">Monthly</p>
                <p className="font-numeric text-xl font-semibold text-success">₹{totalIncome}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Yearly</p>
                <p className="font-numeric text-xl font-semibold text-success">₹{totalIncome * 12}</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Income</CardTitle>
            </CardHeader>
            <CardContent>
              {transactions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No income yet</p>
              ) : (
                <ul>
                  {transactions.slice(0, 5).map((t) => (
                    <li key={t.id} className="flex justify-between border-b border-border py-2 text-sm last:border-0">
                      <span>{t.category}</span>
                      <span className="font-numeric text-success">₹{t.amountPaise / 100}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

