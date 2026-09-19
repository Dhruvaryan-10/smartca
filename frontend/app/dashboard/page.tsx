"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AppShell from "../components/AppShell";
import { PageHeader, Section } from "../components/ui/PageHeader";
import { buttonClasses } from "../components/ui/Button";
import { EmptyState, ErrorState, Skeleton } from "../components/ui/States";
import { formatDate, formatRupees } from "@/lib/format";
import { summarize, type Summary, type SummaryTransaction } from "@/lib/summary";
import MonthlyChart from "./MonthlyChart";

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
    <AppShell>
      <PageHeader title="Summary" description={summary ? describeRange(summary) : "Your income, expenses and savings."} />

      {state.status === "loading" && <SummarySkeleton />}

      {state.status === "error" && (
        <ErrorState
          title="Couldn’t load your summary"
          message="Your transactions didn’t load. Check your connection and try again."
          onRetry={retry}
        />
      )}

      {summary && summary.transactionCount === 0 && (
        <EmptyState
          title="Nothing to summarise yet"
          description="Your summary is built from the income and expenses you record. Add your first entry to see totals, monthly trends and where your money goes."
          action={
            <>
              <Link href="/income" className={buttonClasses("primary", "md")}>
                Add income
              </Link>
              <Link href="/expenses" className={buttonClasses("secondary", "md")}>
                Add an expense
              </Link>
            </>
          }
        />
      )}

      {summary && summary.transactionCount > 0 && <SummaryBody summary={summary} />}
    </AppShell>
  );
}

function describeRange(summary: Summary): string {
  const noun = summary.transactionCount === 1 ? "transaction" : "transactions";
  if (!summary.range) return "Your income, expenses and savings.";
  const { from, to } = summary.range;
  const span = from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
  return `${span} · ${summary.transactionCount} ${noun}`;
}

function SummaryBody({ summary }: { summary: Summary }) {
  return (
    <div className="space-y-12">
      <Headline summary={summary} />

      <Section
        title="Income and expenses by month"
        aside={summary.monthsTruncated ? "Most recent 12 months" : undefined}
      >
        {summary.months.length >= 2 ? (
          <MonthlyChart months={summary.months} />
        ) : (
          <EmptyState
            compact
            title="Not enough history for a trend yet"
            description="Month-by-month changes appear once you have activity in two or more months."
          />
        )}
      </Section>

      <div className="grid grid-cols-1 gap-x-14 gap-y-12 lg:grid-cols-2">
        <Section title="Where your money goes">
          {summary.categories.length > 0 ? (
            <CategoryList categories={summary.categories} />
          ) : (
            <EmptyState
              compact
              title="No spending recorded"
              description="Expenses you add will be grouped by category here."
              action={
                <Link href="/expenses" className={buttonClasses("secondary", "sm")}>
                  Add an expense
                </Link>
              }
            />
          )}
        </Section>

        <Section
          title="Recent activity"
          aside={
            <Link href="/income" className="transition-colors hover:text-foreground focus-visible:outline-none focus-visible:underline">
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

// The one figure the page is about, then the two that explain it. Size
// and position do the ranking — no card, no tint, no per-figure colour.
function Headline({ summary }: { summary: Summary }) {
  const { savingsPaise, incomePaise, expensePaise, savingsRatePercent } = summary;
  const overspent = savingsPaise < 0;

  return (
    <section aria-label="Totals">
      <p className="text-[13px] font-medium text-muted-foreground">Savings</p>
      <p
        className={`mt-1 font-numeric text-[clamp(2.5rem,7vw,3.75rem)] font-semibold leading-none tracking-[-0.035em] ${
          overspent ? "text-destructive" : "text-foreground"
        }`}
      >
        {formatRupees(savingsPaise)}
      </p>
      <p className="mt-3 text-sm text-muted-foreground">{savingsCaption(savingsPaise, savingsRatePercent, incomePaise)}</p>

      <dl className="mt-8 grid grid-cols-2 border-t border-border">
        <Figure label="Income" paise={incomePaise} />
        <Figure label="Expenses" paise={expensePaise} divided />
      </dl>
    </section>
  );
}

function Figure({ label, paise, divided = false }: { label: string; paise: number; divided?: boolean }) {
  return (
    <div className={`pt-4 ${divided ? "border-l border-border pl-5 sm:pl-8" : "pr-5 sm:pr-8"}`}>
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-numeric text-[22px] font-semibold tracking-[-0.02em] text-foreground sm:text-2xl">
        {formatRupees(paise)}
      </dd>
    </div>
  );
}

function savingsCaption(savingsPaise: number, ratePercent: number | null, incomePaise: number): string {
  if (incomePaise === 0) return "No income recorded yet, so there’s no savings rate to show.";
  if (savingsPaise < 0) return `You’ve spent ${formatRupees(-savingsPaise)} more than you’ve earned.`;
  if (savingsPaise === 0) return "Your expenses match your income.";
  return `You’ve kept ${ratePercent}% of your income.`;
}

function CategoryList({ categories }: { categories: Summary["categories"] }) {
  return (
    <ul>
      {categories.map((c) => (
        <li key={c.category} className="border-b border-border py-3 first:pt-0 last:border-0">
          <div className="flex items-baseline justify-between gap-4">
            <span className="min-w-0 truncate text-sm text-foreground">{c.category}</span>
            <span className="shrink-0 font-numeric text-sm text-foreground">
              {formatRupees(c.totalPaise)}
              <span className="ml-2 inline-block w-9 text-right text-[13px] text-muted-foreground">
                {c.sharePercent === 0 ? "<1%" : `${c.sharePercent}%`}
              </span>
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-inset" aria-hidden="true">
            <div
              className={`bar-grow h-full rounded-full ${c.isRemainder ? "bg-muted-foreground/50" : "bg-foreground/70"}`}
              style={{ width: `${Math.max(c.sharePercent, 1)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function RecentActivity({ items }: { items: SummaryTransaction[] }) {
  return (
    <ul>
      {items.map((t) => {
        const isIncome = t.type === "income";
        const description = t.description?.trim() ?? "";
        // A description that just repeats the category adds nothing — show the date alone.
        const hasDistinctDescription = description !== "" && description.toLowerCase() !== t.category.toLowerCase();
        const title = hasDistinctDescription ? description : t.category;
        const detail = hasDistinctDescription ? `${t.category} · ${formatDate(t.occurredOn)}` : formatDate(t.occurredOn);
        return (
          <li key={t.id} className="flex items-baseline justify-between gap-4 border-b border-border py-3 first:pt-0 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">{title}</p>
              <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{detail}</p>
            </div>
            {/* Sign carries direction; colour only confirms it for income. */}
            <span className={`shrink-0 font-numeric text-sm ${isIncome ? "text-success" : "text-foreground"}`}>
              {isIncome ? formatRupees(t.amountPaise, { showPositiveSign: true }) : formatRupees(-t.amountPaise)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// Same silhouette as the loaded page, so nothing jumps when data lands.
function SummarySkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-12">
      <span className="sr-only">Loading your summary…</span>
      <div>
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="mt-3 h-14 w-64 max-w-full" />
        <Skeleton className="mt-4 h-4 w-56 max-w-full" />
        <div className="mt-8 grid grid-cols-2 gap-8 border-t border-border pt-4">
          <Skeleton className="h-10 w-36 max-w-full" />
          <Skeleton className="h-10 w-36 max-w-full" />
        </div>
      </div>
      <div>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-4 h-60 w-full" />
      </div>
    </div>
  );
}
