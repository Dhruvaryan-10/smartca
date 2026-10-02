"use client";

import { useState } from "react";
import type { CategoryShare } from "@/lib/summary";
import { categoryTint, donutSegments } from "@/lib/summary-view";
import { formatRupees, formatRupeesCompact } from "@/lib/format";
import { Money } from "../ui/Money";

type Tone = "expense" | "income";

const tintStyle = (tone: Tone, rank: number, isRemainder: boolean) => {
  const tint = categoryTint(rank, isRemainder);
  return tint === null ? undefined : { backgroundColor: `color-mix(in srgb, var(--${tone}) ${tint}%, var(--surface))` };
};
const strokeOf = (tone: Tone, rank: number, isRemainder: boolean) => {
  const tint = categoryTint(rank, isRemainder);
  return tint === null ? "color-mix(in srgb, var(--foreground-muted) 40%, var(--surface))" : `color-mix(in srgb, var(--${tone}) ${tint}%, var(--surface))`;
};

// A part-to-whole breakdown of real ledger figures: every category's share of the total, strongest first, in steps of one
// semantic colour (expense coral or income green; "Other" in neutral grey), then the ranked list it is built from. The list is
// always present and carries every exact figure and share, so the chart is never the only place a number lives. Pointing at
// a row picks out its segment.
//
// chart="bar"   one composition bar above the list (Reports, the landing page)
// chart="donut" a donut beside the list, the total at its centre (Summary)
export function CompositionBreakdown({
  categories,
  totalPaise,
  tone,
  totalLabel,
  chart = "bar",
}: {
  categories: CategoryShare[];
  totalPaise: number;
  tone: Tone;
  totalLabel: string;
  chart?: "bar" | "donut";
}) {
  const [active, setActive] = useState<string | null>(null);
  const dim = (category: string) => (active && active !== category ? "opacity-30" : "opacity-100");

  const list = (
    <ol className={`divide-y divide-divider ${chart === "bar" ? "mt-5" : ""}`} onMouseLeave={() => setActive(null)}>
      {categories.map((c, rank) => (
        <li key={c.category} onMouseEnter={() => setActive(c.category)} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <span
            aria-hidden="true"
            className={`h-2.5 w-2.5 shrink-0 rounded-xs ${c.isRemainder ? "bg-foreground-muted/40" : ""}`}
            style={tintStyle(tone, rank, c.isRemainder)}
          />
          <span className="min-w-0 flex-1 truncate text-body text-foreground">{c.category}</span>
          <Money paise={c.totalPaise} className="shrink-0 text-body font-medium" />
          <span className="w-10 shrink-0 text-right font-numeric text-label text-foreground-muted">
            {c.sharePercent === 0 ? "<1%" : `${c.sharePercent}%`}
          </span>
        </li>
      ))}
    </ol>
  );

  if (chart === "donut") {
    const segments = donutSegments(categories.map((c) => c.totalPaise));
    const radius = 42;
    const circumference = 2 * Math.PI * radius;
    const summary = categories.map((c) => `${c.category} ${c.sharePercent === 0 ? "under 1" : c.sharePercent}%`).join(", ");
    return (
      <div className="grid items-center gap-6 sm:grid-cols-[10.5rem_minmax(0,1fr)] sm:gap-8">
        <figure className="mx-auto w-40 sm:w-full">
          <div role="img" aria-label={`${formatRupees(totalPaise)} ${totalLabel}: ${summary}.`} className="relative">
            <svg viewBox="0 0 100 100" className="donut-enter block w-full -rotate-90" aria-hidden="true">
              <circle cx="50" cy="50" r={radius} fill="none" stroke="var(--surface-sunken)" strokeWidth="10" />
              {categories.map((c, rank) => (
                <circle
                  key={c.category}
                  cx="50"
                  cy="50"
                  r={radius}
                  fill="none"
                  stroke={strokeOf(tone, rank, c.isRemainder)}
                  strokeWidth="10"
                  strokeDasharray={`${segments[rank].length * circumference} ${circumference}`}
                  strokeDashoffset={-segments[rank].start * circumference}
                  className={`transition-opacity duration-(--duration-fast) ease-standard ${dim(c.category)}`}
                  onMouseEnter={() => setActive(c.category)}
                  onMouseLeave={() => setActive(null)}
                />
              ))}
            </svg>
            <div aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className={`font-numeric text-subheading font-semibold ${tone === "income" ? "text-income" : "text-expense"}`}>
                {formatRupeesCompact(totalPaise)}
              </span>
              <span className="text-micro text-foreground-muted">{totalLabel}</span>
            </div>
          </div>
        </figure>
        <div className="min-w-0">
          <p className="mb-4 text-body text-foreground-secondary">
            <Money paise={totalPaise} kind={tone} className="font-medium" /> {totalLabel} in total
          </p>
          {list}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-body text-foreground-secondary">
        <Money paise={totalPaise} kind={tone} className="font-medium" /> {totalLabel} in total
      </p>

      <div aria-hidden="true" className="wipe-in-slow mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-pill bg-surface-sunken">
        {categories.map((c, rank) => (
          <span
            key={c.category}
            className={`h-full min-w-0.5 transition-opacity duration-(--duration-fast) ease-standard ${c.isRemainder ? "bg-foreground-muted/40" : ""} ${dim(c.category)}`}
            style={{ flexGrow: c.totalPaise, flexBasis: 0, ...tintStyle(tone, rank, c.isRemainder) }}
          />
        ))}
      </div>

      {list}
    </div>
  );
}

// Where spending went (Reports, the landing page): the bar composition in expense coral.
export function SpendingBreakdown({ categories, totalPaise }: { categories: CategoryShare[]; totalPaise: number }) {
  return <CompositionBreakdown categories={categories} totalPaise={totalPaise} tone="expense" totalLabel="spent" />;
}
