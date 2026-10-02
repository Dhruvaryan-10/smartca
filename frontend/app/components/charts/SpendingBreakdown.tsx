"use client";

import { useState } from "react";
import type { CategoryShare } from "@/lib/summary";
import { categoryTint } from "@/lib/summary-view";
import { Money } from "../ui/Money";

const tintStyle = (rank: number, isRemainder: boolean) => {
  const tint = categoryTint(rank, isRemainder);
  return tint === null ? undefined : { backgroundColor: `color-mix(in srgb, var(--expense) ${tint}%, var(--surface))` };
};

// Where spending went: one composition bar (every category's share of
// total expenses, strongest first, in steps of expense coral; "Other" in
// neutral grey), then the ranked list it is built from. Pointing at a row
// picks out its segment. That linking is a convenience: every figure and
// share is written out in the list.
export function SpendingBreakdown({ categories, totalPaise }: { categories: CategoryShare[]; totalPaise: number }) {
  const [active, setActive] = useState<string | null>(null);

  return (
    <div>
      <p className="text-body text-foreground-secondary">
        <Money paise={totalPaise} kind="expense" className="font-medium" /> spent in total
      </p>

      <div aria-hidden="true" className="wipe-in-slow mt-4 flex h-2.5 gap-0.5 overflow-hidden rounded-pill bg-surface-sunken">
        {categories.map((c, rank) => (
          <span
            key={c.category}
            className={`h-full min-w-0.5 transition-opacity duration-(--duration-fast) ease-standard ${c.isRemainder ? "bg-foreground-muted/40" : ""} ${
              active && active !== c.category ? "opacity-30" : "opacity-100"
            }`}
            style={{ flexGrow: c.totalPaise, flexBasis: 0, ...tintStyle(rank, c.isRemainder) }}
          />
        ))}
      </div>

      <ol className="mt-5 divide-y divide-divider" onMouseLeave={() => setActive(null)}>
        {categories.map((c, rank) => (
          <li
            key={c.category}
            onMouseEnter={() => setActive(c.category)}
            className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
          >
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 shrink-0 rounded-xs ${c.isRemainder ? "bg-foreground-muted/40" : ""}`}
              style={tintStyle(rank, c.isRemainder)}
            />
            <span className="min-w-0 flex-1 truncate text-body text-foreground">{c.category}</span>
            <Money paise={c.totalPaise} className="shrink-0 text-body font-medium" />
            <span className="w-10 shrink-0 text-right font-numeric text-label text-foreground-muted">
              {c.sharePercent === 0 ? "<1%" : `${c.sharePercent}%`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
