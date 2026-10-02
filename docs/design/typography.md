# Typography

## Families

| Token | Face | Use |
|---|---|---|
| `--font-sans` / `font-sans` | Geist (installed via `next/font`), falling back to the platform UI font | Everything |
| `--font-display` / `font-display` | Geist, for now | The settled figure, page titles, the wordmark |
| `--font-mono` / `font-mono` | Geist Mono (`next/font`, not preloaded) | Technical text only: engine and rules versions, identifiers. **Never figures** |

One family carries the interface (`typography.md › Conveying hierarchy`: "Minimize the number of typefaces you use, even in a highly customized interface"). Geist has clean, open numerals, true tabular figures and a neutral voice that leaves the brand to layout and the settled figure.

A separate display face is an open decision. Any candidate must pass a type spike: the ₹ glyph, tabular figures, U+2212, licence, and file weight. Until then `--font-display` resolves to Geist, so adopting one later is a one-line change.

## Scale

Utilities are generated from `@theme`. Sizes are in px at the default root size and scale with the browser's text size.

| Utility | Size / line height | Tracking | Weight | Use |
|---|---|---|---|---|
| `text-display` | clamp(40→60px) / 1.05 | −0.025em | 600 | The settled figure, one per view |
| `text-figure` | 28 / 32 | −0.015em | 600 | Secondary key figures (each regime's total) |
| `text-title` | 28 / 36 | −0.015em | 600 | Page headings (`h1`) |
| `text-heading` | 17 / 24 | — | 600 | Panel and dialog titles |
| `text-subheading` | 15 / 20 | — | 600 | Section headings (`h2`) |
| `text-body-lg` | 15 / 24 | — | 400 | Reading text: assistant explanations, notices, help |
| `text-body` | 14 / 20 | — | 400 / 500 | Interface text, table cells, navigation |
| `text-label` | 13 / 18 | — | 500 | Field labels, metadata, table headers, captions |
| `text-micro` | 12 / 16 | — | 500 | Badges, provenance marks, axis ticks |

Rules:

- **Weights** are 400, 500 and 600 only. No light or thin weights (`typography.md › Ensuring legibility`: "In general, avoid light font weights").
- **Minimum size** is 12px, and only for micro text. Body text never goes below 14px.
- **Form controls** are 16px below 640px so iOS Safari does not zoom on focus, and 14px from 640px up.
- **Sentence case** everywhere. If an all-caps micro label is ever used, it gets +0.04em tracking.
- **Reading measure** is at most 68ch (`max-w-reading`).
- **Colour carries hierarchy only after size and weight:** primary text in `foreground`, supporting text in `foreground-secondary`, labels and metadata in `foreground-muted`.

### Responsive scaling

- `text-display` scales fluidly with `clamp`.
- `text-title` stays at 28px. It already fits 320px without wrapping for SmartCA's short page names.
- Everything else is fixed, and changes only through the browser's text size, which layouts must survive up to 200%.

## Financial figures

### Numerals

- Always use **tabular lining numerals**: `.font-numeric` (or Tailwind's `tabular-nums`). Proportional numerals are never used for amounts.
- Figures are set in `foreground` ink at weight 500 in tables and 600 for key figures. Muted figures are only for comparisons such as "last year".
- Figures do not count up and are never shown in monospace.

### Currency

- Format only through `lib/format.ts`:
  - `formatRupees` gives Indian grouping (`₹12,34,567`) and shows paise only when present (`₹1,250.50`).
  - `formatRupeesCompact` (`₹12.3L`, `₹2.1Cr`) is for chart axes and tight summaries only, never where the exact value is the point.
- Never write `₹${paise / 100}`.
- The ₹ symbol is part of the figure and sits immediately before it with no space. It is never placed in a separate column.
- Amounts are stored and computed in integer paise. Input goes through `lib/money-input.ts`.

### Signs

- Negative figures use a true minus sign (U+2212), from `formatRupees`: `−₹4,500`. Not a hyphen, and not parentheses on screen. Parentheses are reserved for a future printable computation sheet, if a CA-style export is built.
- Signed activity rows prefix inflows with `+` (`formatRupees(p, { showPositiveSign: true })`).
- Colour follows what the figure is: income green, expense coral, tax gold, and a net figure by its sign. Render figures through the `Money` primitive (see [finance-data.md](finance-data.md#negative-values)).

### Decimal alignment

1. Money columns are right-aligned with tabular numerals, so digits line up by place value.
2. Within a single column, paise are either shown for every row or for none. If any value in a column has paise, the column renders all values with two decimals (`₹1,250.00`), so the decimal points line up. This needs a column-level option on the formatter, added with the table primitive in Step 2. Until then, whole-rupee columns are the norm.
3. Currency symbols line up because they lead every figure and the column is right-aligned. Signs sit before the ₹ symbol.
4. Percentages are right-aligned in their own column with one decimal place (`12.5%`).

### Large-number hierarchy

| Level | Treatment | Example |
|---|---|---|
| Settled figure | `text-display`, 600, `rule-settled` below, one per view | Savings ₹4,12,300 |
| Key figure | `text-figure`, 600 | Each regime's total tax |
| Supporting figure | `text-subheading` to `text-heading`, 600, in a `FigureRow` | Income, expenses |
| Table figure | `text-body`, 500 | Ledger rows |
| Inline figure | Inherits the text size, `.font-numeric` | "Your deduction limit is ₹1,50,000" |

At 320px, the settled figure must fit `₹12,34,56,789` on one line at its 40px minimum. If a value does not fit, the compact form is shown, with the exact value available on focus or tap.

## Tables

- Header: `text-label`, 500, `foreground-muted`, sentence case, a `border-strong` rule below.
- Body: `text-body`, `foreground`. Figures are tabular and right-aligned. Text is left-aligned.
- Totals: 600, with `rule-subtotal` above and, for the final total only, `rule-settled` below.

## Navigation and technical text

- Navigation items: `text-body`, 500.
- Technical text (`tax-engine 2.3.0`, `rules AY 2026-27 r4`, document IDs): `font-mono text-label foreground-muted`.
