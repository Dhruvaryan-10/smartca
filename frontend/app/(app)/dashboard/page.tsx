"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeader, Section } from "../../components/ui/PageHeader";
import { buttonClasses } from "../../components/ui/Button";
import { ErrorState, Skeleton } from "../../components/ui/States";
import { formatDate } from "@/lib/format";
import { summarize, type Summary, type SummaryTransaction } from "@/lib/summary";
import { GetStarted } from "./GetStarted";
import MonthlyChart, { MonthHighlight } from "./MonthlyChart";
import { RecentActivity } from "./RecentActivity";
import { SpendingBreakdown } from "../../components/charts/SpendingBreakdown";
import { SummaryHero } from "./SummaryHero";

// Shape returned by GET /api/transactions (services/transactions.ts).
// Money is integer paise on the wire and stays paise until it is rendered
// through formatRupees — nothing on this page converts to floating-point
// rupees.
type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; transactions: SummaryTransaction[] };

export default function Dashboard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/transactions", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Request failed with ${res.status}`);
        const data: unknown = await res.json();
        if (!Array.isArray(data)) throw new Error("Unexpected response shape");
        setState({ status: "ready", transactions: data as SummaryTransaction[] });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.warn("Summary: could not load transactions", err);
        setState({ status: "error" });
      });

    return () => controller.abort();
  }, [attempt]);

  const retry = () => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  const summary = useMemo(
    () => (state.status === "ready" ? summarize(state.transactions) : null),
    [state],
  );

  return (
    <>
      <PageHeader title="Summary" description={summary ? describeRange(summary) : "Your income, expenses and savings."} />

      {state.status === "loading" && <SummarySkeleton />}

      {state.status === "error" && (
        <ErrorState
          title="Couldn’t load your summary"
          message="Your transactions didn’t load. Check your connection and try again."
          onRetry={retry}
        />
      )}

      {summary && summary.transactionCount === 0 && <GetStarted />}

      {summary && summary.transactionCount > 0 && <SummaryBody summary={summary} />}
    </>
  );
}

function describeRange(summary: Summary): string {
  const noun = summary.transactionCount === 1 ? "transaction" : "transactions";
  if (!summary.range) return "Your income, expenses and savings.";
  const { from, to } = summary.range;
  const span = from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
  return `${span} · ${summary.transactionCount} ${noun}`;
}

// The answer first (net savings and what it is made of), then the
// working: the month-by-month record, where spending went, and the
// latest entries. Sections below the hero settle in as they scroll into
// view (globals.css `.reveal`; static under reduced motion).
function SummaryBody({ summary }: { summary: Summary }) {
  return (
    <div className="space-y-section">
      <SummaryHero summary={summary} />

      <Section
        title="Income and expenses by month"
        aside={summary.monthsTruncated ? "Most recent 12 months" : undefined}
        className="reveal"
      >
        <div className="space-y-5">
          <MonthHighlight months={summary.months} />
          {summary.months.length >= 2 ? (
            <MonthlyChart months={summary.months} />
          ) : (
            <p className="text-label text-foreground-muted">
              A month-by-month comparison appears once you have activity in two or more months.
            </p>
          )}
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-x-16 gap-y-section lg:grid-cols-2">
        <Section title="Where your money goes" className="reveal">
          {summary.categories.length > 0 ? (
            <SpendingBreakdown categories={summary.categories} totalPaise={summary.expensePaise} />
          ) : (
            <div className="space-y-4">
              <p className="text-body text-foreground-secondary">
                No spending recorded yet. Expenses you add are grouped by category here, largest first.
              </p>
              <Link href="/expenses" className={buttonClasses("secondary", "sm")}>
                Add an expense
              </Link>
            </div>
          )}
        </Section>

        <Section
          title="Recent activity"
          className="reveal"
          aside={
            <Link
              href="/income"
              className="rounded-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:focus-ring"
            >
              Open ledger
            </Link>
          }
        >
          <RecentActivity items={summary.recent} />
        </Section>
      </div>
    </div>
  );
}

// Same silhouette as the loaded page, so nothing jumps when data lands.
function SummarySkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-section">
      <span className="sr-only">Loading your summary…</span>
      <div className="space-y-10">
        <div className="grid gap-10 lg:grid-cols-12 lg:items-end lg:gap-16">
          <div className="lg:col-span-6">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-3 h-14 w-64 max-w-full" />
            <Skeleton className="mt-4 h-4 w-56 max-w-full" />
          </div>
          <div className="lg:col-span-6">
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="mt-4 h-3 w-full rounded-pill" />
            <Skeleton className="mt-3 h-4 w-48" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-8 border-t border-border pt-4 sm:grid-cols-3">
          <Skeleton className="h-12 w-36 max-w-full" />
          <Skeleton className="h-12 w-36 max-w-full" />
          <Skeleton className="hidden h-12 w-24 sm:block" />
        </div>
      </div>
      <div>
        <Skeleton className="h-4 w-56" />
        <Skeleton className="mt-5 h-56 w-full sm:h-64" />
      </div>
    </div>
  );
}
