"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatMonthLabel, formatRupees, formatRupeesCompact } from "@/lib/format";
import { niceAxis } from "@/lib/chart";
import type { MonthBucket } from "@/lib/summary";
import { latestMonthComparison } from "@/lib/summary-view";
import { AXIS_TICK, BAR_ANIMATION_MS, CURSOR_FILL, ChartLegend, GRID_STROKE, TooltipCard, TooltipRow } from "../../components/charts/chart-kit";
import { Money } from "../../components/ui/Money";
import { usePrefersReducedMotion } from "../../components/useReducedMotion";

type Point = {
  key: string;
  label: string;
  incomePaise: number;
  expensePaise: number;
};

// One question: month by month, did more come in than went out? Paired
// bars, income (green) always on the left of its month and expenses
// (coral) on the right, so position and the legend say which is which
// even without colour; exact figures are in the tooltip and in the table
// screen readers get. Bars grow once on first render, never on update.
const INCOME_FILL = "var(--chart-income)";
const EXPENSE_FILL = "var(--chart-expense)";

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
      <div className="mb-4">
        <ChartLegend
          items={[
            { label: "Income", swatch: "bg-chart-income" },
            { label: "Expenses", swatch: "bg-chart-expense" },
          ]}
        />
      </div>

      {/* The SVG is not readable by assistive tech; the table below is. */}
      <div
        role="img"
        aria-label="Bar chart of monthly income and expenses. The same figures are listed in the table that follows."
        className="h-56 sm:h-64"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }} barGap={3} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
              interval="equidistantPreserveStart"
              minTickGap={12}
              tick={AXIS_TICK}
            />
            <YAxis
              width={56}
              tickLine={false}
              axisLine={false}
              ticks={axis.ticks}
              domain={[0, axis.max]}
              tickFormatter={(v: number) => formatRupeesCompact(v)}
              tick={AXIS_TICK}
            />
            <Tooltip
              content={<MonthTooltip />}
              cursor={CURSOR_FILL}
              isAnimationActive={false}
            />
            <Bar
              dataKey="incomePaise"
              name="Income"
              fill={INCOME_FILL}
              radius={[3, 3, 0, 0]}
              maxBarSize={20}
              isAnimationActive={!reduceMotion}
              animationDuration={BAR_ANIMATION_MS}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="expensePaise"
              name="Expenses"
              fill={EXPENSE_FILL}
              radius={[3, 3, 0, 0]}
              maxBarSize={20}
              isAnimationActive={!reduceMotion}
              animationDuration={BAR_ANIMATION_MS}
              animationEasing="ease-out"
            />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <table className="sr-only">
        <caption>Income and expenses by month</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Income</th>
            <th scope="col">Expenses</th>
            <th scope="col">Net</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.key}>
              <th scope="row">{formatMonthLabel(m.key, true)}</th>
              <td>{formatRupees(m.incomePaise)}</td>
              <td>{formatRupees(m.expensePaise)}</td>
              <td>{formatRupees(m.incomePaise - m.expensePaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The latest month in words, against the one before it. Shown above the chart, and on its own when there is only one month. */
export function MonthHighlight({ months }: { months: MonthBucket[] }) {
  const comparison = latestMonthComparison(months);
  if (!comparison) return null;
  const { current, currentNetPaise, previous, netChangePaise } = comparison;
  const month = formatMonthLabel(current.key, true);

  return (
    <p className="text-body text-foreground-secondary">
      <span className="font-medium text-foreground">{month}:</span>{" "}
      {currentNetPaise >= 0 ? (
        <>
          you kept <Money paise={currentNetPaise} kind="income" className="font-medium" />
        </>
      ) : (
        <>
          you spent <Money paise={-currentNetPaise} kind="expense" className="font-medium" /> more than you earned
        </>
      )}
      {previous && netChangePaise !== null && netChangePaise !== 0 && (
        <>
          , <Money paise={Math.abs(netChangePaise)} className="font-medium" /> {netChangePaise > 0 ? "more" : "less"} than in{" "}
          {formatMonthLabel(previous.key, true)}
        </>
      )}
      {previous && netChangePaise === 0 && <>, the same as {formatMonthLabel(previous.key, true)}</>}.
    </p>
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
    <TooltipCard title={formatMonthLabel(point.key, true)}>
      <TooltipRow label="Income" swatch="bg-chart-income">
        <Money paise={point.incomePaise} kind="income" />
      </TooltipRow>
      <TooltipRow label="Expenses" swatch="bg-chart-expense">
        <Money paise={point.expensePaise} kind="expense" />
      </TooltipRow>
      <TooltipRow label="Net" divided>
        <Money paise={netPaise} kind="net" className="font-medium" />
      </TooltipRow>
    </TooltipCard>
  );
}
