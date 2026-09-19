"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMonthLabel, formatRupees, formatRupeesCompact } from "@/lib/format";
import { niceAxis } from "@/lib/chart";
import type { MonthBucket } from "@/lib/summary";
import { usePrefersReducedMotion } from "../components/useReducedMotion";

type Point = {
  key: string;
  label: string;
  incomePaise: number;
  expensePaise: number;
};

// The chart answers one question: how has what I earn and what I spend
// changed over time? Two lines, neutral ink, told apart by tone AND dash
// (never colour alone). No fills, no gradients, no dots until hover.
const INCOME_STROKE = "var(--foreground)";
const EXPENSE_STROKE = "var(--muted-foreground)";

export default function MonthlyChart({ months }: { months: MonthBucket[] }) {
  const reduceMotion = usePrefersReducedMotion();

  // Years only appear on the axis when the window actually crosses one.
  const spansYears = new Set(months.map((m) => m.key.slice(0, 4))).size > 1;
  const data: Point[] = months.map((m) => ({
    key: m.key,
    label: formatMonthLabel(m.key, spansYears),
    incomePaise: m.incomePaise,
    expensePaise: m.expensePaise,
  }));

  const axis = niceAxis(Math.max(0, ...months.flatMap((m) => [m.incomePaise, m.expensePaise])));

  return (
    <div>
      <ul className="mb-3 flex items-center gap-5 text-[13px] text-muted-foreground" aria-label="Chart legend">
        <li className="flex items-center gap-2">
          <svg width="18" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="18" y2="1" stroke={INCOME_STROKE} strokeWidth="2" />
          </svg>
          Income
        </li>
        <li className="flex items-center gap-2">
          <svg width="18" height="2" aria-hidden="true">
            <line x1="0" y1="1" x2="18" y2="1" stroke={EXPENSE_STROKE} strokeWidth="2" strokeDasharray="4 3" />
          </svg>
          Expenses
        </li>
      </ul>

      {/* The SVG is not readable by assistive tech; the table below is. */}
      <div role="img" aria-label="Line chart of monthly income and expenses. The same figures are listed in the table that follows.">
        <ResponsiveContainer width="100%" height={248}>
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              interval="equidistantPreserveStart"
              minTickGap={16}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            />
            <YAxis
              width={56}
              tickLine={false}
              axisLine={false}
              ticks={axis.ticks}
              domain={[0, axis.max]}
              tickFormatter={(v: number) => formatRupeesCompact(v)}
              tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            />
            <Tooltip
              content={<MonthTooltip />}
              cursor={{ stroke: "var(--field-border)", strokeWidth: 1 }}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="incomePaise"
              name="Income"
              stroke={INCOME_STROKE}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: INCOME_STROKE }}
              isAnimationActive={!reduceMotion}
              animationDuration={500}
              animationEasing="ease-out"
            />
            <Line
              type="linear"
              dataKey="expensePaise"
              name="Expenses"
              stroke={EXPENSE_STROKE}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: EXPENSE_STROKE }}
              isAnimationActive={!reduceMotion}
              animationDuration={500}
              animationEasing="ease-out"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <table className="sr-only">
        <caption>Income and expenses by month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Income</th>
            <th scope="col">Expenses</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.key}>
              <th scope="row">{formatMonthLabel(m.key, true)}</th>
              <td>{formatRupees(m.incomePaise)}</td>
              <td>{formatRupees(m.expensePaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Recharts injects `active` and `payload` when it renders the tooltip.
function MonthTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Point }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const netPaise = point.incomePaise - point.expensePaise;

  return (
    <div className="min-w-44 rounded-[var(--radius-md)] bg-elevated px-3 py-2.5 text-[13px] shadow-[var(--shadow-md)]">
      <p className="mb-1.5 font-medium text-foreground">{formatMonthLabel(point.key, true)}</p>
      <dl className="space-y-1">
        <Row label="Income" value={formatRupees(point.incomePaise)} />
        <Row label="Expenses" value={formatRupees(point.expensePaise)} />
        <div className="mt-1.5 border-t border-border pt-1.5">
          <Row label="Net" value={formatRupees(netPaise)} strong />
        </div>
      </dl>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-numeric ${strong ? "font-medium text-foreground" : "text-foreground"}`}>{value}</dd>
    </div>
  );
}
