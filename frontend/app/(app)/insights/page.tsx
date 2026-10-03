"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { generateInsights, type InsightTransaction } from "@/lib/insights";
import { PageHeader } from "../../components/ui/PageHeader";
import { buttonClasses } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { IconAsk, IconSummary } from "../../components/ui/Icons";
import { ErrorState, Skeleton } from "../../components/ui/States";
import { fetchTransactions } from "../../components/transactions-client";

// Rows from GET /api/transactions (services/transactions.ts). Money is integer paise on the wire; the rules live in
// lib/insights.ts.
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; transactions: InsightTransaction[] };

export default function InsightsPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchTransactions<InsightTransaction>(controller.signal)
      .then((transactions) => setLoad({ status: "ready", transactions }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoad({ status: "error" });
      });
    return () => controller.abort();
  }, [attempt]);

  const insights = load.status === "ready" ? generateInsights(load.transactions) : [];

  return (
    <>
      <PageHeader title="Ask" description="Rule-based suggestions based on your spending patterns." />

      <div className="flex flex-col gap-4 rounded-panel border border-border bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-pill bg-assistant-soft text-assistant">
            <IconAsk />
          </span>
          <div>
            <p className="text-body font-medium text-foreground">Have a specific question?</p>
            <p className="mt-0.5 text-label text-foreground-muted">
              These tips follow fixed rules. Ask SmartCA (the button in the corner) answers questions about your money and tax, with sources.
            </p>
          </div>
        </div>
      </div>

      {load.status === "loading" && (
        <div role="status" aria-live="polite" className="space-y-3">
          <span className="sr-only">Generating insights…</span>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-panel" />
          ))}
        </div>
      )}

      {load.status === "error" && (
        <ErrorState
          title="Couldn’t load your insights"
          message="Your transactions didn’t load. Check your connection and try again."
          onRetry={() => {
            setLoad({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      )}

      {load.status === "ready" &&
        (insights.length === 0 ? (
          <section className="rounded-panel border border-dashed border-border px-5 py-10 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-pill bg-surface-sunken text-foreground-secondary">
              <IconSummary />
            </span>
            <p className="mt-4 text-body font-medium text-foreground">Add transactions to unlock insights.</p>
            <div className="mt-5 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/income" className={buttonClasses("primary", "md")}>
                Add income
              </Link>
              <Link href="/expenses" className={buttonClasses("secondary", "md")}>
                Add an expense
              </Link>
            </div>
          </section>
        ) : (
          <ul className="divide-y divide-divider rounded-panel border border-border bg-surface">
            {insights.map((insight, index) => (
              <InsightRow key={index} text={insight} />
            ))}
          </ul>
        ))}
    </>
  );
}

// The rules above mark each tip with a leading symbol. The interface shows
// that meaning as a worded tone (and a matching edge) instead of the emoji.
const TONES: Record<string, { label: string; tone: "warning" | "success" | "info"; edge: string }> = {
  "⚠️": { label: "Watch", tone: "warning", edge: "border-l-warning" },
  "🚨": { label: "Watch", tone: "warning", edge: "border-l-warning" },
  "👍": { label: "Good", tone: "success", edge: "border-l-success" },
  "🔥": { label: "Good", tone: "success", edge: "border-l-success" },
};
const DEFAULT_TONE = { label: "Tip", tone: "info" as const, edge: "border-l-info" };

function splitInsight(text: string): { symbol: string; body: string } {
  const match = /^(\p{Extended_Pictographic}️?)\s*/u.exec(text);
  return match ? { symbol: match[1], body: text.slice(match[0].length) } : { symbol: "", body: text };
}

function InsightRow({ text }: { text: string }) {
  const { symbol, body } = splitInsight(text);
  const tone = TONES[symbol] ?? DEFAULT_TONE;
  return (
    <li className={`flex items-start gap-3 border-l-2 px-5 py-4 first:rounded-tl-panel last:rounded-bl-panel ${tone.edge}`}>
      <Badge tone={tone.tone} className="mt-0.5 shrink-0">
        {tone.label}
      </Badge>
      <p className="text-body text-foreground">{body}</p>
    </li>
  );
}
