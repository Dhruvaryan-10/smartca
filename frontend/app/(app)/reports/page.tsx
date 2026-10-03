"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatRupeesCompact } from "@/lib/format";
import { niceAxis } from "@/lib/chart";
import type { CategoryShare } from "@/lib/summary";
import LedgerTabs from "../../components/LedgerTabs";
import { AXIS_TICK, BAR_ANIMATION_MS, CURSOR_FILL, ChartLegend, GRID_STROKE, TooltipCard, TooltipRow } from "../../components/charts/chart-kit";
import { SpendingBreakdown } from "../../components/charts/SpendingBreakdown";
import { buttonClasses } from "../../components/ui/Button";
import { Money } from "../../components/ui/Money";
import { PageHeader, Section } from "../../components/ui/PageHeader";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ErrorState, Skeleton } from "../../components/ui/States";
import { usePrefersReducedMotion } from "../../components/useReducedMotion";
import { fetchTransactions } from "../../components/transactions-client";

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

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; transactions: Transaction[] };

export default function ReportsPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  // Any failure (session, server, network, malformed body) shows the error state; only a genuine `[]` is an empty report.
  useEffect(() => {
    const controller = new AbortController();
    fetchTransactions<Transaction>(controller.signal)
      .then((transactions) => setLoad({ status: "ready", transactions }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoad({ status: "error" });
      });
    return () => controller.abort();
  }, [attempt]);

  return (
    <>
      <PageHeader title="Ledger" description="Analyse your income, spending and savings." />
      <LedgerTabs />

      {load.status === "loading" && <ReportsSkeleton />}
      {load.status === "error" && (
        <ErrorState
          title="Couldn’t load your reports"
          message="Your transactions didn’t load. Check your connection and try again."
          onRetry={() => {
            setLoad({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      )}
      {load.status === "ready" && load.transactions.length === 0 && <EmptyReports />}
      {load.status === "ready" && load.transactions.length > 0 && <Report transactions={load.transactions} />}
    </>
  );
}

function Report({ transactions }: { transactions: Transaction[] }) {
  // CALCULATIONS — sum in integer paise first, convert to rupees once.
  // (Unchanged from the previous Reports page.)
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

  // MONTHLY DATA
  const monthlyData = generateMonthlyData(transactions);

  // CATEGORY DATA — sum in paise.
  const categoryMapPaise: Record<string, number> = {};

  transactions
    .filter((t) => t.type === "expense")
    .forEach((t) => {
      categoryMapPaise[t.category] =
        (categoryMapPaise[t.category] || 0) + t.amountPaise;
    });

  // Every category, largest first, with its share of total expenses (display only).
  const categories: CategoryShare[] = Object.keys(categoryMapPaise)
    .map((category) => ({
      category,
      totalPaise: categoryMapPaise[category],
      sharePercent: totalExpensePaise > 0 ? Math.round((categoryMapPaise[category] / totalExpensePaise) * 100) : 0,
      isRemainder: false,
    }))
    .sort((a, b) => b.totalPaise - a.totalPaise || a.category.localeCompare(b.category));

  const savingsPaise = totalIncomePaise - totalExpensePaise;
  const negativeRate = savingsRate.startsWith("-");

  return (
    <div className="space-y-section">
      <dl className="grid grid-cols-2 border-y border-border lg:grid-cols-4">
        <Stat label="Total income">
          <Money paise={totalIncomePaise} kind="income" />
        </Stat>
        <Stat label="Total expenses" className="border-l border-divider pl-5 sm:pl-8">
          <Money paise={totalExpensePaise} kind="expense" />
        </Stat>
        <Stat label="Savings" className="border-t border-divider lg:border-l lg:border-t-0 lg:pl-8">
          <Money paise={savingsPaise} kind="net" />
        </Stat>
        <Stat label="Savings rate" className="border-l border-t border-divider pl-5 sm:pl-8 lg:border-t-0">
          <span aria-hidden="true" className="font-numeric text-foreground">
            {negativeRate ? `−${savingsRate.slice(1)}` : savingsRate}%
          </span>
          <span className="sr-only">{negativeRate ? `minus ${savingsRate.slice(1)}` : savingsRate}%</span>
        </Stat>
      </dl>

      <MonthlySection monthlyData={monthlyData} />

      <Section title="Expense breakdown" aside={`${categories.length} ${categories.length === 1 ? "category" : "categories"}`} className="reveal">
        {categories.length > 0 ? (
          <div className="max-w-3xl">
            <SpendingBreakdown categories={categories} totalPaise={totalExpensePaise} />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-body text-foreground-secondary">No spending recorded yet. Expenses you add are broken down by category here.</p>
            <Link href="/expenses" className={buttonClasses("secondary", "sm")}>
              Add an expense
            </Link>
          </div>
        )}
      </Section>
    </div>
  );
}

function Stat({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 py-4 pr-5 sm:pr-8 ${className}`}>
      <dt className="truncate text-label text-foreground-muted">{label}</dt>
      <dd className="mt-1 text-figure font-semibold">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------
// Monthly view
// ---------------------------------------------------------------------

type MonthRow = { name: string; income: number; expense: number };
type Metric = "both" | "net";
type Display = "chart" | "table";

const toPaise = (rupees: number) => Math.round(rupees * 100);

function MonthlySection({ monthlyData }: { monthlyData: MonthRow[] }) {
  const [metric, setMetric] = useState<Metric>("both");
  const [display, setDisplay] = useState<Display>("chart");

  const busiest = useMemo(() => {
    const withSpend = monthlyData.filter((m) => m.expense > 0);
    return withSpend.length > 0 ? withSpend.reduce((a, b) => (b.expense > a.expense ? b : a)) : null;
  }, [monthlyData]);
  const bestIncome = useMemo(() => {
    const withIncome = monthlyData.filter((m) => m.income > 0);
    return withIncome.length > 0 ? withIncome.reduce((a, b) => (b.income > a.income ? b : a)) : null;
  }, [monthlyData]);

  return (
    <Section title="By calendar month" aside="All years combined" className="reveal">
      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SegmentedControl
            label="What the monthly view shows"
            stretch
            value={metric}
            onChange={setMetric}
            options={[
              { value: "both", label: "Income and expenses" },
              { value: "net", label: "Net savings" },
            ]}
          />
          <SegmentedControl
            label="Show as"
            stretch
            value={display}
            onChange={setDisplay}
            options={[
              { value: "chart", label: "Chart" },
              { value: "table", label: "Table" },
            ]}
          />
        </div>

        {(busiest || bestIncome) && (
          <p className="text-body text-foreground-secondary">
            {bestIncome && (
              <>
                Most income in <span className="font-medium text-foreground">{bestIncome.name}</span> (
                <Money paise={toPaise(bestIncome.income)} kind="income" className="font-medium" />)
              </>
            )}
            {bestIncome && busiest && "; "}
            {busiest && (
              <>
                most spending in <span className="font-medium text-foreground">{busiest.name}</span> (
                <Money paise={toPaise(busiest.expense)} kind="expense" className="font-medium" />)
              </>
            )}
            .
          </p>
        )}

        {display === "chart" ? <MonthlyChart data={monthlyData} metric={metric} /> : <MonthlyTable data={monthlyData} metric={metric} />}
      </div>
    </Section>
  );
}

function MonthlyChart({ data, metric }: { data: MonthRow[]; metric: Metric }) {
  const reduceMotion = usePrefersReducedMotion();
  const points = data.map((m) => ({ ...m, incomePaise: toPaise(m.income), expensePaise: toPaise(m.expense), netPaise: toPaise(m.income - m.expense) }));

  const axisBoth = niceAxis(Math.max(0, ...points.flatMap((p) => [p.incomePaise, p.expensePaise])));
  const maxAbsNet = Math.max(0, ...points.map((p) => Math.abs(p.netPaise)));
  const axisNet = niceAxis(maxAbsNet);
  const netTicks = [...axisNet.ticks.slice(1).reverse().map((t) => -t), ...axisNet.ticks];

  return (
    <div>
      <div className="mb-4">
        <ChartLegend
          items={
            metric === "both"
              ? [
                  { label: "Income", swatch: "bg-chart-income" },
                  { label: "Expenses", swatch: "bg-chart-expense" },
                ]
              : [
                  { label: "Saved (above the line)", swatch: "bg-chart-income" },
                  { label: "Overspent (below the line)", swatch: "bg-chart-expense" },
                ]
          }
        />
      </div>
      <div
        role="img"
        aria-label={
          metric === "both"
            ? "Bar chart of income and expenses for each calendar month. Choose Table to read the figures."
            : "Bar chart of net savings for each calendar month, above zero when saved and below when overspent. Choose Table to read the figures."
        }
        className="h-56 sm:h-72"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barGap={3} barCategoryGap="24%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="name" tickLine={false} axisLine={false} tickMargin={10} interval="preserveStartEnd" minTickGap={8} tick={AXIS_TICK} />
            <YAxis
              width={56}
              tickLine={false}
              axisLine={false}
              ticks={metric === "both" ? axisBoth.ticks : netTicks}
              domain={metric === "both" ? [0, axisBoth.max] : [-axisNet.max, axisNet.max]}
              tickFormatter={(v: number) => formatRupeesCompact(v)}
              tick={AXIS_TICK}
            />
            <Tooltip content={<MonthTooltip />} cursor={CURSOR_FILL} isAnimationActive={false} />
            {metric === "both" ? (
              <>
                <Bar dataKey="incomePaise" name="Income" fill="var(--chart-income)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={!reduceMotion} animationDuration={BAR_ANIMATION_MS} />
                <Bar dataKey="expensePaise" name="Expenses" fill="var(--chart-expense)" radius={[3, 3, 0, 0]} maxBarSize={18} isAnimationActive={!reduceMotion} animationDuration={BAR_ANIMATION_MS} />
              </>
            ) : (
              <>
                <ReferenceLine y={0} stroke="var(--border-strong)" />
                <Bar dataKey="netPaise" name="Net" radius={3} maxBarSize={24} isAnimationActive={!reduceMotion} animationDuration={BAR_ANIMATION_MS}>
                  {points.map((p) => (
                    <Cell key={p.name} fill={p.netPaise < 0 ? "var(--chart-expense)" : "var(--chart-income)"} />
                  ))}
                </Bar>
              </>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type TooltipPoint = { name: string; incomePaise: number; expensePaise: number; netPaise: number };

function MonthTooltip({ active, payload }: { active?: boolean; payload?: ReadonlyArray<{ payload?: TooltipPoint }> }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <TooltipCard title={`${point.name} · all years`}>
      <TooltipRow label="Income" swatch="bg-chart-income">
        <Money paise={point.incomePaise} kind="income" />
      </TooltipRow>
      <TooltipRow label="Expenses" swatch="bg-chart-expense">
        <Money paise={point.expensePaise} kind="expense" />
      </TooltipRow>
      <TooltipRow label="Net" divided>
        <Money paise={point.netPaise} kind="net" className="font-medium" />
      </TooltipRow>
    </TooltipCard>
  );
}

function MonthlyTable({ data, metric }: { data: MonthRow[]; metric: Metric }) {
  const totals = data.reduce(
    (acc, m) => ({ income: acc.income + toPaise(m.income), expense: acc.expense + toPaise(m.expense) }),
    { income: 0, expense: 0 },
  );
  return (
    <div className="overflow-x-auto rounded-panel border border-border bg-surface">
      <table className="w-full min-w-[22rem] text-body">
        <caption className="sr-only">Income, expenses and net savings by calendar month, all years combined</caption>
        <thead>
          <tr className="border-b border-border-strong text-label text-foreground-muted">
            <th scope="col" className="px-4 py-2.5 text-left font-medium">Month</th>
            {metric === "both" && (
              <>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Income</th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">Expenses</th>
              </>
            )}
            <th scope="col" className="px-4 py-2.5 text-right font-medium">Net</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-divider">
          {data.map((m) => {
            const empty = m.income === 0 && m.expense === 0;
            return (
              <tr key={m.name} className={empty ? "text-foreground-muted" : undefined}>
                <th scope="row" className="px-4 py-2.5 text-left font-normal">{m.name}</th>
                {metric === "both" && (
                  <>
                    <td className="px-4 py-2.5 text-right">{empty ? <span className="font-numeric">—</span> : <Money paise={toPaise(m.income)} kind="income" />}</td>
                    <td className="px-4 py-2.5 text-right">{empty ? <span className="font-numeric">—</span> : <Money paise={toPaise(m.expense)} kind="expense" />}</td>
                  </>
                )}
                <td className="px-4 py-2.5 text-right">{empty ? <span className="font-numeric">—</span> : <Money paise={toPaise(m.income - m.expense)} kind="net" />}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="rule-subtotal rule-settled font-semibold">
            <th scope="row" className="px-4 py-3 text-left">Total</th>
            {metric === "both" && (
              <>
                <td className="px-4 py-3 text-right"><Money paise={totals.income} kind="income" /></td>
                <td className="px-4 py-3 text-right"><Money paise={totals.expense} kind="expense" /></td>
              </>
            )}
            <td className="px-4 py-3 text-right"><Money paise={totals.income - totals.expense} kind="net" /></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------
// States
// ---------------------------------------------------------------------

function EmptyReports() {
  return (
    <section className="rounded-panel border border-border bg-surface px-5 py-10 text-center sm:px-10 sm:py-14">
      <h2 className="text-heading font-semibold text-foreground">Nothing to report yet</h2>
      <p className="mx-auto mt-2 max-w-md text-body text-foreground-secondary">
        Reports are built from your ledger. Record some income and expenses, or import a bank statement, and your totals, monthly pattern and spending breakdown appear here.
      </p>
      <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Link href="/income" className={buttonClasses("primary", "md")}>
          Add income
        </Link>
        <Link href="/expenses" className={buttonClasses("secondary", "md")}>
          Add an expense
        </Link>
        <Link href="/vault" className={buttonClasses("outline", "md")}>
          Import a bank statement
        </Link>
      </div>
    </section>
  );
}

function ReportsSkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-section">
      <span className="sr-only">Loading your reports…</span>
      <div className="grid grid-cols-2 gap-8 border-y border-border py-4 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-36 max-w-full" />
        ))}
      </div>
      <div>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-9 w-72 max-w-full" />
        <Skeleton className="mt-5 h-56 w-full sm:h-72" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Helper (unchanged)
// ---------------------------------------------------------------------

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
