"use client";

import { useEffect, useState } from "react";
import AppShell from "../components/AppShell";
import LedgerTabs from "../components/LedgerTabs";
import { PageHeader } from "../components/ui/PageHeader";
import { Card, CardHeader, CardTitle, CardContent } from "../components/ui/Card";
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

const COLORS = ["#14b8a6", "#6366f1", "#ec4899", "#f59e0b", "#ef4444"];

const paiseToRupees = (paise: number) => paise / 100;

export default function ReportsPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  // ✅ FETCH DATA
  useEffect(() => {
    fetch("/api/transactions")
      .then((res) => res.json())
      .then((data) => setTransactions(Array.isArray(data) ? data : []))
      .catch(console.error);
  }, []);

  // ✅ CALCULATIONS — sum in integer paise first, convert to rupees once.
  const totalIncomePaise = transactions
    .filter((t) => t.type === "income")
    .reduce((a, t) => a + t.amountPaise, 0);

  const totalExpensePaise = transactions
    .filter((t) => t.type === "expense")
    .reduce((a, t) => a + t.amountPaise, 0);

  const totalIncome = paiseToRupees(totalIncomePaise);
  const totalExpense = paiseToRupees(totalExpensePaise);
  const savings = totalIncome - totalExpense;

  // totalIncome > 0 already guards the zero/empty case, but a defensive
  // Number.isFinite check ensures this can never render "NaN%" even if
  // an unexpected non-numeric value slips through.
  const savingsRate =
    totalIncome > 0 && Number.isFinite(savings / totalIncome)
      ? ((savings / totalIncome) * 100).toFixed(1)
      : "0";

  // ✅ MONTHLY DATA
  const monthlyData = generateMonthlyData(transactions);

  // ✅ CATEGORY DATA — sum in paise, convert to rupees only for the chart.
  const categoryMapPaise: Record<string, number> = {};

  transactions
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      categoryMapPaise[t.category] =
        (categoryMapPaise[t.category] || 0) + t.amountPaise;
    });

  const categoryData = Object.keys(categoryMapPaise).map((k) => ({
    name: k,
    value: paiseToRupees(categoryMapPaise[k]),
  }));

  return (
    <AppShell>
      <PageHeader title="Ledger" description="Analyze your financial performance." />
      <LedgerTabs />

      {/* STATS */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard title="Total Income" value={`₹${totalIncome}`} color="text-success" />
        <StatCard title="Total Expense" value={`₹${totalExpense}`} color="text-destructive" />
        <StatCard title="Savings" value={`₹${savings}`} color="text-foreground" />
        <StatCard title="Savings Rate" value={`${savingsRate}%`} color="text-primary" />
      </div>

      {/* MONTHLY TREND */}
      <Card>
        <CardHeader>
          <CardTitle>Monthly Trends</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={monthlyData}>
              <XAxis dataKey="name" stroke="var(--muted-foreground)" fontSize={12} />
              <YAxis stroke="var(--muted-foreground)" fontSize={12} />
              <Tooltip />
              <Line dataKey="income" stroke="var(--success)" strokeWidth={2} dot={false} />
              <Line dataKey="expense" stroke="var(--destructive)" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* EXPENSE BREAKDOWN */}
      <Card>
        <CardHeader>
          <CardTitle>Expense Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={categoryData} dataKey="value" nameKey="name">
                {categoryData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
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
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className={`font-numeric text-2xl font-semibold ${color}`}>{value}</p>
    </Card>
  );
}

/* ---------------- HELPER ---------------- */

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
  // month's totals. Indexing sidesteps that entirely.
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