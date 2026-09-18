# SmartCA Migration Checkpoint — Phase 0

This document records the state of the SmartCA repository at the point MongoDB was removed as an active dependency, and how to recover the original v1 code if ever needed. See also `docs/SMARTCA-REPOSITORY-AUDIT.md` (the full v1 audit) and `SECURITY.md` (current security status).

## Original v1 state

- **Original v1 commit (before any Phase 0 change):** `02d1d17` — "fixed sidebar props" (branch `main`, in sync with `origin/main` at the time of this checkpoint).
- **Checkpoint tag:** `v1-pre-mongodb-removal`, created locally at commit `02d1d17`, pointing to the full v1 application exactly as audited (Flask/PyMongo backend with the hardcoded credential still present, Mongoose-backed `/api/transactions` route, no PostgreSQL/Drizzle anywhere).
- This tag has **not** been pushed to `origin` — it exists only in this local repository until you choose to push it.

## MongoDB status: **DELETED — permanently unavailable**

The MongoDB Atlas cluster SmartCA v1 depended on has been deleted. It is not being migrated, recovered, or reconnected. No MongoDB data is being carried forward. Mongoose and PyMongo are being retired as of this migration; PostgreSQL + Drizzle is the target database for Phase 1.

## What was removed in Phase 0

| Path | Action | Why |
|---|---|---|
| `frontend/app/api/transactions/route.ts` | **Deleted** | The only route that queried MongoDB via Mongoose; unauthenticated, unscoped, and now pointed at a deleted cluster. Confirmed (via repo-wide grep) to be the sole importer of the two files below. |
| `frontend/lib/mongodb.ts` | **Deleted** | Mongoose connection helper; imported only by the route above. |
| `frontend/models/Transaction.ts` | **Deleted** | Mongoose schema with no user/owner field; imported only by the route above. |
| `frontend/package.json` (`mongoose` dependency) | **Removed** via `npm uninstall mongoose` | No longer used anywhere after the three deletions above; lockfile updated automatically. |
| `backend/app.py` — hardcoded `MONGO_URI` fallback | **Removed** | Was a real, committed MongoDB Atlas credential (audit finding #1). Cluster is deleted; credential must never be reused. Replaced with a required env var and a fail-fast error if unset. |
| `backend/app.py` — hardcoded `SECRET_KEY` fallback (`"supersecret"`) | **Removed** | Insecure default (audit finding #3). Replaced with a required env var and a fail-fast error if unset. |
| `backend/.env` — `MONGO_URI` line | **Removed** (local, untracked file; value never printed or logged) | Pointed at the now-deleted cluster; no longer meaningful. `SECRET_KEY` left untouched. |
| `frontend/.env.local` — `MONGO_URI` line | **Removed** (local, untracked file; value never printed or logged) | Frontend no longer has any MongoDB code path to configure. |
| `backend/.env.example`, `frontend/.env.example` | **Created** | Document required variable *names* only (no real values), split between current Phase 0 needs and a clearly-marked future Phase 1 `DATABASE_URL` placeholder that is not yet in use. |

## What remains as legacy (retained, not removed, in Phase 0)

- **`backend/app.py` (entire Flask/PyMongo service)** — retained, not deleted, per explicit instruction to assess rather than auto-remove. It is now clearly marked LEGACY in a header comment, fails fast (raises `RuntimeError`) if `SECRET_KEY` or `MONGO_URI` are unset, and cannot run at all against the deleted cluster. Every route in it (`/send-otp`, `/verify-login-otp`, `/verify-signup-otp`, `/dashboard-summary`, `/get-income`, `/get-expense`, `/add-income`, `/add-expense`, `/monthly-analytics`, `/category-analytics`) is still MongoDB/PyMongo-dependent and non-functional now that the cluster is gone.
  - **Conceptually reusable when Phase 1 builds real authentication:** the JWT-issuance pattern and, especially, `get_current_user()`'s approach of decoding the bearer token and using its claim to scope every subsequent query — this is the *correct* shape of per-user authorization and is worth referencing even though the file itself will eventually be retired.
  - **Not reusable, Mongo-specific, to be discarded when this file is retired:** all `db.otp` / `db.users` / `db.income` / `db.expenses` PyMongo calls, the `get_expiry_time()` helper (works around a MongoDB-specific naive-datetime quirk), and the OTP-storage-as-a-Mongo-document approach generally.
  - **Separately unresolved (not a Mongo issue, carries forward as a to-do):** OTP is never actually sent (console-print only), CORS is fully open, there's no rate limiting, and there's no password-based fallback — see `SECURITY.md`.
- **`backend/.env.example` and `backend/.env`** — retained with `MONGO_URI`/`SECRET_KEY` as required variables *for this legacy file only*, since `app.py` still reads them and needs to fail predictably rather than silently misbehave. This is intentionally temporary scaffolding, not a sign that MongoDB is coming back.

## What was verified but required no change

- No other file in the repository imports `frontend/lib/mongodb.ts` or `frontend/models/Transaction.ts` (verified by grep across `frontend/app`).
- No MongoDB/Mongoose references exist in any other tracked file, documentation, or config outside `backend/app.py` (verified via `git ls-files | xargs grep`).
- `.env` files were already correctly gitignored at both root and frontend level, and were confirmed absent from git history — no history rewrite was necessary or performed.

## Legacy transaction API — migration boundary for Phase 1

The deleted `/api/transactions` route was the **only** data path the live frontend used for income, expenses, tax totals, dashboard charts, reports, and "AI insights." Phase 1's PostgreSQL/Drizzle service layer must provide, at minimum, functional parity for:

- List transactions filtered by type (income/expense) and scoped to the authenticated user.
- Create a transaction (type, amount, category, date) associated with the authenticated user.
- Aggregate by month and by category, per user (currently recomputed client-side from the full transaction list on every page — dashboard, reports, and insights each re-implement this independently; worth consolidating rather than reproducing three times).

Until Phase 1 ships this, the following pages will load with empty/zero data (by design — they still `fetch("/api/transactions")`, receive a 404, and their existing `.catch()`/error handling falls back to each page's initial empty state rather than crashing): `dashboard`, `income`, `expenses`, `taxes`, `reports`, `insights`. This was confirmed by running `next build` successfully and reasoning through each page's existing fetch/catch logic — it was not fixed or reworked in Phase 0, only left in its documented, non-crashing failure mode.

## How to recover the original v1 code

```bash
# View the original v1 application exactly as it was before Phase 0:
git show v1-pre-mongodb-removal:backend/app.py
git show v1-pre-mongodb-removal:frontend/app/api/transactions/route.ts

# Check out the full v1 tree into a new branch, if ever needed:
git checkout -b recover-v1 v1-pre-mongodb-removal

# Or diff current state against the v1 checkpoint at any time:
git diff v1-pre-mongodb-removal -- backend/app.py
```

Nothing about this checkpoint rewrites or deletes git history — `main`'s existing commits (`545ef52`, `02d1d17`) are untouched; Phase 0's changes will land as new commit(s) on top.

## What Phase 1 will build

Per the audit's proposed sequence: PostgreSQL + Drizzle schema, Auth.js/session authentication (replacing the Flask OTP flow), a user-scoped service layer, the deterministic tax engine, and only after those — documents, RAG, and the AI assistant. See `docs/SMARTCA-REPOSITORY-AUDIT.md` §15–18 for the full sequence and phase scope.

## Phase 1A status: PostgreSQL + Drizzle foundation — complete

The relational data foundation now exists and has been verified against a real local PostgreSQL database (not just TypeScript types). See `docs/decisions/0001-postgres-over-mongodb.md` for the rationale.

- Schema (`frontend/db/schema.ts`): `users`, `assessment_years`, `transactions`, `deductions`, `tax_computations`, `documents` — all user-owned tables have a `NOT NULL` foreign key to `users.id` (`ON DELETE CASCADE`), money is stored as integer paise (`bigint`), and AY 2026-27 is seeded as a row in `assessment_years` rather than hardcoded into any enum.
- Migration generated via `drizzle-kit generate` (`frontend/drizzle/0000_special_jane_foster.sql`) and applied to the local `smartca` database via `frontend/db/migrate.ts`.
- Verified live against the database via `frontend/scripts/verify-db.ts` (11/11 checks passed, transactional rollback leaves no test data behind).
- **The frontend is deliberately NOT reconnected to PostgreSQL yet.** No page under `frontend/app/*` imports anything from `frontend/db/`. The legacy Flask backend (`backend/app.py`) is unchanged and still MongoDB-shaped/non-functional, exactly as left in Phase 0.
- Next: Auth.js/session authentication and the user-scoped service layer (Phase 1B+), per the sequence above.
