# SmartCA Frontend Design System

_Status: **proposal, for review.** Nothing here is implemented yet. Drafted 2026-10-02 against `main` at `c38ebc0`._

This document builds on the Phase 2B system (`frontend/app/globals.css`, `frontend/app/components/ui/`, and the vault notes `SmartCA/04 - Design/*`). It does not replace that system. Phase 2B got the fundamentals right: one accent, four surfaces, tabular figures, honest states, and measured contrast. This proposal keeps those fundamentals, gives SmartCA an identity that belongs to it, and extends the system to everything that is still unstyled or inconsistent.

Where this proposal **changes** a Phase 2B decision, the change is marked **Change** and comes with a reason. Everything not marked as a change carries forward.

---

## 0. Ground truth this design must respect

- **Product:** personal finance and income-tax software for **Indian individual taxpayers**, AY 2026-27. It has five destinations: Summary, Ledger, Tax, Vault and Ask (`SmartCA/01 - Product/Navigation.md`).
- **Product principles that become design rules:** correct before clever; deterministic numbers; an honest interface (no fake data, no decorative charts); say what isn't supported (`Product Principles.md`).
- **Backend boundaries the UI must not cross:**
  - Money arrives as integer paise and is converted only for display.
  - The tax engine runs on the server, and the Tax page calculates nothing.
  - Form 16 values are suggestions until the person confirms them.
  - The assistant answers through `POST /api/assistant` with a typed `Answer` (`state`, `text`, `citations`, `facts`, `notices`, `authority`, `violations`) or a typed public error. Consent lives at `/api/assistant/consent` and `/api/assistant/consent/disclosure`.
  - External mode is refused by configuration today, so the Ask UI must handle `assistant_unavailable` as a normal, first-class state.
- **Isolation rule (kept):** Three.js, React Three Fiber, GSAP and ScrollTrigger stay on the marketing route only. framer-motion stays out of the app shell (see §23).

---

## 1. SmartCA visual identity

### The idea: *the computation sheet*

When a chartered accountant hands an Indian client their figures, the document is a **Computation of Total Income**. It has a narrow description column on the left and a right-hand column of figures. Sub-totals sit under a single rule. The figure that matters, such as tax payable, sits under a **double rule**. That document is the oldest trust object in this profession, and every Indian taxpayer has seen one.

SmartCA's identity is that sheet, made calm and modern:

1. **The money column.** Figures always align on the right, in tabular numerals, at a consistent edge within a view. Text explains on the left, and figures settle on the right. This repeats on Summary, Ledger rows, the Tax computation, Vault's Form 16 review and Ask's tax facts. It is the structural signature of the product.
2. **The settled figure.** The one figure a view exists to show is set large and finished with the accounting **double rule**: two hairlines 2px apart, as wide as the figure. Examples are Savings, Tax payable, Net import total and Refund due. Only this figure gets the double rule, and a view has at most one. **This is the one memorable element.** Everything else stays quiet.
3. **Ink on ledger paper.** Surfaces are cool, faintly green-grey paper rather than warm cream, and the single accent is a deep ledger ink. Colour states facts (a negative balance, a refusal) and never decorates.

The sheet is a source of conventions, not a skeuomorphic theme. There are no paper textures, ruled-line backgrounds, typewriter faces or stamp graphics. Rules appear only where accounting convention puts them: above a sub-total, double under a final total, and between rows of a table. Everywhere else, space and type do the grouping.

### What SmartCA is not

- It is not a dark "AI dashboard": no blobs, neon, glass, glow or particle spheres inside the app.
- It is not a card kit: no grids of identical rounded stat cards with tinted icons.
- It is not a newspaper: no hairlines everywhere, no zero-radius columns. Rules follow accounting meaning only.
- It does not copy another product. The Apple, Linear, Stripe and Geist references in `Apple Design Direction.md` stay as *principles*, not appearances.

### Brand mark

The wordmark is "SmartCA" set in the display face (§3) at 600 weight, with tight tracking. It sits beside a mark built from the double rule: two short horizontal strokes, the lower one longer, inside a 20px square. It is drawn as SVG and inherits `currentColor`. It does not use a gradient, a sparkle or an "AI" glyph.

---

## 2. Design philosophy

1. **The figure is the interface.** A person comes to see a number they can trust. Rank, size and position serve that number before anything else.
2. **Show the working.** Every derived figure can be traced to its source in one interaction: the computation line, the ledger rows, the cited evidence. That traceability is what "premium" means in a CA product, more than polish.
3. **Quiet chrome, exact content.** Navigation, headers and controls are low-contrast and consistent. Precision goes into the content.
4. **State honestly.** Loading, empty, refused, unsupported, withheld and unavailable are all designed states with plain explanations. A refusal is never dressed up as an answer.
5. **Motion explains change.** Motion exists to show what changed after an action. It never decorates (see §23).
6. **One product.** Every page uses the same header, the same money column, the same table and the same state components. A page that needs something new adds it to the system first.

---

## 3. Typography system

### Faces

| Role | Face | Notes |
|---|---|---|
| UI and body | **Geist** (kept) | Already loaded through `next/font`, neutral and legible at 13–15px. |
| Display: page titles, settled figures, wordmark | **Anek Latin** (proposed; **gated by a type spike**) | An Indian-designed variable family (Ek Type) with a **width axis**. The settled figure uses a slightly condensed width, so large rupee amounts in Indian grouping (`₹12,45,300`) stay on one line on mobile without shrinking. It is a grounded choice: built by an Indian foundry, with a sibling family covering Devanagari for future localisation. |

**Change:** Phase 2B used Geist alone. One display face is added because the settled figure and page titles are where the identity speaks, and a second, clearly different voice there makes SmartCA recognisable.

**Type spike (roadmap step 0.2) must confirm all of these before the face is adopted:**
- a real `₹` glyph (U+20B9)
- tabular lining figures (`tnum`)
- a true minus sign (U+2212)
- SIL Open Font License
- self-hosting via `next/font`
- under ~40 KB for the subset

If Anek Latin fails any check, the fallbacks in order are **IBM Plex Sans Condensed** for display only, then **Geist alone** with the condensed effect dropped. Geist's own `₹` and `tnum` support must also be verified in the same spike.

### Scale

The scale is a 1.2 minor-third ratio anchored at 14px body, rounded to whole pixels. Line heights snap to a 4px grid.

| Token | Size / line | Weight | Face | Use |
|---|---|---|---|---|
| `text-figure-xl` | `clamp(40px, 7vw, 64px)` / 1.0 | 600, width ~88 | Display | the settled figure |
| `text-figure-lg` | 28 / 32 | 600 | Display | secondary headline figures |
| `text-title` | 28 / 36 | 600, −0.02em | Display | page title |
| `text-heading` | 17 / 24 | 600 | Geist | section heading |
| `text-subheading` | 15 / 20 | 600 | Geist | panel and card titles, dialog titles |
| `text-body` | 14 / 20 | 400 | Geist | default UI text |
| `text-body-lg` | 15 / 24 | 400 | Geist | reading text: Ask answers, explanations, auth |
| `text-meta` | 13 / 18 | 400–500 | Geist | labels, metadata, table cells |
| `text-micro` | 12 / 16 | 500 | Geist | chart axes, badges. Never body copy. |

### Rules

- **Sentence case everywhere.** No all-caps labels, no tracked-out eyebrows, and no labels above headings that only repeat them.
- **Figures:** always `font-numeric` (tabular, lining), formatted with `lib/format.ts`:
  - Indian grouping
  - a real minus sign
  - whole rupees unless there are paise
  - `₹` attached to the figure, with no space
- **Weights:** 400, 500 and 600 only. No light weights below 17px.
- **Measure:** reading text is capped at 68ch (Ask answers, help text, empty states).
- **Emphasis:** no highlighting of a single word in a heading by colour or italic.

---

## 4. Color system

**Change:** the light surfaces move from warm cream (`#f4f3ef`) to cool **ledger paper**. Warm cream with a serif or clay accent is now the most common look of generated interfaces, and it works against the "precise, calm" brief. A cool, faintly green-grey paper reads as stationery and accounts rather than lifestyle. The accent stays in the same deep teal-ink family, so existing brand equity and measured contrast carry over.

### Core palette (light)

| Name | Token | Hex | Role |
|---|---|---|---|
| Ledger paper | `--background` | `#F2F4F1` | the page |
| Sheet | `--card` | `#FAFBF9` | a grouped region that earns a surface |
| Raised | `--elevated` | `#FFFFFF` | floating layers only |
| Well | `--inset` | `#E7EAE6` | controls, hover fills, recessed areas |
| Ink | `--foreground` | `#17201C` | text and primary figures |
| Pencil | `--muted-foreground` | `#58615C` | secondary text |
| Rule | `--border` | `#D9DED9` | hairlines |
| Field edge | `--field-border` | `#7F8781` | input boundaries |
| Ledger ink | `--primary` | `#0B5D68` | the accent |
| On ink | `--primary-foreground` | `#F3FAF9` | text on accent |

### Core palette (dark: "night ledger")

| Token | Hex |
|---|---|
| `--background` | `#0E1211` |
| `--card` | `#151A18` |
| `--elevated` | `#1C2220` |
| `--inset` | `#222927` |
| `--foreground` | `#E7ECE9` |
| `--muted-foreground` | `#97A19B` |
| `--border` | `#2A312E` |
| `--field-border` | `#737C77` |
| `--primary` | `#6CC2BA` |
| `--primary-foreground` | `#062221` |

### Semantic colours (light / dark)

Each colour has exactly one meaning:

| Token | Light | Dark | Means |
|---|---|---|---|
| `--positive` (was `success`) | `#1E6A39` | `#63BF80` | money in, a saving, a confirmed value |
| `--negative` (was `destructive`) | `#B3261E` | `#F0756A` | overspend, tax due above an estimate, destructive action |
| `--caution` (was `warning`) | `#875800` | `#DDAA48` | unconfirmed or extracted values, stale results, guidance-only authority |
| `--info` | `#2C5A97` | `#86ADE2` | neutral system notices |

Renaming `success` and `destructive` to `positive` and `negative` is optional. If it is done, both names stay as aliases until every call site moves.

### Measured contrast

Computed with the WCAG 2.x formula on 2026-10-02:

| Pairing | Light | Dark |
|---|---|---|
| Ink on paper / sheet / well | 15.1 / 16.1 / 13.7 | 15.8 / 14.7 / 12.4 |
| Pencil on paper / sheet / well | 5.8 / 6.2 / 5.3 | 7.1 / 6.6 / 5.6 |
| Accent on paper / sheet / well | 6.8 / 7.3 / 6.2 | 9.0 / 8.4 / 7.1 |
| Semantic colours on any surface | ≥ 5.05 | ≥ 5.27 |
| Field edge vs surfaces (non-text, 3:1 needed) | ≥ 3.04 | ≥ 3.45 |
| On-ink on accent | 7.1 | 8.0 |

### Rules

- The accent is used only for:
  - the primary action
  - the active navigation item's icon and indicator
  - selection
  - focus rings
  - links in reading text
  - the brand mark
- It is never used for headings or fills, and never for charts unless something is selected.
- Meaning is never carried by colour alone. Amounts carry a sign, states carry a word, and chart series carry a dash pattern.
- Tints are `color-mix(in srgb, <token> 10%, transparent)` for backgrounds and 30% for borders. No gradients anywhere in the app.
- `::selection` uses the accent at 22%.

---

## 5. Spacing scale

The base unit is 4px. Tailwind's default spacing is kept, so `1` = 4px, and the named steps below are used for layout.

| Step | px | Use |
|---|---|---|
| 1 | 4 | icon to label |
| 2 | 8 | control internals, tight stacks |
| 3 | 12 | label to field, list row padding (y) |
| 4 | 16 | mobile gutter, field to field |
| 5 | 20 | panel padding (mobile) |
| 6 | 24 | panel padding (desktop), header to content |
| 8 | 32 | between blocks within a section |
| 12 | 48 | between sections |
| 16 | 64 | page top on desktop, landing rhythm |

- Vertical rhythm on a page is 48 / 32 / 12: between sections, between blocks within a section, and between a heading and its content.
- **Change:** Phase 2B used 32 between page blocks and 48 only on Summary. This proposal makes 48/32 universal so every page breathes the same way.

---

## 6. Radius system

Radius signals what kind of thing an element is. It is not one value for everything.

| Token | px | Use |
|---|---|---|
| `--radius-xs` | 4 | badges, chips, tooltips, checkbox |
| `--radius-sm` | 6 | buttons, inputs, selects, nav items |
| `--radius-md` | 10 | panels, tables, menus, popovers |
| `--radius-lg` | 14 | dialogs, drawers (inner edge only) |
| `--radius-full` | 9999 | avatar and segmented-control thumb. Not used for buttons. |

**Change:** this is tighter than Phase 2B's 8/10/12. Controls at 6px read as precise instruments, and the gap between control and container radius becomes visible.

---

## 7. Shadows and elevation

There are three levels. Panels are flat and use no shadow.

| Level | Token | Light | Dark | Use |
|---|---|---|---|---|
| 0 | none | none | none | page, panels, tables |
| 1 | `--shadow-pop` | `0 1px 2px rgb(23 32 28 / .06), 0 8px 24px rgb(23 32 28 / .10), 0 0 0 1px rgb(23 32 28 / .05)` | `0 8px 24px rgb(0 0 0 / .5), 0 0 0 1px rgb(255 255 255 / .06)` | menus, popovers, tooltips, toasts |
| 2 | `--shadow-modal` | `0 24px 64px rgb(23 32 28 / .18), 0 0 0 1px rgb(23 32 28 / .06)` | `0 24px 64px rgb(0 0 0 / .6), 0 0 0 1px rgb(255 255 255 / .07)` | dialogs, drawers |

Elevation also changes the surface. Level 1 and above use `--elevated`. Dark mode relies on the surface step more than on the shadow.

---

## 8. Borders and dividers

| Rule | Spec | Meaning |
|---|---|---|
| Hairline | 1px `--border` | separates rows in a table or list, and frames a panel |
| Sub-total rule | 1px `--foreground` at 40%, figure-column width only | "the lines above add up to this" |
| Double rule | two 1px `--foreground` lines, 2px apart, figure width | "this is the final figure". At most one per view. |
| Field edge | 1px `--field-border` | an input |
| Focus | 2px `--ring` + 2px offset | keyboard focus (§26) |

- Space or a heading separates sections before a rule does.
- A rule never sits directly under a page header, and rules are never stacked.

Implementation: `.rule-subtotal` and `.rule-total` utility classes, or `<Figure total>`, which draws the double rule with `border-bottom: 3px double` on the figure span (3px double renders as two hairlines with a gap). This needs a cross-browser check in QA.

---

## 9. Iconography

The existing set is kept and extended: `Icons.tsx`, 20×20 viewBox, 1.5px stroke, round caps and joins, `currentColor`.

- The icon library stays hand-drawn. No dependency is added, and the set grows only when a component needs a new icon:
  - plus, check, alert, info, upload, download, trash, edit, external, search, chevron-left/right, more, copy, filter, sort, calendar, document, sparkle-free "ask"
- Icons sit at 16px in dense rows and 18px in navigation and buttons.
- An icon never stands alone without an accessible name. Icon-only buttons need an `aria-label` and a tooltip.
- No emoji in UI copy. (The current `/insights` strings use emoji and are replaced in step 3.)
- Status is always icon plus word, never icon alone.

---

## 10. Button hierarchy

| Variant | Look | Rule |
|---|---|---|
| `primary` | accent fill, on-ink text | **one per view**: the action the view exists for (Calculate tax, Save entry, Confirm values, Send) |
| `secondary` | well fill, ink text | supporting actions |
| `outline` (new) | transparent, 1px field-edge border | an alternative action beside a primary, in toolbars on sheet surfaces |
| `ghost` | text only, well on hover | tertiary actions, table row actions, icon buttons |
| `danger` (renamed from `destructive`) | negative-colour text on well, negative fill only inside a confirm dialog | delete, withdraw consent |
| `link` (new) | accent text, underline on hover | inline navigation within reading text |

| Size | Height | Use |
|---|---|---|
| `sm` | 32 | tables, toolbars |
| `md` | 36 | default |
| `lg` | 44 | auth, mobile primary actions, dialog footers on touch |

States:

- **Hover:** a surface step (well to rule). For accent buttons, the accent is mixed 8% toward ink in light mode and toward white in dark. **Change:** this replaces `brightness-110`, which washes the accent out in dark mode.
- **Active:** `translateY(0.5px)` plus a darker step, applied within 80ms.
- **Focus:** the ring (§26).
- **Disabled:** 45% opacity, `cursor: not-allowed`, and a reason given in adjacent text whenever the reason is not obvious.
- **Busy:** the label stays and a 14px spinner replaces the leading icon. The button keeps its width (min-width locked at press) and gets `aria-busy="true"`.

Copy is verb first and names the outcome ("Save entry", not "Submit"). The same verb carries into the toast ("Entry saved"). No `→` is appended to labels, and no `+` text prefix is used; a plus icon replaces it.

---

## 11. Input and form system

The current base is kept: `Input`, `Select`, `Label`, `FieldMessage`, `TextField`. Wiring stays as is: `aria-invalid`, `aria-describedby`, validate on blur and then live while correcting, and focus the first invalid field on submit.

New components:

- **`MoneyField`.**
  - A `₹` prefix sits inside the field in muted text.
  - Input is right-aligned with tabular figures, so money fields align with the money column.
  - It accepts `1,50,000` and `150000`. Lakh shorthand such as `1.5L` is not parsed in v1.
  - On blur it formats with Indian grouping, then emits **paise** to its owner through a `lib/format` parser.
  - It is the only way to enter money in the app, and it replaces the ad-hoc amount inputs and `alert()` calls in Ledger.
- **`DateField`:** a native `<input type="date">` styled to the system, using the existing calendar-safe validation.
- **`Textarea`:** auto-grows up to 8 lines. Used by Ask.
- **`Checkbox`, `Radio`, `SegmentedControl`.** The segmented control is used for Income/Expense type and for old/new regime views.
- **`FormSection`:** a heading, an optional one-line description and a field stack. Forms are grouped by meaning, not by cards.
- **`FormActions`:** right-aligned on desktop and full-width stacked on mobile, with the primary action last on desktop and first on mobile.

Field anatomy, top to bottom: label (13/500, ink, **Change:** from muted to ink for faster scanning), then the control, then the hint or error (13). Optional fields are marked "(optional)". Required fields are not starred.

Extracted values (Form 16 review): the field shows a `caution` left rule and the line "Read from your Form 16. Check before confirming." This visual vocabulary is reused anywhere a value is a suggestion rather than confirmed.

---

## 12. Cards and panels

The Phase 2B rule is kept: grouping comes from space, then type, then a rule, and only then a surface.

- **`Panel`** (renamed from `Card`, with an alias kept): sheet surface, 1px rule, `--radius-md`, no shadow. Use it for:
  - a form
  - a table
  - a self-contained module (a document, a saved computation)
- **`Panel` header:** `text-subheading`, optional meta on the right, then 16px to the content. No divider under the header unless the body is a table.
- **No stat-card grids.** Multiple figures sit in a **figure row**: a `dl` of figures separated by vertical hairlines, as Phase 2B's Summary already does. Reports' four tinted `StatCard`s become a figure row.
- **Nesting:** panels never contain panels. A panel can contain a table, a list, or a well (an inset region for code, quotes or evidence).

---

## 13. Tables

The ledger table is SmartCA's most-used component, so it gets the most care.

```
 Date        Description                Category         Amount
 ─────────────────────────────────────────────────────────────────
 12 Sep      Salary — Acme Ltd          Salary        +₹1,20,000
 14 Sep      Rent                       Housing         −₹32,000
 ─────────────────────────────────────────────────────────────────
                                        Net             ₹88,000
                                                     ═══════════
```

- **Columns:**
  - Text columns are left-aligned. Figure columns are right-aligned and tabular. The amount is always the **last** column (the money column).
  - Dates use `12 Sep`, adding the year only when the range crosses a year.
  - Signs come first: `+₹` for money in and `−₹` (U+2212) for money out. Money in is `positive`-coloured; money out stays ink.
- **Header:** `text-meta` 500 muted, sentence case, sticky (`position: sticky; top: <shell header height>`) on tables taller than the viewport.
- **Rows:**
  - 44px default, or 36px with `density="compact"`. Hairlines between rows, none around the outside when inside a panel.
  - Hover fills the row with well at 60%.
  - The row action (edit or delete via the existing PATCH/DELETE transaction routes) is a ghost icon button. It shows on hover or focus on desktop and stays visible on touch.
- **Totals:** a sub-total rule above the total row, and the double rule under the final total when the table *is* the view's settled figure.
- **Sorting:** a header button with `aria-sort`. The default sort is date descending.
- **Mobile (< 640px):** tables become stacked rows. Description and amount sit on the first line, category and date on the second. No horizontal scroll for the ledger. Wide data tables (CSV preview) may scroll horizontally inside their panel, with a visible edge fade and a sticky first column.
- **Empty, loading and error** states render inside the table frame, so the layout doesn't jump (§17–19).
- **Semantics:** a real `<table>` with `<caption>` (visually hidden when the page header already says it) and `scope` on header cells.

---

## 14. Charts

The rules carried from `UI Principles.md` stay: a chart must answer a question a person has; neutral ink lines told apart by dash; no smoothing; every chart has a table alternative.

- **Library:** recharts, already installed and used by `MonthlyChart`. Every chart goes through a small `chart/` kit so the styling exists once:
  - `ChartFrame`: legend, accessible name and hidden table
  - `ChartTooltip`
  - axis presets
- **Series:**
  - Series 1 is ink, solid, 2px. Series 2 is pencil, dashed `5 4`, 2px. There are no third series. Comparisons beyond two use small multiples.
  - The accent appears only on the hovered or selected point and the cursor line.
- **Grid:** horizontal only, `--border`. **Axes:** `text-micro` muted, round ticks (`lib/chart.ts`), compact rupees (`₹1.2L`, `₹3.4Cr`).
- **Category share:** proportion bars, not pies. Reports' rainbow pie (`COLORS = [...]`) is removed. Bars use ink at 70%, and the "other" remainder uses pencil at 50%.
- **Regime comparison:** two aligned horizontal bars for old vs new tax payable, labelled with figures. The lower one is **not** coloured as "better", and the engine's "not a recommendation" notice is shown verbatim.
- **Motion:** a 500ms draw on first paint only, none on data refresh, and none under reduced motion (the existing `usePrefersReducedMotion`).
- **Tooltip:** elevated surface, `--shadow-pop`, figures right-aligned with a net line under a sub-total rule.

---

## 15. Navigation

The five destinations and route names are kept: Summary, Ledger, Tax, Vault, Ask. The hierarchy is kept, and the frame is refined.

- **Shared layout.**
  - **Change:** move authenticated pages under a route group `app/(app)/layout.tsx` that renders `AppShell` once, so the shell stops remounting on every navigation. URLs stay the same, because route groups don't affect paths.
  - `proxy.ts` session enforcement is untouched.
  - This is the only structural change proposed, and it is listed as an open item in `08 - Phases/Phase 2.md`.
- **Sidebar (≥ 1024px), 232px:**
  - wordmark and mark at the top
  - five items: 36px, icon 18px, `text-body` 500
  - at the bottom, the assessment year context and account
- **Active item:** well fill, ink label, accent icon, and a 2px accent indicator on the inner left edge. The indicator slides between items in 160ms; with reduced motion it jumps.
- **Header bar:** 56px. Mobile menu button on the left, page context on the right (theme, account). On scroll the page title condenses into the header (§25).
- **Drawer (< 1024px):** the existing focus handling and Escape behaviour are kept, and a focus trap is added. **Change:** `inert` is set on the main content while the drawer is open.
- **Sub-navigation:**
  - `LedgerTabs` becomes a generic `Tabs` (an underline indicator that slides).
  - Used by Ledger (Income, Expenses, Reports) and by Vault (Documents, Imports) if Vault grows.
  - **Change:** Ledger's tabs move from three routes sharing one header to one page shape: the header stays fixed and only the tab panel changes.
- **Keyboard:**
  - skip link (kept)
  - `g` then `s`/`l`/`t`/`v`/`a` for destinations (optional, phase 4)
  - `/` focuses Ask's composer on the Ask page only

---

## 16. Page headers

There is one header shape for every page (the `PageHeader` API is kept and extended):

```
Tax                                               [Saved 12 Sep]  [Calculate tax]
Old and new regime for AY 2026-27.
```

- Title in `text-title` display face, then one line of context in muted `text-body`. Actions sit on the right with at most one primary.
- An optional `status` slot shows a quiet badge-like word ("Saved", "Out of date", "Guidance only").
- No breadcrumbs (the hierarchy is only two levels deep). No eyebrow label above the title.
- On mobile, actions wrap below the description and the primary action goes full width.

---

## 17. Empty states

Phase 2B's rule is kept: say what is empty, why, and what to do next. No illustration, no fake data.

- Use `EmptyState` (full page) or `EmptyState compact` (in a section). The title is a plain statement, the description is one or two sentences, and there are one or two actions (one primary).
- **Inside a table**, the empty state sits in the table body, with headers still visible so the shape of the data is learned.
- Copy examples:

  | View | Title | Description | Action |
  |---|---|---|---|
  | Ledger | No income recorded yet | Add your first entry, or import a CSV from your bank. | Add income |
  | Vault | No documents yet | Upload your Form 16 to check the figures against your tax computation. | Upload Form 16 |
  | Ask, assistant off | The assistant isn't switched on | Ask needs an approved model service, and none is connected. Tax and Summary work without it. | Open Tax |

---

## 18. Loading states

- **Skeletons that match the loaded layout** (kept). Skeleton blocks use `--inset` with the slow pulse.
- **Delay:** skeletons appear after **150ms**, so fast loads never flash. They stay at least **400ms** once shown, to avoid flicker.
- **In-place work** (calculate, save, upload): a busy button (§10). The previous result stays visible at 60% opacity with `aria-busy` rather than being cleared.
- **Long work** (CSV commit, PDF extraction, assistant run):
  - A determinate progress line where progress is known; otherwise a status line in plain words ("Reading your Form 16…").
  - Ask shows the run in stages only if the API exposes them. It currently does not and has no streaming, so it shows a single "Working on your question…" line and a Cancel button. Cancel aborts the fetch, which the backend treats as `request_cancelled`.
- `LoadingState` with a spinner is kept only for small regions. Pages use skeletons.

---

## 19. Error states

- **`ErrorState`** (kept and refined): what failed, in plain words, plus how to fix it, plus a retry when `retryable`. It never apologises and never says "Oops". It sits in place of the content that failed, never as a page-wide takeover unless the whole page failed.
- **Field errors:** inline, specific, tied to the field (§11).
- **Session expiry:** the existing detection (a non-JSON response) shows "Your session has ended. Log in again to continue." with a Log in button that preserves the current path.
- **Assistant errors** map 1:1 from the public contract's `category` and code, and the server's fixed `message` is shown verbatim:

  | Category | Treatment |
  |---|---|
  | `consent` | Show the consent panel (§21) with the specific message. `consent_outdated` shows what changed in the disclosure. |
  | `rate_limit` | Inline notice with the message and a retry when `retryable`, with no automatic retry. |
  | `configuration` | The "assistant isn't switched on" empty state, not an error. |
  | `provider` / `assistant` / `internal` | Inline error on that turn, retry when `retryable`, and the person's question is preserved. |

- **Answer states** are not errors and get distinct treatments:

  | State | Treatment |
  |---|---|
  | `answered` | text plus citations plus facts |
  | `insufficient_evidence` | "SmartCA's sources don't cover this," plus what is covered |
  | `unsupported` | the engine's refusal message verbatim, plus the facts that do stand |
  | `withheld` | "The explanation was held back because it didn't meet SmartCA's accuracy rules. The figures below come straight from the tax engine." |

---

## 20. Toast and notification system

There is no toast system today; Ledger uses `alert()`. Proposed:

- **`Toaster`:** a single region, bottom-right on desktop and bottom-centre above the safe area on mobile. `aria-live="polite"`, or `assertive` for failures.
- **Uses:** **confirmation of something the person did that has left the screen**, such as "Entry saved", "Form 16 deleted" or "Computation saved". It is never used for errors in a form (those go inline) and never for system marketing.
- **Anatomy:** icon plus one sentence plus an optional single action (Undo or View). 360px max width, elevated surface, `--shadow-pop`.
- **Timing:** 5s, or 8s with an action. Paused while hovered or focused. Dismissible with Escape.
- **Undo:** offered only where the backend makes it real. No transaction or document undelete exists, so v1 deletes get a confirm dialog instead of Undo.
- **Stack:** at most 3; older ones collapse.

---

## 21. Modal and dialog system

- Built on the native `<dialog>` element with `showModal()`. That provides a free focus trap, Escape handling, inertness of the background and top-layer stacking. No dialog library is added.
- **`Dialog`:** `--radius-lg`, elevated surface, `--shadow-modal`, max width 480px (`size="md"`) or 640px (`size="lg"`). Backdrop is ink at 40% in light mode and black at 60% in dark mode.
- **Anatomy:**
  - title (`text-subheading`)
  - body
  - footer with actions right-aligned, primary last
- **On mobile (< 640px)**, dialogs become a bottom **sheet** (full width, top radius only).
- **`ConfirmDialog`:** for destructive actions only. The title names the consequence ("Delete this Form 16?"), the body names what is lost, and the action repeats the verb ("Delete Form 16"). Focus starts on Cancel.
- **Assistant consent** uses a **page-level panel on Ask, not a modal.** Consent is a reading task about what is shared. It shows `GET /api/assistant/consent/disclosure` verbatim as two lists, "Shared with the model service" and "Never shared", with Grant and Not now. Withdrawing lives in the account menu, with a `ConfirmDialog`.
- **Drawer:** a side sheet for row details on Ledger (edit an entry). On mobile it is the same component as the bottom sheet.

---

## 22. Responsive breakpoints

Tailwind defaults are kept. The layout responds to these:

| Name | Min width | Layout change |
|---|---|---|
| base | 0 | single column, 16px gutters, stacked table rows, bottom-sheet dialogs |
| `sm` | 640 | real tables, side-by-side form fields, centred dialogs |
| `md` | 768 | two-column sections (Summary lower half, Tax form beside results where they fit) |
| `lg` | 1024 | persistent sidebar, 32px gutters |
| `xl` | 1280 | wider content width for data views |

Content widths:

- **data views** (Summary, Ledger, Tax, Vault): 72rem
- **reading views** (Ask, auth, settings): 44rem
- **forms on their own**: 36rem

**Change:** the single 64rem cap becomes view-dependent.

Touch targets are at least 44×44 below `lg`, even where the visual control is smaller (padding expands the hit area).

---

## 23. Animation principles

1. **Motion answers an action.** It opens, closes, confirms, reorders or reveals what changed. Ambient motion is not allowed.
2. **One moment per view.** Each page has at most one orchestrated, non-triggered moment: Summary's settled figure fades in with its double rule drawing left to right (320ms). Nothing else on load moves except the page settle.
3. **Short distances.** Translations of 4–8px, never more than 16px inside the app. Nothing flies in from off-screen except drawers and sheets.
4. **The recompute highlight.**
   - When the Tax page recalculates, or a Ledger total changes after a save, each figure whose value changed gets an **ink wash**: an accent background at 14% fading to transparent over 900ms. Its sub-total rule redraws.
   - This is SmartCA's motion signature. It shows exactly what changed, which serves "show the working".
   - Figures never count up or roll.
5. **CSS first.** CSS transitions, keyframes and the View Transitions API (for tab panel crossfade, behind feature detection) come first. framer-motion stays **out of the app bundle** and is used only on the marketing route, consistent with the isolation rule.

---

## 24. Transition timings and easing

| Token | ms | Use |
|---|---|---|
| `--dur-instant` | 80 | press feedback, active states |
| `--dur-fast` | 140 | hover, focus ring, colour changes |
| `--dur-base` | 200 | menus, popovers, tooltips, tab indicator, page settle |
| `--dur-slow` | 280 | dialogs, drawers, sheets |
| `--dur-emphasis` | 320 | the settled-figure reveal, double-rule draw |
| `--dur-wash` | 900 | the recompute ink wash (opacity fade only) |

| Easing token | Curve | Use |
|---|---|---|
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` (kept) | most movement |
| `--ease-enter` | `cubic-bezier(0, 0, 0.2, 1)` | elements appearing (decelerate) |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | elements leaving, at about 75% of the entry duration |
| `linear` | | opacity-only fades such as the wash, and progress |

No spring or bounce curves are used inside the app; financial UI should not wobble. Exits are always faster than entries.

---

## 25. Scroll animation principles

Inside the app, scroll **never** triggers reveals and is never hijacked. Scroll affects only:

- **The condensing header.** After the page title scrolls past, its text appears in the 56px header bar (`text-subheading`), fading in over 140ms. This is driven by an `IntersectionObserver` on the title, not a scroll listener.
- **Sticky structures:**
  - table headers
  - the Tax page's result summary column on `md+`, which sticks while the form scrolls
  - Ask's composer, pinned to the bottom
- **Scroll position** is restored per route (Next default) and reset on tab change.
- **Edge fades** on horizontally scrolling tables: a 24px gradient of the surface colour, shown only when more content exists in that direction.

**Landing (Phase 8, separate):** scroll-driven storytelling is allowed there, inside the same principles: reduced-motion fallback, no scroll-jacking of the native scrollbar, and content readable without JS. The current blob background and R3F "neural sphere" are generic AI imagery. The Phase 8 brief should replace them with an image from SmartCA's own world, such as a computation sheet assembling line by line and settling into its double-ruled total. That work is out of scope for this proposal beyond aligning the landing with tokens and type (roadmap step 6).

---

## 26. Accessibility rules

Target: **WCAG 2.2 AA.**

- **Contrast:** text ≥ 4.5:1 and large text or non-text UI ≥ 3:1. Measured in §4. Any new token pairing gets measured before merge.
- **Focus:** `:focus-visible` ring of 2px `--ring` with a 2px offset against the current surface, never removed. Focus never lands behind a sticky header (`scroll-margin-top` on focusable regions).
- **Keyboard:** everything reachable and operable. Menus follow the menu-button pattern (arrow keys, Home/End, Escape returns focus). The existing `UserMenu` needs arrow-key support. Tabs follow the tabs pattern or are links with `aria-current`.
- **Structure:**
  - one `h1` per page (the page header)
  - landmarks: `nav`, `main`, `header`
  - the skip link is kept
- **Forms:** visible labels always, errors tied by `aria-describedby`, no placeholder-as-label.
- **Live regions:** toasts, async results ("Tax calculated: ₹1,24,800 under the new regime"), assistant answers (`aria-live="polite"` on the turn; focus moves to the answer heading).
- **Figures for screen readers:** the minus sign is announced ("minus ₹32,000") through a visually hidden word next to U+2212. Compact chart figures always have the full figure in the hidden table.
- **Charts:** `role="img"` plus a description plus a hidden data table (kept).
- **Zoom:** usable at 200% and at a 320px viewport with no loss of content.
- **Language:** `lang="en-IN"`. **Change:** currently `en`. Indian English matters for screen-reader number reading.

---

## 27. Reduced-motion behaviour

Under `prefers-reduced-motion: reduce`:

- Page settle, settled-figure reveal, double-rule draw, bar grow and chart draw are **off**. The final state renders immediately.
- The recompute ink wash becomes a **static** 2px accent left rule on changed figures for 2s, so the information is kept without motion.
- Drawers, sheets and dialogs appear with an opacity fade of 120ms or less (no translation).
- The tab indicator and sidebar indicator jump.
- Skeleton pulse is off (a static fill).
- The landing page shows a static composition with no WebGL loop.

Implementation:

- One `@media (prefers-reduced-motion: reduce)` block in `globals.css` zeroes all `--dur-*` tokens except a 1ms floor, so `transitionend` handlers still fire.
- `usePrefersReducedMotion` (kept) covers recharts props.

---

## 28. Component naming conventions

- **Location:**
  - `app/components/ui/` holds primitives with no data fetching.
  - `app/components/` holds composed, app-aware pieces (shell, nav, toaster host).
  - Feature-local components stay next to their route (`app/(app)/taxes/ComputationSheet.tsx`, as today).
- **Files:** one PascalCase component per file, named after the export (`MoneyField.tsx`). Hooks are `useX.ts`. Class helpers are `xClasses()` (as `buttonClasses` today).
- **Props vocabulary:** shared across components so it is learned once:
  - `variant`, `size`, `tone` (semantic colour), `density`, `status`
  - booleans as `is*`/`has*` only where not a native attribute
- **Tokens:**
  - CSS custom properties in kebab-case, grouped by prefix: `--color-*`, `--radius-*`, `--shadow-*`, `--dur-*`, `--ease-*`, `--space-*`
  - Exposed to Tailwind through `@theme inline` (kept), and never hard-coded hex in components
  - `tailwind.config.js` is Tailwind v3 residue and does nothing under v4's CSS config, so it is removed in step 1
- **Copy constants:** state copy (empty, error) lives beside the component that renders it, not in a global strings file. Server-supplied messages (assistant errors, engine refusals) are rendered verbatim, never rewritten.

---

## 29. Page composition rules

Every authenticated page is composed from the same stack:

```
┌ Shell ───────────────────────────────────────────────────────────┐
│ Sidebar │  Header bar (menu · condensed title · theme · account) │
│         ├────────────────────────────────────────────────────────┤
│         │  PageHeader  title / context / [status] [primary]       │
│         │  (Tabs)                                                 │
│         │                                                         │
│         │  Lead: the settled figure or the primary task           │
│         │                                                         │
│         │  Section ── Section ── Section   (48px apart)           │
└─────────┴────────────────────────────────────────────────────────┘
```

1. **Lead with the view's purpose.** That is the settled figure (Summary, Tax result) or the primary task (Ledger entry, Vault upload, Ask composer). Never a row of equal widgets.
2. **Left text, right figures.** Within any section showing money, labels align left and figures align right on a shared edge.
3. **One primary action per view.** It goes in the page header or at the end of the lead form, never both.
4. **Sections, not cards.** A section is a heading plus content. Panels only for forms, tables and self-contained objects.
5. **Show the working.** Every derived figure links or expands to its source: computation line, ledger rows or evidence quote.
6. **Same state components everywhere** (§17–19). A page never invents its own spinner or error box.
7. **Left alignment** for all app content. Centring is reserved for full-page empty states and auth.

### Per-page application (summary; details in the roadmap)

| Page | Lead | Settled figure | Notes |
|---|---|---|---|
| Summary | Savings | Savings (double rule) | Figure row of income and expenses, monthly chart, where money goes, recent activity. Phase 2B layout kept, with new tokens and type. |
| Ledger | Add entry (inline form row above the table, or a drawer on mobile) | Net for the visible period | Income, Expenses and Reports become one table component with a type filter. `alert()` is removed. Edit and delete use the existing routes. |
| Reports | Period selector | none (figure row) | Pie and four stat cards replaced by the chart kit and a figure row. |
| Tax | Inputs form beside the sticky result | Tax payable for the shown regime | Regime comparison as aligned bars, computation sheet with sub-total rules, recompute ink wash, saved runs as a quiet list. |
| Vault | Upload | none | Documents table, Form 16 review with caution-marked extracted values, CSV import as a stepped flow. These steps really are a sequence, so step numbers are justified here. |
| Ask | Composer, or the consent or unavailable state | Tax facts in an answer use the money column | Reading width. The answer shows text, then cited evidence (quote, publisher, section, authority tier, AY), then engine figures rendered by SmartCA components (not model text), then notices verbatim. A "Guidance only" status appears when `authority.guidanceOnly`. |
| Login / Signup | The form | none | `AuthLayout` kept, with the wordmark and mark and the display-face title. |

---

## 30. Open decisions for the owner

These are the places where this proposal needs a yes or no before implementation:

1. **Surface change:** move from warm cream to cool ledger paper (§4)?
2. **Display face:** adopt Anek Latin, subject to the type spike (§3)?
3. **Shared layout:** move pages into an `app/(app)/` route group (§15)? URLs are unchanged.
4. **Ask:** replace the rule-based `/insights` suggestions with the real assistant UI, showing the "isn't switched on" state until a provider is approved? Or keep the rule-based suggestions as a secondary section until then?
5. **Landing:** align the landing page with tokens and type only now, and leave the cinematic rebuild to Phase 8?
