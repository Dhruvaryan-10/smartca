# SmartCA UI Roadmap

_Status: **proposal, for review.** Companion to [SMARTCA-FRONTEND-DESIGN-SYSTEM.md](./SMARTCA-FRONTEND-DESIGN-SYSTEM.md). Drafted 2026-10-02 against `main` at `c38ebc0`._

The order is **design system → components → pages → polish → QA**. Each step is a reviewable, separately committable unit that leaves the app working. No step changes backend logic, the database schema, the authorization, consent or egress logic, or an API contract. If a step finds that it needs one of those, it stops and raises it.

**Gate before step 0:** the owner answers the five open decisions in §30 of the design system.

---

## Step 0: Foundations and decisions (no visible change)

| # | Work | Done when |
|---|---|---|
| 0.1 | Owner decisions on §30 (surface, display face, route group, Ask, landing scope). | Answers recorded in this file. |
| 0.2 | **Type spike.** Load the candidate display face through `next/font`, then confirm the `₹` glyph, `tnum`, U+2212, licence and subset size. Do the same checks on Geist. Render `₹12,45,300.50` and `−₹32,000` at every scale step in both themes. | A screenshot sheet plus a one-paragraph decision. Fallback chosen if needed. |
| 0.3 | **Baseline capture.** Screenshot every route (light, dark, 375px, 1280px). Record the current `npm run build` route sizes and Lighthouse scores for `/dashboard`, `/taxes` and `/login`. | A baseline folder in the scratchpad (not committed) and the numbers recorded here. |
| 0.4 | Confirm the existing test, typecheck and lint baselines (lint has known pre-existing errors). | Numbers recorded, so later steps can show "no new failures". |

## Step 1: Design system in code

The work is tokens and the CSS layer only. Pages change appearance automatically through the tokens and nothing else.

| # | Work | Files |
|---|---|---|
| 1.1 | Replace the colour tokens with the ledger palette for both themes, and keep the old names as aliases (`success` → `positive`, and so on). | `app/globals.css` |
| 1.2 | Add the radius, shadow, duration and easing tokens, and the type scale utilities (`text-figure-xl` … `text-micro`). | `app/globals.css` |
| 1.3 | Add the display face through `next/font` (per 0.2). Set `lang="en-IN"`. | `app/layout.tsx` |
| 1.4 | Add the rule utilities (`.rule-subtotal`, `.rule-total`), the ink-wash keyframes, and the single reduced-motion override block. | `app/globals.css` |
| 1.5 | Remove dead CSS: both duplicate `blob` keyframe sets and `.blob*` classes move into the landing page's own module (they are used only there), and `tailwind.config.js` is removed (Tailwind v4 residue). | `app/globals.css`, `tailwind.config.js`, `app/landing/` |
| 1.6 | Write `docs/design/tokens.md`, a generated or hand-kept table of every token with its contrast pairs. Update the vault note `04 - Design/Design System.md` to point here. | docs |

**QA gate:**
- Contrast script re-run on the final values.
- Every route checked against the baseline screenshots for regressions, such as a hard-coded hex now clashing.
- typecheck, lint (no new errors) and build all pass.

## Step 2: Components

Each component gets every state (default, hover, focus, active, disabled, busy, error) in both themes, plus keyboard behaviour. Components are built in dependency order.

| # | Component | Notes |
|---|---|---|
| 2.1 | `Button` refinements: `outline`, `link`, `danger`, the busy state, the colour-mix hover. | Keep `buttonClasses()` signature-compatible. |
| 2.2 | `Figure`, `FigureRow`, `SettledFigure` (the double rule), `Money` (format plus screen-reader minus). | The identity's core; reused by every page. |
| 2.3 | `MoneyField`, `DateField`, `Textarea`, `Checkbox`, `Radio`, `SegmentedControl`, `FormSection`, `FormActions`. | `MoneyField` emits paise via `lib/format`, with a unit test for the parser. |
| 2.4 | `Panel` (with a `Card` alias), `Section` (kept), `PageHeader` (gains `status`). | |
| 2.5 | `Table` kit: `Table`, `THead` (sticky), `Row`, `Cell` (`numeric`), `TotalRow`, stacked mobile mode, sort header, in-frame states. | Biggest component. Built against the real ledger data shape. |
| 2.6 | `Tabs` (generalised from `LedgerTabs`, sliding indicator). | |
| 2.7 | `Dialog`, `ConfirmDialog`, `Sheet` (on native `<dialog>`). | Focus-return test. |
| 2.8 | `Toaster`, `useToast`. | Mounted once in the shell. |
| 2.9 | `EmptyState`, `ErrorState`, `Skeleton` and `LoadingState` refinements: delayed skeleton (150ms show, 400ms minimum), in-table variants. | |
| 2.10 | Chart kit: `ChartFrame`, `ChartTooltip`, axis presets, `ProportionBars`, `ComparisonBars`. `MonthlyChart` is rebuilt on it. | |
| 2.11 | Icons: add the set listed in §9. Add the brand mark. | |
| 2.12 | `UserMenu`: arrow-key menu pattern. | Accessibility fix. |

**Component review surface:** a dev-only route, `app/(dev)/system/page.tsx`, rendering every component and state in both themes. It is excluded from production by a `NODE_ENV` check in the route itself. There is no Storybook dependency.

**QA gate:**
- Keyboard walk-through of the system page.
- axe check (browser extension) clean.
- Both themes, at 375 and 1280.

## Step 3: Pages

The shell comes first, then pages, ordered from most-used and lowest-risk to most complex. Each page keeps its existing data calls and API usage exactly. Only the presentation changes, plus wiring to routes that already exist (for example, transaction PATCH and DELETE).

| # | Page | Scope |
|---|---|---|
| 3.1 | **Shell and route group.** Move authenticated routes into `app/(app)/` with a shared `layout.tsx` rendering `AppShell` once. Remove the per-page `<AppShell>` wrappers. New sidebar indicator, condensing header, drawer focus trap and `inert`, Toaster host. | URLs unchanged. `proxy.ts` untouched. Verify every route still redirects when signed out. |
| 3.2 | **Login and Signup.** Wordmark and mark, display title, `TextField` kept. Session-expired return path. | Smallest page: proves type and tokens end to end. |
| 3.3 | **Summary.** `SettledFigure` for Savings with its one load moment, `FigureRow`, chart kit, proportion bars, recent activity through the table's list mode. | Layout already right; mostly component swap. |
| 3.4 | **Ledger: Income and Expenses.** One shared ledger view parameterised by type (replaces two copy-pasted files). Inline add row or drawer, `MoneyField`, `DateField`, table with net total, edit via drawer (PATCH), delete via `ConfirmDialog` (DELETE), toasts. Remove `alert()`. Fix the known `set-state-in-effect` lint errors as a side effect of the rewrite. | Uses only the existing `/api/transactions` routes. |
| 3.5 | **Ledger: Reports.** Period filter (client-side over the same data), figure row, chart kit, proportion bars. Remove the rainbow pie and the stat cards. Money through `lib/format` (currently raw `₹${n}`). | |
| 3.6 | **Tax.** Two-column layout on `md+` with a sticky result, `SettledFigure` for tax payable, `ComparisonBars` with the engine notice verbatim, computation sheet with sub-total rules, recompute ink wash, saved runs as a list, the Form 16 suggestion as a caution-marked callout. | No tax logic in the page (unchanged principle). |
| 3.7 | **Vault.** Documents table, upload with progress text, Form 16 review using caution-marked extracted fields and `ConfirmDialog` for delete, CSV import as a stepped flow using the table kit (horizontal scroll, sticky first column). | |
| 3.8 | **Ask.** Per decision 4. Consent panel from `/api/assistant/consent/disclosure`. Composer (Textarea, Send, Cancel). Turn rendering by `Answer.state`, citations with quote, publisher, section, tier and AY, tax facts rendered by SmartCA components from `facts.taxValues` (never from model text), notices verbatim, the "Guidance only" status. Every public error code is mapped per §19. The "isn't switched on" state is the default while configuration refuses external mode. Withdraw consent from the account menu. | Calls only the existing assistant and consent routes. Sends only `{ messages }`. Renders server messages verbatim. |
| 3.9 | **Landing (scope per decision 5).** Default: apply tokens, type, wordmark and copy discipline; remove the blob background and fake pricing CTAs that do nothing (`Choose Plan` buttons with no handler); keep the R3F scene only behind reduced-motion and lazy loading until Phase 8. | Phase 8 owns the cinematic rebuild. |

**Per-page QA gate:**
- loading, empty, error and populated states, each in light and dark, at 375 and 1280
- keyboard only
- reduced motion
- compare against the baseline
- no new lint errors, typecheck, tests, build

## Step 4: Polish

| # | Work |
|---|---|
| 4.1 | Motion pass: verify every transition uses the tokens, then remove anything that moves without answering an action. Tune the settled-figure moment and the ink wash on real data. |
| 4.2 | Copy pass: verb-first actions, matching toast verbs, sentence case, no emoji, no apologetic errors, consistent names (Summary, Ledger, Tax, Vault, Ask) everywhere. |
| 4.3 | Responsive pass at 320, 375, 768, 1024, 1280 and 1600. Check 200% zoom. |
| 4.4 | Dark-mode pass on every surface pairing, chart and focus ring. |
| 4.5 | Optional keyboard shortcuts (`g` + key) and the `/` composer focus on Ask. |
| 4.6 | Favicon and app icon from the brand mark. Remove the unused `public/*.svg` Next.js starter assets. |

## Step 5: QA and hardening

| # | Check | Pass criterion |
|---|---|---|
| 5.1 | Accessibility | axe clean on every route, a manual screen-reader pass (NVDA on Windows) of Summary, Ledger add/edit, Tax calculate and Ask, and a keyboard-only pass of every flow. |
| 5.2 | Performance | No app route's first-load JS grows more than 10% over the 0.3 baseline. No three, R3F or framer-motion imports in `app/(app)/**` (enforced by an ESLint `no-restricted-imports` rule). Fonts subset and `display: swap`. LCP under 2.5s on `/dashboard` on a mid-range mobile profile. |
| 5.3 | Visual regression | Full screenshot set compared against step 0.3 and reviewed by the owner. |
| 5.4 | Contract safety | `git diff --stat` shows no changes under `services/`, `lib/assistant/`, `db/`, `drizzle/`, `tax-engine/` or `app/api/`. The full test suite passes at the step-0.4 baseline count or above. |
| 5.5 | Cross-browser | Chrome, Edge and Firefox on Windows. Safari on iOS (the double-rule rendering, `<dialog>`, sticky headers). |
| 5.6 | Docs | Update the vault notes (`04 - Design/*`, `01 - Product/Navigation.md`, `08 - Phases/Phase 2.md`) and close the Phase 2 open items they list. |

---

## Commit plan (proposed; nothing committed without approval)

- One commit per row group: step 1, then each component cluster in step 2, then each page in step 3.
- Each commit message names the step number. Each commit passes typecheck, tests and build on its own.

## Risks and how they are handled

| Risk | Handling |
|---|---|
| The display face lacks `₹` or `tnum`. | Step 0.2 gates adoption, and the fallbacks are named. |
| The route-group move breaks auth redirects. | Step 3.1 verifies every route signed out. `proxy.ts` is untouched and matches on paths, which do not change. |
| The Ledger rewrite changes API behaviour. | It uses only the existing routes and payloads. The paise conversion goes through a unit-tested parser. |
| The Ask UI tempts rewriting server messages or recomputing figures. | Rule: render `message` and `notices` verbatim, and render tax figures only from `facts.taxValues` through `Money`. Code review checks this specifically. |
| Motion creep. | Every animation must cite the action it answers. Step 4.1 removes anything that can't. |
