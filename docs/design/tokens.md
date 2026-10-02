# Tokens

All tokens are CSS custom properties in `frontend/app/globals.css`, exposed to Tailwind v4 through `@theme inline`. There is one styling system: Tailwind utilities that read tokens. There is no second theme object in TypeScript.

The file is organised as follows:

| Block | Holds |
|---|---|
| `:root` | Light palette and shadows |
| `:root[data-theme="dark"]` | Dark palette, applied by the manual override |
| `@media (prefers-color-scheme: dark)` | The same dark palette, from the OS preference. A test keeps it identical to the block above |
| `@media (prefers-contrast: more)` | Stronger hairlines and secondary text |
| Theme-independent `:root` | Derived roles (tints, aliases, chart roles), radius, spacing, layout, layers and motion. They are declared once and resolve against whichever palette applies |
| `@theme inline` | Maps tokens to utilities (`bg-surface`, `rounded-panel`, `text-title`, `ease-entrance`, ...) |

## Colour

### Surfaces and text

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `#F2F4F1` | `#0E1211` | The page ("paper") |
| `--surface` | `#FAFBF9` | `#151A18` | Panels, tables and forms that earn a surface ("sheet") |
| `--surface-elevated` | `#FFFFFF` | `#1C2220` | Floating layers only: menus, popovers, dialogs, toasts |
| `--surface-sunken` | `#E7EAE6` | `#222927` | Inputs, hover fills, segmented-control tracks, skeletons |
| `--foreground` | `#17201C` | `#E7ECE9` | Primary text and every figure ("ink") |
| `--foreground-secondary` | `#3E4843` | `#C2CAC5` | Supporting text that is still content: descriptions, captions, secondary figures |
| `--foreground-muted` | `#58615C` | `#97A19B` | Labels, metadata, axis ticks, placeholders ("pencil") |

### Lines

| Token | Light | Dark | Use |
|---|---|---|---|
| `--border` | `#D9DED9` | `#2A312E` | **Standard border:** panel edges, table frames, menus |
| `--divider` | `#E2E6E2` | `#212826` | **Subtle divider:** between rows and list items where alignment already groups the content. Decorative, so it needs no contrast ratio |
| `--border-strong` | `#BFC6C0` | `#3A423F` | Table header rule, hover edge on interactive rows |
| `--field-border` | `#7F8781` | `#737C77` | Edges of interactive controls (≥3:1, WCAG 1.4.11) |
| `--border-focus` | = ring | = ring | **Focus border:** the 2px focus outline |
| `--border-active` | = primary | = primary | **Active border:** current tab underline, selected segmented item, the active field in a stepped flow |

Accounting rules are utilities, not tokens. Use `rule-subtotal` (a 1px rule at 40% ink, above a sub-total) and `rule-settled` (a 3px double rule in ink, under the one settled figure).

### Action and accent

| Token | Light | Dark | Use |
|---|---|---|---|
| `--primary` | `#0B5D68` | `#6CC2BA` | Primary action, current navigation, selection, focus. **Nothing else** |
| `--primary-hover` | `#084A53` | `#8AD0C9` | Hover and pressed step for primary fills |
| `--primary-foreground` | `#F4FAF9` | `#05201E` | Text on primary fills |
| `--secondary` | = surface-sunken | | Secondary button fill |
| `--accent` | primary at 10% on surface | | Selected rows, current-item tint, the recompute wash |
| `--ring` | = primary | | Focus indicator |
| `--overlay` | ink at 32% | black at 60% | Scrim behind dialogs and the drawer |

### Meaning

| Token | Light | Dark | Means | Never without |
|---|---|---|---|---|
| `--success` | `#24663C` | `#6CC48A` | Completed, confirmed, saved | A word |
| `--warning` | `#875A00` | `#DDB04E` | Needs the person's attention before it is used (unconfirmed extraction, stale result) | A word and an icon |
| `--danger` (`--error`) | `#B3261E` | `#F08A80` | Error, destructive action, a negative figure that needs action | A minus sign, word or icon |
| `--info` | `#2A5B9A` | `#8DB3E8` | Neutral guidance, assumptions, "not covered" | An icon or heading |

`--success-soft`, `--warning-soft`, `--danger-soft` and `--info-soft` are 10% tints on the surface, for notice and badge backgrounds. `--danger-foreground` is text on a filled danger button.

### Financial colour language

Adopted 2026-10-02 at the owner's direction, so the interface is not overwhelmingly monochrome. These colours are **accents on neutral surfaces**: figures, marks, thin rules and small tints. They are never large fills. Every one travels with a sign, a word or a label.

| Token | Light | Dark | Means | Typical use |
|---|---|---|---|---|
| `--income` | `#1E6B45` | `#5CC98E` | Money in, positive net | Income figures, `+₹` inflows, the income chart line, "Your ledger" marks |
| `--expense` | `#AD3E28` (coral) | `#F2876F` | Money out, negative net, overspending | Expense figures, `−₹` outflows, the expense chart line |
| `--tax` | `#835F00` (gold) | `#E3BA52` | Tax figures and tax-engine provenance | Tax payable, "Tax engine" marks and badges |
| `--assistant` | = primary | = primary | Ask SmartCA | The Ask button, the assistant panel's marks and rules |

- Each has a `-soft` tint for badges and marks. `--assistant-halo` is the 18% ring around the Ask button.
- Chart roles: `--chart-income`, `--chart-expense` and `--chart-tax`.
- `--danger` stays the colour for errors and destructive actions. Expenses use coral, not crimson, so "you spent money" never reads as "something went wrong".
- Use the colours through the `Money` primitive (`kind="income" | "expense" | "tax" | "net"`) and the `Badge` tones of the same names. Don't write `text-income` directly in page code where `Money` fits.
- Surfaces stay neutral. A page should never look green, red or gold, only its figures and marks.
- Every one reaches 4.5:1 on every surface in both themes. `tests/design-tokens.test.ts` enforces this.

### Chart colours

| Token | Use |
|---|---|
| `--chart-1` (= foreground) | Series 1, solid |
| `--chart-2` (= foreground-muted) | Series 2, dashed |
| `--chart-3` (= primary) | The highlighted point or the current period only |
| `--chart-4`, `--chart-5`, `--chart-6` (slate `#4C5E7C`, clay `#7A5A2E`, olive `#5E6B3A`; lighter in dark) | Categorical series, only when three or more are unavoidable. Each is ≥3:1 on the surface |
| `--chart-grid` (= border) | Grid lines |

Status colours (success, warning, danger, info) are never used as chart series. Income and expense series use `--chart-income` and `--chart-expense`, and still differ by something other than colour: dash pattern in line charts, position in paired bar charts. For the rest of the chart rules, see [finance-data.md › Charts](finance-data.md#charts).

### Contrast

These values are computed and enforced by the test.

| Pair | Light | Dark |
|---|---|---|
| foreground on background / sunken | 15.07 / 13.74 | 15.78 / 12.42 |
| secondary on background / sunken | 8.58 / 7.82 | 11.27 / 8.87 |
| muted on background / sunken | 5.79 / 5.28 | 7.08 / 5.58 |
| primary on background / sunken | 6.83 / 6.23 | 9.04 / 7.11 |
| success / warning / danger / info on sunken (the worst surface) | 5.69 / 4.96 / 5.39 / 5.65 | 7.00 / 7.35 / 6.12 / 6.89 |
| primary-foreground on primary | 7.15 | 8.17 |
| field-border on background / surface / sunken | 3.34 / 3.56 / 3.04 | 4.38 / 4.09 / 3.45 |

Every text colour reaches 4.5:1 on every surface in both themes.

**Colour blindness.** Meaning never depends on hue alone. Negatives carry a minus sign and inflows a plus, statuses carry words, and chart series differ by pattern as well as tone. Green and coral is a red–green pair, so this rule is essential, not optional: every income or expense colour is redundant with a sign, a label or a dash pattern.

### Themes

- Light and dark both ship. The OS preference applies by default.
- The existing manual override (`data-theme`, saved under the `localStorage` key `smartca-theme`) is kept for now. See the open decision in [README.md](README.md#open-decisions).
- `color-scheme` is set per theme, so native controls, scrollbars and date pickers match.

**Dark mode is not inverted light mode.** Hierarchy comes from surface steps (background → surface → elevated), and shadows become faint light rings (`dark-mode.md › Dark Mode colors`).

## Spacing

The base unit is 4px. Tailwind's numeric scale is the spacing scale (`p-1` is 4px). `--space-*` mirrors it for hand-written CSS.

| Step | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12 | 16 |
|---|---|---|---|---|---|---|---|---|---|---|
| px | 4 | 8 | 12 | 16 | 20 | 24 | 32 | 40 | 48 | 64 |

| Role | Token / utility | Value |
|---|---|---|
| Page padding | `--page-gutter` / `px-gutter` | 16px below 640px, 32px from 640px |
| Section spacing | `--space-section` / `space-y-section` | 48px between page sections |
| Block spacing | `--space-block` / `gap-block` | 32px between blocks in a section |
| Heading to content | `--space-stack` / `mt-stack` | 12px |
| Panel padding | `p-5` / `sm:p-6` | 20px / 24px |
| Control padding | `px-3` | 12px horizontal |
| Between controls | `gap-3` minimum | 12px (`accessibility.md › Mobility`: "Consider spacing between controls as important as size") |
| Dense data | `--row-height` / `h-row`, `--row-height-compact` / `h-row-compact`, `--cell-padding-x` | 44px rows, 36px compact (pointer layouts only), 12px cell padding |

Density comes from alignment and type hierarchy, not from removing space. A table may be dense; the space around the settled figure may not.

## Radius

The system is restrained: corners are precise, not soft.

| Role | Token / utility | Value | Use |
|---|---|---|---|
| Small | `--radius-xs` / `rounded-xs` | 4px | Badges, checkboxes, chips, provenance marks |
| Control / medium-small | `--radius-sm` = `--radius-control` / `rounded-control` | 6px | Buttons, inputs, selects, nav items, tabs, segmented controls |
| Medium | `--radius-md` / `rounded-md` | 8px | Menus, popovers, tooltips, inline notices |
| Large / panel | `--radius-lg` = `--radius-panel` / `rounded-panel` | 12px | Panels, framed tables, the drawer's edge |
| Dialog | `--radius-dialog` / `rounded-dialog` | 16px | Dialogs; bottom sheets (top corners only) |
| Pill | `--radius-pill` / `rounded-pill` | 9999px | Switch tracks, avatars, progress bars. **Never** badges or buttons |

Nested corners use the outer radius minus the padding. Anything not listed is square.

## Elevation

Depth comes from surface contrast and hairlines first. Shadows are reserved for things that float.

| Level | Token / utility | Light | Dark | Use |
|---|---|---|---|---|
| Flat | `--shadow-flat` / `shadow-flat` | none | none | Everything on the page: panels, tables, cards |
| Raised | `--shadow-raised` / `shadow-raised` | Soft 1px + 8px | 1px light ring | The sticky header once content scrolls beneath it; a dragged row |
| Floating | `--shadow-floating` / `shadow-floating` | 8/24 at 10% + ring | 8/24 at 50% + ring | Menus, popovers, tooltips, toasts, the drawer |
| Modal | `--shadow-modal` / `shadow-modal` | 24/64 at 18% + ring | 24/64 at 60% + ring | Dialogs and sheets, over the `--overlay` scrim |

There is no blur or translucency in content. If a sticky bar ever uses `backdrop-filter`, it needs an opaque fallback under `prefers-reduced-transparency`.

## Layout and layers

| Token / utility | Value | Use |
|---|---|---|
| `--container-data` / `max-w-data` | 72rem | Data views |
| `--container-reading` / `max-w-reading` | 44rem | Reading views: assistant, auth, long explanations |
| `--container-form` / `max-w-form` | 36rem | Standalone forms |
| `--sidebar-width` | 15rem | Fixed sidebar from 1024px |
| `--header-height` | 3.5rem | Top bar; also the `scroll-margin-top` for focus targets |
| `--z-sticky`, `--z-dropdown`, `--z-drawer`, `--z-dialog`, `--z-toast` | 10, 20, 40, 50, 60 | Stacking order. Never use a raw `z-[999]` |

## Legacy aliases

Existing components use these names. They resolve to the canonical tokens and will be removed after migration (Step 2 onward).

| Legacy | Canonical |
|---|---|
| `--muted-foreground` | `--foreground-muted` |
| `--card`, `--card-foreground` | `--surface`, `--foreground` |
| `--elevated`, `--elevated-foreground` | `--surface-elevated`, `--foreground` |
| `--inset` | `--surface-sunken` |
| `--destructive`, `--destructive-foreground` | `--danger`, `--danger-foreground` |
| `--shadow-sm`, `--shadow-md` | `--shadow-flat`, `--shadow-floating` |
