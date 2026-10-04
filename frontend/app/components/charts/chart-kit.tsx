import type { ReactNode } from "react";

// Shared chart vocabulary for Summary and Reports, so every chart reads the
// same way: a word-labelled legend with square swatches in legend order,
// muted 12px axis ticks, a horizontal grid only, and an elevated tooltip
// card whose rows carry the same swatches. Series colours come from the
// chart tokens; colour is never the only cue (position, legend order and
// the words do the work too).

export const AXIS_TICK = { fill: "var(--foreground-muted)", fontSize: 12 } as const;
export const GRID_STROKE = "var(--chart-grid)";
export const CURSOR_FILL = { fill: "var(--surface-sunken)", radius: 6 } as const;
/** Bars grow once on first render, with the token reveal duration; never on update. */
export const BAR_ANIMATION_MS = 480;

export type LegendItem = { label: string; swatch: string };

export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-label text-foreground-muted" aria-label="Chart legend">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-xs ${item.swatch}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function TooltipCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-48 rounded-md bg-surface-elevated px-3 py-2.5 text-label shadow-floating">
      <p className="mb-1.5 font-medium text-foreground">{title}</p>
      <dl className="space-y-1">{children}</dl>
    </div>
  );
}

export function TooltipRow({ label, swatch, children, divided = false }: { label: string; swatch?: string; children: ReactNode; divided?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-6 ${divided ? "mt-1.5 border-t border-divider pt-1.5" : ""}`}>
      <dt className="flex items-center gap-1.5 text-foreground-muted">
        {swatch && <span aria-hidden="true" className={`h-2 w-2 rounded-xs ${swatch}`} />}
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
