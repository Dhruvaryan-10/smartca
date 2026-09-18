# SmartCA Repository Audit

**Scope:** Read-only inspection of the existing SmartCA repository as it stands today. No application code, configuration, or data was modified to produce this document.

**Repository root:** `C:\Users\Asus\OneDrive\Documents\Desktop\SmartCA`
**Branch:** `main` (up to date with `origin/main`)
**Commits:** 2 total — `545ef52 Initial commit`, `02d1d17 fixed sidebar props`

---

## 1. Executive Summary

SmartCA today is an early-stage prototype, not a production system. It consists of a Next.js 16 / React 19 frontend and a separate Flask backend that barely talk to each other. Only the OTP login/signup flow uses the Flask backend; every financial page (dashboard, income, expenses, taxes, reports, "AI insights") reads and writes through a **second, completely unauthenticated Next.js API route backed by a Mongoose schema with no user field at all**. The practical effect: any client — logged in or not — can read and write every user's income/expense transactions. This is the single most important finding in this audit and should gate everything else.

Beyond that, the tax calculator is a hardcoded, unversioned, pre-deduction flat-slab formula living inside a React component; "AI Insights" is deterministic if/else logic with no LLM involved; and there is no deployment configuration for the backend at all (login is hardcoded to `http://localhost:5000`, so the app cannot function once deployed).

None of this is a criticism of the work so far — it's a reasonable scaffold to iterate from. But it means the "target v2 architecture" described in project context is a rewrite of the data layer and tax/AI logic, not an incremental upgrade. The UI shell, page structure, and visual direction are worth keeping; the data model, auth wiring, and backend split are not.

---

## 2. Current Repository Structure

```
SmartCA/
├── package.json                 # orphaned — 4 deps (three.js/r3f/framer-motion), no name/scripts
├── .gitignore                   # node_modules, .next, .env
├── backend/
│   ├── app.py                   # single-file Flask app (415 lines)
│   ├── .env                     # MONGO_URI, SECRET_KEY (gitignored, not committed)
│   └── venv/                    # Python virtualenv (self-gitignored, not committed)
├── frontend/
│   ├── app/
│   │   ├── page.tsx             # redirects "/" -> "/landing"
│   │   ├── layout.tsx           # root layout, Geist font
│   │   ├── globals.css
│   │   ├── landing/page.tsx     # marketing/landing page
│   │   ├── login/page.tsx       # phone + OTP login (calls Flask)
│   │   ├── signup/page.tsx      # phone + OTP signup (calls Flask)
│   │   ├── dashboard/page.tsx   # charts, stat cards
│   │   ├── income/page.tsx      # income CRUD form + list
│   │   ├── expenses/page.tsx    # near-duplicate of income/page.tsx
│   │   ├── taxes/page.tsx       # client-side tax calculator + UI
│   │   ├── reports/page.tsx     # charts (duplicates dashboard logic)
│   │   ├── insights/page.tsx    # rule-based "AI insights"
│   │   ├── components/
│   │   │   ├── Navbar.tsx
│   │   │   ├── Sidebar.tsx
│   │   │   └── FinanceAIModel.jsx   # decorative Three.js/R3F neural-sphere
│   │   └── api/
│   │       └── transactions/route.ts   # UNAUTHENTICATED Mongoose CRUD
│   ├── lib/mongodb.ts           # mongoose connection helper
│   ├── models/Transaction.ts    # schema — no user/owner field
│   ├── .env.local               # MONGO_URI (gitignored, not committed)
│   ├── .git/                    # orphaned nested repo (see §11)
│   ├── package.json
│   └── (standard Next.js config: next.config.ts, tsconfig.json, tailwind.config.js, eslint.config.mjs, postcss.config.mjs)
├── .claude/, .serena/           # tooling directories, untracked
└── graphify-out/                # incomplete graphify run (cache only, no graph.json/wiki)
```

Two commits, both already on `main`, nothing staged or stashed. `git status` is clean apart from newly-added tooling directories (`.claude/`, `graphify-out/`, this audit's `CLAUDE.md`), all untracked.

---

## 3. Current Architecture

Two independent stacks that share a MongoDB cluster but not a data model:

1. **Flask backend** (`backend/app.py`) — PyMongo, JWT auth, OTP login. Owns `db.smartca.{otp,users,income,expenses}`.
2. **Next.js backend** (`frontend/app/api/transactions/route.ts`) — Mongoose, no auth. Owns a single `transactions` collection in whatever database `frontend/.env.local`'s `MONGO_URI` points at.

**Every page the user actually navigates to (dashboard, income, expenses, taxes, reports, insights) talks only to path 2.** The Flask income/expense/dashboard-summary/analytics endpoints (`/get-income`, `/get-expense`, `/add-income`, `/add-expense`, `/dashboard-summary`, `/monthly-analytics`, `/category-analytics`) are fully implemented and properly user-scoped, but **nothing in the frontend calls them**. They are effectively dead code today.

The only live integration between frontend and Flask is OTP login/signup (`/send-otp`, `/verify-login-otp`, `/verify-signup-otp`), and that integration is hardcoded to `http://localhost:5000`.

---

## 4. Current Frontend

- **Framework:** Next.js `16.1.6`, App Router, all pages are `"use client"` components (no server components/actions in use).
- **React:** `19.2.3` / React DOM `19.2.3`.
- **TypeScript:** `^5`, used throughout except `FinanceAIModel.jsx` (plain JS) and loose `any` typing in income/expenses pages.
- **Styling:** Tailwind CSS `^4.2.0` (via `@tailwindcss/postcss`), dark, glassmorphism-style UI (`bg-[#020617]`, `bg-white/5`, `backdrop-blur`), consistent color language (teal/emerald accents) across pages.
- **Charts:** `recharts` (LineChart, PieChart) on dashboard and reports.
- **Animation:** `framer-motion` for entrance transitions on login/signup; `@react-three/fiber` + `@react-three/drei` + `three` for a single decorative 3D "neural sphere" (`FinanceAIModel.jsx`), shown only on login and signup.
- **Pages:** landing, login, signup, dashboard, income, expenses, taxes, reports, insights — all present and rendering, all client-side data-fetched from `/api/transactions`.
- **Layout/components:** `Sidebar.tsx` (hardcoded 6-item nav menu) and `Navbar.tsx` (search input is decorative/non-functional, profile is a static "User" placeholder, logout just clears `localStorage`) are shared across authenticated pages but are not composed into a shared layout — each page imports and renders them individually (duplication, see §12).
- **No route protection:** no `middleware.ts`, no auth-guard wrapper, no redirect-if-no-token logic anywhere. Any page is reachable directly by URL with no session.
- **No tests:** zero `*.test.*`/`*.spec.*` files anywhere in the repo.

---

## 5. Current Backend

Single-file Flask app (`backend/app.py`, 415 lines, no blueprints/modules). Routes:

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/` | GET | none | health check |
| `/send-otp` | POST | none | generates OTP, stores in `db.otp`, **prints OTP to server stdout** (no real SMS delivery) |
| `/verify-login-otp` | POST | none | validates OTP, issues JWT (1-day expiry) |
| `/verify-signup-otp` | POST | none | validates OTP, creates user doc, issues JWT |
| `/dashboard-summary` | GET | JWT | income/expense/savings totals, scoped by `phone` |
| `/get-income`, `/get-expense` | GET | JWT | list, scoped by `phone` |
| `/add-income`, `/add-expense` | POST | JWT | insert, scoped by `phone` |
| `/monthly-analytics` | GET | JWT | 12-month income/expense series |
| `/category-analytics` | GET | JWT | expense-by-category aggregation |

Auth model: phone number + OTP, no password. `get_current_user()` decodes the bearer JWT and returns the `phone` claim — every data query below it is correctly filtered by that phone. **In isolation, the Flask backend's authorization logic is sound** (§7 details the flaws that surround it: insecure default secret, no rate limiting, wide-open CORS, fake OTP delivery).

There is no `requirements.txt`, `Pipfile`, `pyproject.toml`, `Procfile`, or `Dockerfile` — dependencies (`flask`, `flask_cors`, `pymongo`, `python-dotenv`, `pyjwt`, `certifi`) are only installed in the local `venv/`, with no reproducible manifest checked in.

---

## 6. Current Database

**MongoDB**, used two disconnected ways:

1. **PyMongo / Flask** (`db.smartca` on the cluster in `backend/.env`'s `MONGO_URI`): collections `otp`, `users`, `income`, `expenses`. Documents keyed by `phone`; no explicit schema/validation (plain dicts). Amounts stored as Python `float`.
2. **Mongoose / Next.js** (`frontend/models/Transaction.ts`, on whatever database `frontend/.env.local`'s `MONGO_URI` points at — may or may not be the same cluster/db as #1): a single `transactions` collection with schema:
   ```ts
   { type: "income"|"expense", amount: Number, category: String, date: Date }
   ```
   **No user/owner field of any kind.** Every transaction from every signup shares one flat collection.

No relationships, no indexes defined, no migrations, no tax-data or document/report storage of any kind — tax figures are computed on the fly from transactions, never persisted.

---

## 7. Current Authentication

- **Mechanism:** phone number + 6-digit OTP (5-minute expiry), no password at all. JWT (`HS256`) issued on success, 1-day expiry, payload `{ phone, exp }`.
- **Token storage:** `localStorage.setItem("token", ...)` in the browser (`login/page.tsx`, `signup/page.tsx`). No httpOnly cookie.
- **Token usage:** the JWT is **never attached to any request** after login. `Navbar.tsx`'s logout removes it from storage, but no fetch anywhere (dashboard, income, expenses, taxes, reports, insights) sends an `Authorization` header. The token is issued and then effectively unused — which is consistent with the frontend never calling the JWT-protected Flask endpoints in the first place.
- **Authorization checks:** present and correct on the Flask side (`get_current_user()` gates every data-bearing route and filters by the token's `phone`). **Absent entirely** on the Next.js `/api/transactions` route, which is the route actually in use.
- **Can one user access another's data?** Yes, trivially, via the live code path: `GET /api/transactions` returns every transaction in the collection to anyone, authenticated or not; `POST /api/transactions` accepts writes from anyone with no owner association.

---

## 8. Current Tax Implementation

Located entirely in `frontend/app/taxes/page.tsx`, inside the `TaxesPage` component:

```ts
const calculateTax = (income: number) => {
  let tax = 0;
  if (income <= 250000) tax = 0;
  else if (income <= 500000) tax = (income - 250000) * 0.05;
  else if (income <= 1000000) tax = 250000*0.05 + (income - 500000)*0.2;
  else tax = 250000*0.05 + 500000*0.2 + (income - 1000000)*0.3;
  return tax;
};
```

Findings:
- **Hardcoded, unversioned slabs** — no assessment year is named or configurable anywhere in the codebase.
- **Single regime only** — resembles an old-regime-like flat slab table but omits old-regime deductions; there is no new-regime option, and no old-vs-new comparison.
- **No standard deduction, no Section 87A rebate, no cess (4%), no surcharge** — none of these appear anywhere in the calculation.
- **Computed on gross income, not taxable income** — `totalIncome` is the raw sum of all `type: "income"` transactions; no deductions (80C, HRA, etc.) are subtracted first.
- **Floating point arithmetic** throughout (`number`), no integer-paise handling, no defined rounding rule.
- **Not independently testable** — it's a closure inside a client component, not an exported pure function; there are no unit tests anywhere in the repo.
- **UI and logic are fully intermingled** — the same function that computes tax also drives the rendered slab table text (which is itself hand-written JSX, not derived from `calculateTax`'s slab data — so the displayed slab table and the actual computation could silently drift).
- **Feeds off the unscoped `/api/transactions` data**, so even setting correctness aside, the "Total Income" figure it taxes may include other users' transactions.

---

## 9. Current AI Implementation

There is **no LLM, no external AI API call, no RAG, no embeddings, no tool-calling** anywhere in this repository. Two things are currently labeled "AI":

1. **`/insights` page** ("AI Financial Insights") — `generateInsights()` in `frontend/app/insights/page.tsx` is a plain deterministic function: savings-rate threshold bands, a max() over a category map, a couple of `if` comparisons (expenses > income, income transaction count < 2, expense count > 5), and one arithmetic projection (`totalExpense * 0.1`). It produces a fixed set of canned strings depending on which conditions are true. No model call, no randomness beyond the data itself.
2. **`FinanceAIModel.jsx`** — a decorative Three.js/React-Three-Fiber "neural sphere" (random points + nearest-neighbor connecting lines, auto-rotating) shown next to the login/signup forms. It is a visual flourish only, not a functional model — no math beyond `Math.random()` point placement and distance-thresholded line drawing.

Nothing here needs to be "fixed" so much as **built for the first time** — the target v2 AI assistant (RAG + tool-using assistant with the tax engine doing calculations) has no existing implementation to migrate.

---

## 10. Current Deployment

- **No `vercel.json`**, no `.github/` directory (no CI/CD of any kind), no `Procfile`/`Dockerfile`/`requirements.txt` for the Flask backend.
- **Frontend** is a stock `create-next-app`-shaped project; it would deploy to Vercel with zero extra config for the *build*, but would be non-functional once live because:
  - `login/page.tsx` and `signup/page.tsx` hardcode `http://localhost:5000` for every OTP call — no environment-variable-based API base URL exists.
  - `frontend/.env.local`'s `MONGO_URI` is not present as a Vercel project environment variable anywhere in the repo (no `.env.example` either), so there's no documented path to configure it for a deployed build.
- **Backend** has no hosting target defined at all (no Render/Railway/Fly config, no Dockerfile, no pinned dependency manifest) — it currently only runs via `python app.py` on `localhost:5000` with Flask's debug server (`app.run(debug=True)`, not production-safe).
- **What currently "works":** the app functions only when both `next dev` and `python app.py` are run locally side by side, on the same machine, on their default ports. Nothing currently works in any deployed environment.

---

## 11. Security Findings

Secrets are redacted below; values are known to the auditor and the user but not reproduced here.

| # | Severity | Finding | Location |
|---|---|---|---|
| 1 | **CRITICAL** | Real MongoDB Atlas credentials (username + password) are hardcoded as the fallback default for `MONGO_URI`, and this line is committed to git history in the initial commit — not just present in a gitignored `.env`. | `backend/app.py:25-28` |
| 2 | **CRITICAL** | `/api/transactions` (the route the entire live UI depends on) has no authentication or authorization check of any kind, and its underlying schema has no user/owner field — every visitor can read and write every user's financial transactions. | `frontend/app/api/transactions/route.ts`, `frontend/models/Transaction.ts` |
| 3 | **HIGH** | `SECRET_KEY` used to sign/verify JWTs has an insecure hardcoded fallback (`"supersecret"`) if the env var is absent — if this ships to an environment missing `SECRET_KEY`, tokens become trivially forgeable. | `backend/app.py:19` |
| 4 | **HIGH** | JWT is stored in `localStorage`, not an httpOnly cookie — readable by any script on the page, i.e. vulnerable to token theft via XSS. | `frontend/app/login/page.tsx:71`, `signup/page.tsx:67` |
| 5 | **HIGH** | No frontend route protection exists at all — every "authenticated" page renders and fetches without checking for a session/token first. | all pages under `frontend/app/*` except landing/login/signup |
| 6 | **MEDIUM** | OTP is never actually delivered — it's printed to server stdout only, with no SMS gateway integrated. Acceptable for local dev, not for anything resembling production. | `backend/app.py:110` |
| 7 | **MEDIUM** | CORS is fully open (`CORS(app)`, no origin allowlist) on the Flask backend. | `backend/app.py:17` |
| 8 | **LOW** | No rate limiting on `/send-otp` or `/verify-*-otp` — a 6-digit OTP is brute-forceable within its 5-minute window absent throttling, and OTP-send is spammable. | `backend/app.py` |
| 9 | **LOW / informational** | `.env` files (both `backend/.env` and `frontend/.env.local`) are correctly gitignored and were confirmed **not** present in git history — good practice already in place. | `.gitignore`, `frontend/.gitignore` |
| 10 | **Housekeeping** | `frontend/.git/` is an orphaned nested Git repository (not a submodule — `frontend/` is tracked as a normal directory tree by the root repo). Not a security issue, but confusing and worth removing. | `frontend/.git/` |

**Bottom line on user isolation:** the properly-scoped, phone-filtered Flask endpoints exist and are correct in isolation, but the app doesn't use them for any financial data — it uses the unauthenticated Mongoose route instead. **Rotate the exposed MongoDB credentials immediately** (finding #1) regardless of any other remediation timeline, since they are visible in git history to anyone with repo access.

---

## 12. KEEP / REFACTOR / REWRITE / REMOVE / DEFER

| Existing subsystem/file | Decision | Reason |
|---|---|---|
| `frontend/app/landing/page.tsx` | KEEP | Marketing page; reasonable starting point for the future cinematic landing page direction. |
| `frontend/app/components/FinanceAIModel.jsx` | KEEP | Working, self-contained R3F visual; fits the "one meaningful Three.js scene" target directly. |
| Tailwind dark/glass visual language (colors, card treatment, spacing) across all pages | KEEP | Consistent, deliberate, reusable as a design starting point even as components are rebuilt underneath. |
| `frontend/app/components/Sidebar.tsx`, `Navbar.tsx` | REFACTOR | Right idea (shared shell), wrong execution — hardcoded nav items, decorative-only search, static "User" label, not composed into a shared layout (each page re-imports both). Rebuild as a real layout + real session-aware profile data. |
| `frontend/app/dashboard/page.tsx`, `reports/page.tsx` | REFACTOR | Near-duplicate chart/aggregation logic (`generateMonthlyData`, category grouping) copy-pasted between the two files; consolidate into shared data hooks once the data layer is rebuilt. |
| `frontend/app/income/page.tsx`, `expenses/page.tsx` | REWRITE | Confirmed line-for-line copy-paste of each other (diffed); should become one parameterized ledger view backed by the new service layer, not two near-identical files. |
| `frontend/app/taxes/page.tsx` | REWRITE | UI shell (cards, slab table layout) is reusable, but `calculateTax` must be replaced entirely by the versioned, tested tax engine — current logic is hardcoded, untested, pre-deduction, and UI-embedded. |
| `frontend/app/insights/page.tsx` | REWRITE | `generateInsights()` is rule-based, not AI; the target RAG/tool-using assistant is a ground-up build, not a migration of this function (though the card-list UI shell can be kept). |
| `frontend/app/login/page.tsx`, `signup/page.tsx` | REWRITE | UI/animation shell worth keeping; the auth flow underneath (hardcoded `localhost:5000`, OTP-only/no-password, no session cookie) must be rebuilt on Auth.js/session auth per the target architecture. |
| `frontend/app/api/transactions/route.ts`, `frontend/models/Transaction.ts` | REMOVE | This is the unauthenticated, unscoped data path causing the critical cross-user leak (§11 #2). Must be deleted, not patched, once a real service layer with user-scoped Postgres/Drizzle access replaces it. |
| `backend/app.py` (Flask, entire) | REMOVE (after extracting logic) | The target architecture is Next.js + Postgres/Drizzle with no separate Flask service. The *authorization pattern* (JWT → phone → scoped query) is worth reading as a reference for correct scoping before it's deleted, but the file itself, PyMongo, and the Mongo schema-less documents don't carry forward. |
| Root `package.json` | REMOVE | Orphaned — four dependencies, no name/scripts/lockfile-consistent purpose; appears to be a stray leftover, not part of either app's build. |
| `frontend/.git/` (nested repo) | REMOVE | Orphaned nested repository; not used by the root repo's tracking (frontend files are tracked directly by root git). Pure housekeeping. |
| `graphify-out/` (current partial state) | DEFER | Incomplete graphify run (cache only, no `graph.json`/wiki yet); re-run `graphify update .` once the codebase stabilizes post-migration rather than now. |

---

## 13. What Existing Work Should Be Preserved

- **Visual/design language:** the dark glassmorphism palette, spacing, card treatment, and gradient stat cards are consistent across every page and align well with the "Apple-inspired, restrained cards" target — worth carrying forward as a starting aesthetic even as components are rebuilt.
- **`FinanceAIModel.jsx`:** a working, tasteful, self-contained Three.js/R3F scene — directly reusable for "one meaningful particle scene" in the target marketing direction.
- **Page inventory/IA:** the five-ish page groupings (dashboard, income, expenses, taxes, reports, insights) map reasonably well onto the target's five areas (Summary, Ledger, Tax, Vault, Ask) — the *shape* of the product doesn't need reinvention, just the underlying data and logic.
- **Flask's authorization pattern:** `get_current_user()` → phone claim → filter every query by it is the *correct* shape of user-scoped access control, even though the file itself is being removed. It's a useful reference for how the new service layer should filter every query by the authenticated user's id.
- **Category/insight framing:** the specific savings-rate bands and category-concentration heuristics in `generateInsights()` aren't AI, but they're reasonable **rule-based fallback signals** that could still inform tool outputs the future AI assistant surfaces (e.g., as one of several tools it can call), even though the assistant itself needs to be built new.

## What Should Be Discarded

- Both Mongo data paths (PyMongo `income`/`expenses` collections and the unscoped Mongoose `transactions` collection) — neither matches the target Postgres/Drizzle/paise-integer model.
- The OTP-only, no-password, localStorage-JWT auth flow — replaced wholesale by Auth.js/session auth per the target architecture.
- `calculateTax()` and `generateInsights()` as implementations (not as UI shells) — neither is deterministic-tested, versioned, or correct enough to extend; they're prototypes to learn from, not code to inherit.
- The Flask backend as a running service — its existence as a second backend is itself the architectural problem the target design (single Next.js service layer) is meant to resolve.

---

## 14. Migration Risks

- **Credential exposure is live right now**, independent of any migration timeline — the committed MongoDB credentials should be rotated before or in parallel with anything else, not after.
- **The cross-user data leak (§11 #2) is exploitable in the current deployed-or-local app today** — if this app is reachable by anyone other than the developer right now, that's an active incident, not just a migration backlog item.
- **No tests exist anywhere**, so there is no safety net for the tax engine rewrite or the auth rewrite — regressions will only be caught by manual verification unless tests are written as part of Phase 0/1 (the user's own priority list already puts "Tests" at position 7).
- **Two Mongo data paths must be reconciled or abandoned carefully** — any existing user data currently sitting in either `db.smartca.income`/`expenses` (Flask/PyMongo) or the `transactions` collection (Mongoose) should be inventoried before deletion, in case real data (even test data the user cares about) is sitting in either collection.
- **Hardcoded `localhost:5000`** means the auth flow has apparently never been exercised outside local dev — there's no evidence the deployed app has ever worked end-to-end, which lowers migration risk in one sense (nothing "in production" to preserve) but means there's no working baseline to regression-test against either.

---

## 15. Proposed Migration Sequence

Following the priority order already given, mapped to what was actually found:

1. **Backup/checkpoint** — tag or branch the current `main` before any destructive change; export any real data sitting in the two existing Mongo collections if it matters.
2. **Security** — rotate the exposed MongoDB credentials (§11 #1) immediately; this is independent of everything else and shouldn't wait for the rest of the migration.
3. **Database** — stand up Postgres + Drizzle schema (users, transactions with integer paise, tax computations) fresh; no existing schema is worth migrating as-is, but the *shape* of Flask's `income`/`expenses` documents (phone, title, amount, category, date) is a reasonable field list to start the new schema from.
4. **Authentication** — replace OTP-only/localStorage-JWT with Auth.js/session auth; decide whether phone-OTP login is kept as a login *method* under the new session system or replaced by email/password — this is a product decision, not just a technical one (see §21 open questions).
5. **User isolation** — implement the service layer so every query is scoped server-side by the authenticated session's user id (mirroring the correct pattern Flask already demonstrated, just enforced consistently everywhere, unlike today).
6. **Tax engine** — build the deterministic, versioned AY 2026-27 engine as pure, independently-tested functions, replacing `calculateTax()`.
7. **Tests** — cover the tax engine and the service-layer authorization boundary first (the two areas with zero existing coverage and the highest correctness/security stakes).
8. **Working core application** — rebuild Summary/Ledger/Tax pages against the new service layer, retiring `/api/transactions` and the Flask backend once parity is reached.
9. **Documents** — Form 16 upload/extraction (net-new; nothing exists today).
10. **RAG** — tax-law retrieval (net-new).
11. **AI assistant** — tool-using assistant that calls the service layer/tax engine rather than calculating itself (net-new; today's `generateInsights()` is not a starting point, just a reference for the kind of heuristics it might expose as one tool among several).
12. **Design polish** — apply the Apple-inspired grouped-list/sheet treatment on top of the salvaged Tailwind visual language.
13. **Cinematic landing page** — build on the existing `landing/page.tsx` and `FinanceAIModel.jsx` foundation.
14. **Additional features** — per §17 below.

---

## 16. P0/P1/P2 Feature Priorities

**P0 — required for SmartCA to work correctly:**
- Rotate exposed Mongo credentials.
- Remove the unauthenticated `/api/transactions` path and its schema-less collection.
- Single, user-scoped data layer (Postgres/Drizzle) with server-side authorization on every query.
- Real session authentication (Auth.js) wired through every protected page and API call.
- Deterministic, tested tax engine (AY 2026-27, old/new regime, cess/surcharge/rebate/standard deduction) replacing `calculateTax()`.
- A working deployment path (env-configurable API base URL, no hardcoded `localhost`, backend consolidated into Next.js so there's nothing separate to host).

**P1 — important product improvements:**
- Form 16 upload + structured extraction with human review before commit.
- CSV transaction import.
- Old-vs-new regime comparison and simple simulation in the Tax area.
- Real user profile data in the Navbar (replacing the static "User" placeholder) and functional search.
- Shared authenticated layout (replacing per-page Sidebar/Navbar duplication).
- Basic test suite covering the tax engine and auth/authorization boundary (already called out as P0-adjacent in the migration sequence, but ongoing coverage growth is P1).

**P2 — advanced/wow features:**
- Tax-law RAG + evaluated retrieval.
- Tool-using AI assistant (Ask) that queries the service layer/tax engine rather than calculating independently.
- Cinematic scroll-driven landing page (GSAP/ScrollTrigger) built on the existing `FinanceAIModel.jsx` foundation, with CSS fallback.
- Any additional features not yet specified by the user (placeholder — see below).

**Future / Additional Features:** the user has indicated there are more features to be added later that haven't been specified yet. Where they land (P0/P1/P2) can't be determined until they're described — this section is a placeholder to slot them into once defined, rather than a commitment to build anything specific now. As a rule of thumb consistent with the priorities above: anything required for correctness or security is P0, anything that meaningfully improves the core five-area product is P1, and anything that's additive/novel on top of a working core is P2.

---

## 17. Proposed Phase 0

Scope: make the current critical exposure safe and establish the new foundation, without yet rebuilding product features.

- Rotate MongoDB Atlas credentials; confirm the old ones are fully revoked.
- Remove `frontend/app/api/transactions/route.ts` and `frontend/models/Transaction.ts` (or gate them behind auth as a stopgap only if the app must stay minimally functional during the cutover — but plan to delete, not patch).
- Stand up Postgres + Drizzle; define the initial schema (users, transactions in integer paise, sessions).
- Wire Auth.js and a minimal session-protected route to prove the pattern end-to-end.
- Delete the orphaned root `package.json` and the orphaned `frontend/.git/` nested repo (housekeeping, zero risk, but do it once rather than let it linger).
- Write the first tests: the eventual tax engine's slab math, and an authorization test proving a user cannot fetch another user's records through the new service layer.

## 18. Proposed Phase 1

Scope: rebuild the working core application on the new foundation.

- Auth.js login/signup flow (decide on phone-OTP vs. email/password — see open questions) replacing the Flask OTP flow.
- Summary (dashboard) and Ledger (income/expenses, unified rather than duplicated) pages against the new service layer.
- Tax engine v1 (AY 2026-27, deterministic, versioned, independently tested) wired into a rebuilt Tax page.
- Shared authenticated layout (Sidebar/Navbar rebuilt once, composed, not duplicated per page).
- Deployable end-to-end on Vercel with no hardcoded localhost references and Postgres reachable from the deployed environment.
- Decommission `backend/app.py` and the Flask process once the above reaches feature parity with what's actually in use today (i.e., OTP login parity, since that's the only Flask code path currently exercised by the UI).

---

## 19. What We Should Explicitly NOT Build Yet

- The tax-law RAG system and the tool-using AI assistant (Ask) — there is no existing implementation to extend, and building it before the tax engine and data layer are solid would mean building it on unstable ground.
- Form 16 upload/extraction and CSV import — net-new document-handling features that depend on the new schema being finalized first.
- The cinematic GSAP/ScrollTrigger landing page and any additional Three.js/R3F scenes beyond the existing `FinanceAIModel` — purely additive polish that shouldn't precede a working, secure core.
- Any of the unspecified "additional features later" mentioned by the user (§17 above) — nothing to scope until they're described.
- Multi-regime tax *simulation* (as opposed to basic old/new comparison) — P1, not P0; don't let it block the Phase 1 tax engine ship.

---

## 20. Open Questions

- **Auth method going forward:** should phone+OTP login be preserved as a login method under Auth.js (would need a real SMS provider, since today's OTP is console-only), or should it be replaced by email/password or another method entirely? This is a product decision that affects the Phase 1 scope directly.
- **Existing data disposition:** is there any real data currently sitting in `db.smartca.income`/`expenses` (Flask/PyMongo) or the Mongoose `transactions` collection that needs to be preserved/migrated, or is everything in both collections disposable test data? This determines whether Phase 0 needs a data-export step.
- **Backend hosting model:** the target architecture folds the backend into Next.js API routes/server actions — confirming there's no reason to keep Flask running anywhere (e.g., for a Python-specific dependency) before it's decommissioned.
- **MongoDB cluster fate:** once Postgres is the system of record, is the Mongo Atlas cluster torn down entirely, or kept around for any reason? Relevant to closing out the credential-rotation/security work cleanly.
- **Scope and timeline of the "additional features later"** mentioned by the user but not yet described.

---

## 21. Final Recommendation

Treat this as a rebuild of the data and logic layers underneath a UI shell and visual language that are worth keeping. The single highest-priority action is independent of any migration planning: **rotate the exposed MongoDB credentials now**, because they're sitting in git history regardless of what happens next. After that, the migration sequence the user already laid out (security → database → auth → isolation → tax engine → tests → core app → documents → RAG → assistant → polish → landing page) matches what this audit found and should be followed in that order — there's no shortcut available here, since the current "backend" the UI actually depends on (the unauthenticated Mongoose route) has to be deleted before anything else can safely be built on top of user-scoped data.

---

## 22. Next Implementation Step

1. Get explicit approval on this audit before any code changes begin.
2. Rotate the MongoDB Atlas credentials currently hardcoded in `backend/app.py` — do this first, independent of everything else.
3. Decide the open question on auth method (phone-OTP vs. email/password) before Phase 0 auth work starts.
4. Confirm whether any data in the two existing Mongo collections needs to be preserved before Phase 0 deletes/replaces them.
5. Create a checkpoint branch/tag of current `main` before making any changes.
6. Scaffold Postgres + Drizzle schema and Auth.js in a new branch, per Phase 0.
7. Delete `frontend/app/api/transactions/route.ts` / `frontend/models/Transaction.ts` once the new service layer can take over — not before.
8. Write the first two tests (tax slab math, cross-user authorization) before writing the corresponding production code.
9. Remove the orphaned root `package.json` and orphaned `frontend/.git/` as a small, isolated housekeeping change.
10. Re-run `graphify update .` once the new structure stabilizes, so future codebase questions can use the knowledge graph as intended.
