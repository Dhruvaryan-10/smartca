"use client";
import AppShell from "../components/AppShell";
import { PageHeader } from "../components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
import { Badge } from "../components/ui/Badge";

import { useEffect, useState } from "react";

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
    <AppShell>
      <PageHeader
        title="Tax"
        description="Overview of your tax calculations"
        actions={<Badge>AY 2026-27</Badge>}
      />

      {/* CARDS */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard title="Total Income" value={`₹${totalIncome}`} color="text-success" />
        <StatCard title="Estimated Tax" value={`₹${estimatedTax}`} color="text-destructive" />
        <StatCard title="Net Income" value={`₹${netIncome}`} color="text-foreground" />
      </div>

      {/* TAX BREAKDOWN */}
      <Card>
        <CardHeader>
          <CardTitle>Tax Slabs</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <div className="flex justify-between">
            <span>0 - 2.5L</span>
            <span className="font-numeric">0%</span>
          </div>
          <div className="flex justify-between">
            <span>2.5L - 5L</span>
            <span className="font-numeric">5%</span>
          </div>
          <div className="flex justify-between">
            <span>5L - 10L</span>
            <span className="font-numeric">20%</span>
          </div>
          <div className="flex justify-between">
            <span>10L+</span>
            <span className="font-numeric">30%</span>
          </div>
        </CardContent>
      </Card>

      {/* SUMMARY BOX */}
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex justify-between text-muted-foreground">
            <span>Taxable Income</span>
            <span className="font-numeric text-foreground">₹{totalIncome}</span>
          </div>
          <div className="flex justify-between text-muted-foreground">
            <span>Estimated Tax</span>
            <span className="font-numeric text-destructive">₹{estimatedTax}</span>
          </div>
          <div className="flex justify-between font-semibold text-foreground">
            <span>Net Income</span>
            <span className="font-numeric text-success">₹{netIncome}</span>
          </div>
        </CardContent>
      </Card>
    </AppShell>
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
    <Card className="p-6">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className={`font-numeric text-2xl font-semibold mt-2 ${color}`}>{value}</p>
    </Card>
  );
}