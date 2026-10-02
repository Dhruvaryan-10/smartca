# Responsive design

Layouts are designed mobile-first, and each width class is designed in its own right rather than shrunk from desktop (`layout.md › Adaptability`: "Design a layout that adapts gracefully to context changes while remaining recognizably consistent").

## Breakpoints

These are Tailwind's defaults. No custom breakpoints are added.

| Class | Width | Prefix | Character |
|---|---|---|---|
| Mobile | 320–639 | (base) | One column, 16px gutters, touch-first, drawer navigation, sheets |
| Tablet | 640–1023 | `sm`, `md` (768) | One or two columns, 32px gutters, drawer navigation, centred dialogs |
| Laptop | 1024–1279 | `lg` | Fixed sidebar, two-column task layouts |
| Desktop | 1280–1439 | `xl` | Data views reach 72rem; extra table columns |
| Large desktop | ≥1440 | — | Content stops widening and the extra space becomes margin. Reading views stay at 44rem |

Test at these widths: 320, 375, 390, 430, 768, 1024, 1280 and 1440, plus 200% zoom.

## Element behaviour

| Element | Mobile | Tablet | Laptop and up |
|---|---|---|---|
| **Navigation** | Drawer from the left, opened by the top-bar menu button. Five destinations, current page marked | Drawer | Fixed 15rem sidebar; no menu button |
| **Top bar** | 56px: menu, condensed page title, AY, theme, account | Same | Same, without the menu button |
| **Page padding** | `--page-gutter` 16px | 32px | 32px; content centred in `max-w-data` |
| **Section spacing** | 48px between sections is kept. Blocks compress to 24px (`gap-6`) | 32px blocks | 32px blocks |
| **Settled figure** | 40px (the clamp minimum); must fit `₹12,34,56,789` | Fluid | 60px maximum |
| **Figure rows** | 2 per row; hairline dividers become row gaps | 3–4 across | 4 across |
| **Cards / panels** | Stack in one column, full width within the gutters. Panel padding 20px | Two columns where content pairs naturally | Grid by content, never by "cards per row" |
| **Forms** | One field per row; labels above; the primary button full width at the bottom (the one place full width is right) | Two columns for short fields (date + amount) | Tax: form in 7 of 12 columns, result sticky in 5 |
| **Dialogs** | Bottom sheet with grabber | Centred, max 32rem | Same |
| **Filters** | One "Filters" button opening a sheet; active period visible on the page | Inline `FilterBar` | Inline `FilterBar` |
| **Assistant** | Full-height conversation; composer pinned above `env(safe-area-inset-bottom)` | Reading column | 44rem reading column; sources beside the answer from 1280px |

## Tables

- **List-like tables** (ledger, recent activity) become **stacked rows** below 640px. Line 1 is the description, with the amount right-aligned. Line 2 is the category and date, in muted text. Each row stays 44px or taller and is fully tappable.
- **Wide analytical tables** (CSV preview, computation sheet columns) scroll horizontally with a sticky first column and an edge fade, so it's clear more content exists. The page itself never scrolls horizontally.
- **Computation-sheet trees** cap their visual indent at two levels on mobile. Deeper levels are marked with a leading rule instead of more indent.
- **Extra columns** (source, notes) appear only from 1280px.

## Charts

- Width is 100% of the container. Height is 200px on mobile, 240px on tablet and 280px from 1024px.
- Fewer ticks on mobile (4–5 on the x axis), compact rupee labels, and tooltips on tap.
- The data table that every chart carries is available below the chart on mobile, behind a "Show data" disclosure.
- Charts never overflow. Long category names truncate with the full name in the tooltip and table.

## Typography

- `text-display` scales fluidly with `clamp`. Every other size is fixed and scales with the browser's text size.
- Form controls are 16px on mobile, to prevent iOS zoom on focus, and 14px from 640px.
- Line length is capped by containers (`max-w-reading`), not by shrinking type.

## Controls

- Touch targets are at least 44×44px on touch layouts, with 12px between adjacent targets.
- No hover-only affordances anywhere. Row actions are always visible on touch.
- Use `@media (pointer: coarse)`, not width, to decide whether compact 36px rows are allowed. A small laptop with a mouse can use them; a large tablet cannot.
- Safe areas: fixed bottom elements respect `env(safe-area-inset-bottom)`.
