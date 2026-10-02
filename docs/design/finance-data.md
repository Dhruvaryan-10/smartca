# Data-dense finance UI

Most of SmartCA is financial information. These rules keep it beautiful and readable when it is dense. The basic idea: **rank first, then align, then reveal on demand** (`layout.md › Visual hierarchy`: "Take advantage of progressive disclosure").

## Hierarchy of a data view

1. **The answer.** The settled figure (if the view has one), with its period in words.
2. **The breakdown.** Supporting figures in a `FigureRow`.
3. **The working.** A table, chart or computation sheet.
4. **The detail.** Assumptions, notes and per-row metadata, behind a disclosure or in a row's expanded state.

A figure is never shown without its period. Where its source is not the ledger, it is shown with its provenance mark.

## Tables

- A real `<table>`, with `<caption>` (visible or visually hidden), `<th scope>` and `aria-sort` on sortable headers.
- **Column order:** identity first (date, description), classification next (category, source), money last. Money is right-aligned and tabular.
- **Alignment:** text left, figures right, dates left in a fixed format, status badges left.
- **Rows:** 44px (`h-row`); 36px compact (`h-row-compact`) for pointer-only layouts with many rows. `divider` lines between rows. No zebra striping: the hairlines and alignment do the work.
- **Header:** `text-label`, muted, sticky below the top bar, with a `border-strong` rule below.
- **Totals:** `rule-subtotal` above a sub-total. `rule-settled` under the final total, and only when that total is the view's settled figure.
- **Row actions:** ghost icon buttons on the right. Always visible on touch; on pointer devices they may reveal on row hover *or* focus, never on hover only.
- **Long lists:** show a sensible first page with a "Show more" control or pagination that keeps the row count visible ("Showing 50 of 312").
- **Empty, loading and error states** appear inside the table frame, keeping the header visible.
- **Small screens:** see [responsive.md › Tables](responsive.md#tables).

## Transactions

- **Row:** date, description, category, amount. Optional source columns (manual, CSV, Form 16) appear from 1280px.
- **Sign:** in a single-type list (Income or Expenses) amounts are unsigned. In a mixed list (Recent activity) inflows are `+₹…` in income green and outflows `−₹…` in expense coral (`Money` with `signed`). The sign is the signal; the colour confirms it.
- **Dates:** the person's local date, as entered (`DateField`), shown with `formatDate` as `4 Mar 2026`. A date is never derived from `toISOString()`, which can shift the day for entries made after midnight IST.
- **Editing:** edit and delete come from the row. Delete asks for confirmation. A just-saved or edited row gets the recompute wash once.

## Account balances and summaries

- **One settled figure per view:** savings for the period on Summary, tax payable on Tax.
- **Supporting figures** in a `FigureRow`, each labelled with what it is and its period.
- **No invented figures.** Monthly values come from monthly data, never from all-time totals divided or multiplied. A projection, if ever shown, is labelled as an estimate and shows its basis.

## Filters

- Use a `FilterBar` above the working area. Period comes first (this month, this FY, a custom range), then category and type.
- Active filters are visible as removable chips (`rounded-xs`), with a "Clear filters" link.
- Every figure on the page reflects the active filter, and the period appears in the settled figure's caption.
- Results update without a page reload. The previous result dims at 60% while loading; it never blanks.
- On mobile, filters collapse into a single "Filters" button that opens a sheet. The active period stays visible on the page.

## Dates and periods

| Context | Format |
|---|---|
| Single date | `4 Mar 2026` (`formatDate`) |
| Month label | `Mar`, or `Mar ’26` when years mix (`formatMonthLabel`) |
| Financial year | `FY 2025-26` |
| Assessment year | `AY 2026-27` (the tax workspace's period, shown once per view) |
| Range | `1 Apr – 30 Sep 2026`, with an en dash and the year once if it is shared |

Monthly aggregation is always by year *and* month. January of different years is never merged.

## Currency

All currency is formatted through `lib/format.ts`, with Indian grouping and the ₹ prefix. Paise are shown only when present, or for every row in a column that has any (see [typography.md › Decimal alignment](typography.md#decimal-alignment)). Compact forms appear only on chart axes and in tight summaries.

## Negative values

- Use a true minus sign (U+2212) before the ₹: `−₹4,500`.
- Expense figures and negative nets use **expense coral** (`Money kind="expense"` or `kind="net"`). Income and positive nets use income green. A plain balance with no direction stays ink.
- The settled figure stays ink when positive and turns coral when it is negative (overspent savings), so the largest figure on the page is only coloured when it needs attention.
- `danger` is reserved for errors and destructive actions, not for spending.
- Screen readers hear "minus" (the `Money` primitive adds an accessible label).
- Parentheses `(₹4,500)` are not used on screen. They are reserved for a possible printable CA-style export.

## Percentages

- One decimal place (`12.5%`), tabular, right-aligned in columns.
- A percentage always states what it is a share of ("of income", "of total deductions").
- Percentage *changes* are written out ("4.2% lower than last month"). Never an arrow alone.

## Comparisons

- State the comparison in words and as a figure: "₹12,400 more than last month".
- **Regime comparison:** both regimes side by side in `text-figure`, with neither coloured as better, and a factual difference sentence. SmartCA states the difference; it does not recommend.
- Comparison bars (`ComparisonBars`) share one scale and start at zero.

## Charts

- **Purpose first.** Every chart has a title and a one-sentence takeaway (`charting-data.md › Designing effective charts`: "Aid comprehension by adding descriptive text to the chart").
- **Types:** line for trends over time, bar for comparisons, proportion bars instead of pies (`charting-data.md › Designing effective charts`: "In general, prefer using common chart types").
- **Series:** at most two by default. Income vs expense charts use `--chart-income` and `--chart-expense`. In a line chart the expense line is also dashed. In a paired bar chart income is always the left bar of its month and expenses the right, with the legend in the same order, so position tells them apart without colour. Other two-series charts use ink (solid) and pencil (dashed).
- **Summary composition donuts:** "Where your money goes" (expense coral) and "Where your money comes from" (income green) show a donut beside the ranked list. Segments are in proportion to exact paise with small gaps between them; "Other" is neutral grey; the total sits at the centre.
  - The ranked list beside each donut carries every amount and share, and the donut has a text summary for screen readers, so the chart is never the only source of a number.
  - Income composition uses the categories people gave their income entries, ranked by the same top-five-plus-Other rule as expenses (`incomeCategories` in `lib/summary-view.ts`).
  - With a single income category, Summary says so in words instead of drawing a one-slice donut.
  - The donut settles in once (`.donut-enter`), and not at all under reduced motion.
- **Summary monthly chart:** paired bars for income and expenses by calendar month (year and month, never merged across years), shown from two months of activity. With one month, Summary explains that another month is needed and links to the ledger.
- **Composition bars:** a single segmented bar, with segments in proportion to exact paise (`flex-grow`), not rounded percentages. Spending categories use steps of expense coral, strongest first, and the rolled-up "Other" is neutral. Every segment's figure and share is also written out in the list or legend beside it. Categorical colours (`--chart-4..6`) appear only when unavoidable, always with direct labels. Semantic colours are never series.
- **Axes:** muted 12px ticks, compact rupees, no axis lines, horizontal grid only (`--chart-grid`). The y-axis starts at zero for bars.
- **Interaction:** a tooltip on hover, focus or tap shows the exact formatted values and the net where it is meaningful. The existing Summary tooltip is the model.
- **Accessibility:** every chart has a visually hidden data table and `role="img"` with a summary label (`charting-data.md › Best practices`: "Make every chart in your app accessible").
- **Empty data:** show the empty state, never an empty chart.
- **Consistency:** the same data uses the same colours and chart type across views (`charting-data.md › Designing effective charts`: "Maintain continuity among multiple charts that use the same data").
- **Motion:** draw once on first render, then never again on data updates (see [motion.md](motion.md)).
