# Components

These are principles only. Primitives are built in Step 2 and screens in Step 5. Where a component already exists, it is named.

## Iconography

| Aspect | Rule |
|---|---|
| Library | The existing in-house set in `app/components/ui/Icons.tsx`. No icon dependency. If the set grows past about 30 glyphs, `lucide-react` (same geometry) is the fallback, subject to approval |
| Style | Line icons, `currentColor`, round caps and joins, simple geometric forms. No fills mixed with outlines, no multicolour, no emoji |
| Sizes | 16px (inline with `text-label`, stroke 1.75); 20px (default: navigation, buttons, `text-body`, stroke 1.5); 24px (empty states, stroke 1.5) |
| Stroke philosophy | One optical weight that matches the adjacent text at each size: thin enough to stay quiet, heavy enough to read at 16px |
| Alignment | Centred on the text's cap height. Icons sit on the same 20px grid as nav items and buttons |
| Icon/text spacing | 8px (`gap-2`) in buttons and nav; 6px (`gap-1.5`) in badges and inline labels |
| Semantics | An icon never carries meaning alone. Icon-only buttons have an `aria-label` and a tooltip on pointer devices. Decorative icons are `aria-hidden` |
| Status set | Check (confirmed), alert triangle (needs attention), circle-x (failed), info (guidance) |
| Not allowed | Sparkle or "magic" glyphs for the assistant; trailing arrows inside button labels |

## Buttons

Existing: `Button.tsx`.

| Variant | Look | Use |
|---|---|---|
| Primary | `bg-primary`, `text-primary-foreground` | One per view: the action the view exists for |
| Secondary | `bg-secondary`, ink text | Other actions |
| Outline | Transparent with a `field-border` edge | An alternative beside a primary |
| Ghost | Transparent; hover `surface-sunken` | Toolbars, row actions |
| Danger | `bg-danger`, `danger-foreground` | Only inside a destructive confirmation |
| Link | Primary text, underlined on hover | Inline navigation |

- **Sizes and shape:** 32, 36 or 44px high (44 is the default on touch layouts), with `rounded-control`.
- **Hover:** `primary-hover` or a surface step. Not `filter: brightness`, which washes out in dark mode.
- **Press:** a darker step within `--duration-instant`.
- **Busy:** a spinner replaces the leading icon, the label stays, the width is locked and `aria-busy` is set.
- **Disabled:** 50% opacity, with the reason shown nearby when it is not obvious.
- **Labels:** start with a verb and keep their name through the flow ("Save run" becomes "Saved"). No `+`, arrows or emoji in labels.
- **Full width:** only on compact widths (`layout.md › Guides and safe areas`: "Avoid full-width buttons").

## Inputs and selects

Existing: `Input.tsx`, `TextField.tsx`.

- **Appearance:** `surface-sunken` fill, a 1px `field-border` edge and `rounded-control`. 36px high, or 44px on touch layouts. 16px text below 640px.
- **Focus:** 2px `border-focus` outline. **Invalid:** `danger` edge plus a message.
- **Labels and messages:**
  - The label sits above the control, in `text-label` ink (not muted).
  - A hint sits below, muted.
  - An error sits below in `danger` with an icon, linked through `aria-describedby`, and the control gets `aria-invalid`.
- **Validation** runs on blur, then live after that. Existing `TextField` behaviour is the model.
- **Placeholders** are examples, never labels.
- **Selects** use the native `<select>`, for reliability and mobile pickers.
- **New field types:**
  - `MoneyField`: ₹ prefix, right-aligned tabular input, built on `lib/money-input`.
  - `DateField`: a local date, never `toISOString()`, which is UTC.
  - `Textarea`: grows automatically up to 8 lines.

## Checkboxes, radios, switches

- Native inputs with `accent-color: var(--primary)`. The whole row is the hit target, at least 44px tall on touch layouts.
- Radio groups use `fieldset` and `legend`.
- Switches only for settings that take effect immediately. They use `role="switch"` and a `rounded-pill` track.

## Cards and panels

Existing: `Card.tsx`, which becomes `Panel`.

- A panel is a `surface` sheet with a 1px `border`, `rounded-panel` and `shadow-flat`.
- Use one only for forms, tables and self-contained objects, such as a document or a saved tax run.
- Never put a panel inside a panel. Figures are not cards.

## Tables

For data rules, see [finance-data.md › Tables](finance-data.md#tables).

- Use a real `<table>`.
- Header row: sticky under the top bar, with a `border-strong` rule below.
- Body rows: `h-row` (44px), `divider` lines between rows, and a hover fill only on interactive rows.
- Selected rows: `bg-accent` plus a checkbox.
- Empty, loading and error states render inside the table frame.

## Badges

- A word plus a tone: neutral, success, warning, danger or info.
- `text-micro` at weight 500, `rounded-xs`, a soft tint background with text in the tone colour.
- Never icon-only, never a pill, never clickable.

## Tabs and navigation

- **Tabs navigate between sibling views. They never act** (apple-design skill, platform conventions: "Tabs navigate, they don't act").
  - The indicator is a 2px `border-active` underline.
  - Tabs that are links (existing `LedgerTabs`) use `aria-current="page"`.
  - Tabs that switch panels in place use `role="tablist"` with arrow keys.
- **Sidebar** (from 1024px):
  - 15rem wide, five destinations: Summary, Ledger, Tax, Vault, Ask.
  - The current item has a `surface-sunken` fill, a primary icon and `aria-current`.
  - At most two levels.
- **Top bar:**
  - 56px high.
  - Contains the menu button (compact widths), the page title (which condenses in on scroll), the assessment year, the theme control and the account menu.
- **Breadcrumbs:** only at depth 2 or more, such as a document inside Vault. Use a muted `/` separator; the current item is not a link.

## Dialogs and sheets

- **Dialog:** the native `<dialog>` with `showModal()`, which gives a focus trap, an inert background and Escape for free.
  - `rounded-dialog`, `shadow-modal`, an `--overlay` scrim, at most 32rem wide.
  - One short task with an obvious way out (apple-design skill, interaction lens: "Modal views have an obvious way out and a single short task").
- **ConfirmDialog**, for destructive actions only:
  - States the consequence in one sentence.
  - The danger button is named for the action ("Delete document").
  - Focus starts on Cancel.
- **Not a dialog:** never use one for undoable actions or for information that fits inline.
- **Sheet:** below 640px, dialogs become bottom sheets with rounded top corners and a grabber. They close with a swipe down or with Cancel.
- **Drawer** (mobile navigation only):
  - Traps focus and makes the page behind `inert`.
  - Closes with Escape or a click on the scrim.
  - Returns focus to the menu button.
- **Command palette** (later, optional): Ctrl/⌘ K, using the dialog styling. Never the only route to a command.

## Tooltips

- Only for icon-only controls and abbreviations.
- Appear after a 300ms delay and show on keyboard focus too.
- Styling: `surface-elevated`, `shadow-floating`, `text-label`.
- Never interactive, and never the only place information lives.

## Alerts and notices

- **Inline `Notice`:** `rounded-md`, a soft tint background, an icon, one sentence and an optional action. Tones are info, warning and danger.
- **Error copy:** says what happened and what to do next (`feedback.md › Best practices`: "Show people when a command can't be carried out and help them understand why").
- **Never** `alert()`.
- **Toasts:** one `Toaster` that confirms actions whose result is off screen.
  - A polite live region, at the bottom on mobile and bottom-right on desktop.
  - Toasts persist while hovered or focused.
  - Errors never auto-dismiss (`accessibility.md › Cognitive`: "Minimize use of time-boxed interface elements").

## Charts

See [finance-data.md › Charts](finance-data.md#charts).

## Financial metric blocks

- **Settled figure:**
  - `text-display` with `rule-settled`, plus a one-line caption saying what it is and over what period.
  - At most one per view.
- **FigureRow:** supporting figures in a `<dl>`.
  - The label sits above the figure, with `divider` lines between items.
  - 2 per row on mobile, up to 4 across on wider screens.
- **Comparisons** are stated in words ("₹12,400 more than last month"). Never an arrow or a colour alone.
- **Not allowed:** tinted stat cards, sparkline decoration, or "trend" badges without a stated basis.

## Empty, loading and error states

- **Empty:** says what will appear here and offers the next action. Left-aligned in data views; centred only for a whole empty page. No illustrations.
- **Loading:**
  - A skeleton that matches the final layout. It appears after 150ms and stays at least 400ms (`loading.md › Best practices`: "Show something as soon as possible").
  - Spinners only for small regions and buttons.
  - While recalculating, keep the old result at 60% opacity with `aria-busy`.
- **Error:**
  - Shown inline where the failure happened.
  - Says what happened, whether data is safe, and offers Retry when retrying can help.
  - When the session expires, offer "Sign in again" and return to the same page.
  - A failed fetch never looks like an empty account.

## Provenance marks

A 2px leading rule plus a `text-micro` word, shown only where a figure's source matters.

| Source | Mark | Where |
|---|---|---|
| Tax engine | Ink rule, "Engine" (version on expand) | Tax, assistant facts |
| Ledger | None (the default) | Summary, Ledger |
| Form 16, confirmed | Ink rule, "Form 16" | Tax suggestions |
| Extracted, not confirmed | Warning rule, "Check before confirming" | Vault review |
| Model explanation | No rule; reading type; labelled "Explanation" | Assistant |
| Official guidance | "Guidance · AY 2026-27" | Assistant citations |

## Implemented shared primitives

These live in `app/components/` and are used by Ledger, Tax and Vault:

| Primitive | What it does |
|---|---|
| `ui/Button` | Primary, secondary, outline, ghost and destructive variants. Hover steps the fill (`primary-hover`, `danger-hover`), and a press settles the button to 98% within `instant`. Uses `focus-ring` |
| `ui/Input`, `Select`, `Label`, `FieldMessage` | Token-based fields. 16px text and 44px height on phones, 14px and 36px from 640px. Labels are ink, and `aria-invalid` drives the error style |
| `ui/MoneyField` | ₹ inside the field, right-aligned tabular figures, hint and error wired to the input. Parsing stays in `lib/money-input` |
| `ui/Dialog`, `ConfirmDialog` | Native modal `<dialog>`, centred from 640px and a bottom sheet below. `data-autofocus` picks the first field. `ConfirmDialog` names the action and starts on Cancel |
| `ui/SegmentedControl` | `aria-pressed` toggles for a small set of views (for example the regime shown in the computation sheet) |
| `ui/DropZone` | Choose a file, or drop one. Either way it goes to the page's existing upload handler. The visible button is the keyboard path |
| `request.ts` | The one client JSON helper (`requestJson`, `ApiFailure`, `messageOf`), shared by Ledger, Tax and Vault |
| `ledger/LedgerView` | The shared Ledger view rendered by `/income` and `/expenses` |
| `charts/chart-kit` | Shared chart vocabulary: `ChartLegend`, `TooltipCard`/`TooltipRow`, axis tick, grid and cursor styles, and the bar animation duration. Used by the Summary and Reports charts |
| `charts/SpendingBreakdown` | Composition bar plus ranked category list (steps of expense coral). Used by Summary and Reports |
| `ui/SegmentedControl` `stretch` | Full width with equal segments on phones |

## Page notes (implemented)

- **Ledger** (`/income`, `/expenses`):
  - Totals row: all time, this month, and largest category.
  - Search, category and month filters.
  - Entries grouped by month, under sticky month headers that show each month's total.
  - Each row is a button that opens the entry for editing; delete sits at the row's end from 640px and inside the edit sheet on phones.
  - Adding and editing use the existing POST and PATCH endpoints; deleting uses DELETE behind `ConfirmDialog`.
  - A just-saved row gets the recompute wash. Tabs carry green and coral dots.
  - The filtering, grouping and form logic is in `lib/ledger-view.ts`, which is tested.
- **Tax:**
  - Inputs sit in panels on the left, with the result sticky beside them from 1024px.
  - Below 1024px, a new result scrolls into view and receives focus.
  - Regime cards show the engine's totals, washed when they change, and a gold "₹X lower" badge that states the number without recommending a regime.
  - The computation sheet lists the working first and the total at the foot. Subtotals sit under a single rule; the final tax is set on the double rule.
  - Assumptions sit behind a disclosure.
- **Reports** (`/reports`):
  - A figure row: income (green), expenses (coral), savings by its sign, and the savings rate with a true minus sign.
  - "By calendar month" offers Income and expenses or Net savings, shown as a chart or a table.
  - The net chart draws bars above or below a zero line. The table has a total row on the double rule.
  - The expense breakdown uses `SpendingBreakdown`.
  - The existing calculations are kept exactly, including monthly buckets by calendar month with all years combined. The page labels that grouping.
  - Designed loading, empty and error states.
- **Ask (insights):**
  - The rule-based tips are unchanged. Each one shows as a worded tone (Good, Watch, Tip) with a matching edge instead of an emoji.
  - A note points to Ask SmartCA for real questions.
  - Designed loading, empty and error states.
- **Vault:**
  - Two drop zones: Form 16 PDF and bank-statement CSV.
  - Every document row gives its status as a word, a dot and a sentence. "Reading" pulses, and is static under reduced motion.
  - Form 16 review opens in a large sheet, with the confirm action pinned to its bottom.
  - CSV import shows a three-step indicator, scrolling tables with sticky headers, and income and expense badges.

## Ask SmartCA button and panel (implemented)

`app/components/assistant/`, mounted once by the app shell.

- **Button:**
  - A 56px circle at the bottom right, inset by the larger of 20px or the safe-area inset plus 12px.
  - Filled with the assistant accent, with a resting 4px halo that widens to 7px on hover and focus.
  - The label "Ask SmartCA" is its accessible name and also a tooltip. It shows after 300ms on hover and at once on keyboard focus.
  - It settles in once on first load and never pulses.
  - On phones it steps aside while you scroll down, so it never covers the right-hand money column. It returns when you scroll up, reach the end of the page, or focus it by keyboard.
  - It sits inside the inert content column, so it can't be reached while the navigation drawer is open.
  - The page has 7rem of bottom padding so the last content is never hidden behind it.
- **Panel:**
  - A native modal `<dialog>`, shaped as a 30rem sheet from the right edge, or a near-full-height bottom sheet on phones.
  - Focus trap, inert page, Escape, a close button and a backdrop click all come from the platform. Focus returns to the button.
  - Closing the panel cancels any question in flight.
- **Flow:**
  1. Checks consent, then shows one of the states below.
  2. **Not switched on** (configuration errors): the server's message, an honest explanation, and a link to the rule-based insights page.
  3. **Consent review:** the disclosure exactly as the server sent it, with field lists behind disclosures. "Allow for N days" or "Not now".
  4. **Ready:** example questions, then the conversation.
- **Conversation:**
  - "You asked", then the answer behind an assistant-accent rule.
  - "Working on your question…" with Cancel while waiting.
  - Retryable failures offer "Try again".
- **Composer:** Enter sends and Shift+Enter adds a new line. 16px text on phones.
- **Footer:** the permission's expiry and a "Withdraw" action.
- **Security:**
  - Answers render only as plain text, through `AnswerView`.
  - Evidence links must be http(s).
  - Nothing is stored in the browser.
  - The client sends only `{ messages }` and the exact consent grant body.

## Assistant

These rules apply in Step 6.

- **Off by default.** The default state today is "assistant isn't switched on". It is designed as a first-class state, not an error (`generative-ai.md › Best practices`: "Ensure a great experience even when generative features aren't available").
- **Consent first:**
  - A `ConsentPanel` rendered from the disclosure endpoint exactly as returned.
  - Grant and "Not now" choices.
  - Permission can be withdrawn from the account menu (`generative-ai.md › Privacy`: "Ask permission before using personal information").
- **Answers read like working papers:**
  - Model text is plain text only, set in `text-body-lg` and labelled "Explanation". Never rendered as HTML or markdown.
  - Figures come only from `facts.taxValues`, carry engine marks, and link to numbered citations.
  - Notices are shown verbatim.
- **Waiting:** "Working on your question…" with a Cancel button. No typing simulation (`generative-ai.md › Outputs`: "Consider giving specific, reassuring feedback during generation").
- **Errors:** every error code maps to a fixed treatment. Retry only when the error is retryable, and only when the person asks.

## Architecture

Each layer depends only on the layers above it.

```
FOUNDATION   globals.css tokens · type · spacing · radius · elevation · icons · motion   (Step 1, done)
PRIMITIVES   components/ui/  — no data fetching, no SmartCA knowledge
             Button IconButton Input Select Textarea Checkbox Radio Switch MoneyField DateField
             Label FieldMessage TextField Badge Tooltip Menu Tabs SegmentedControl
             Dialog ConfirmDialog Sheet Notice Toaster Skeleton Spinner Money ProvenanceMark Icons
COMPOSITION  components/ui/ (+ components/ui/chart/) — layout patterns, still data-agnostic
             PageHeader Section Panel FigureRow SettledFigure DataTable FilterBar
             FormSection FormActions EmptyState LoadingState ErrorState
             ChartFrame ChartTooltip ProportionBars ComparisonBars
APPLICATION  route folders + components/ — know SmartCA data and APIs
             AppShell Sidebar Topbar UserMenu LedgerView ComputationSheet RegimeComparison
             DocumentList Form16Review CsvImport ConsentPanel AnswerTurn Composer AssistantError
```

Conventions:

- One component per file, named in PascalCase.
- Props are named for meaning (`tone="danger"`, not `color="red"`), and variants are string unions.
- `className` is passed through for layout only.
- Every focusable primitive forwards its ref.
- Primitives never import from application folders.
- A dev-only Design Lab route (behind `proxy.ts`, `notFound()` in production) renders every primitive and state in both themes.
