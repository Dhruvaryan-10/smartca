# SmartCA — Security Notes

This file tracks known security history and current status. It is updated as the SmartCA migration progresses (see `MIGRATION-CHECKPOINT.md` for the overall migration record and `docs/SMARTCA-REPOSITORY-AUDIT.md` for the full v1 audit this was derived from).

**No real secrets, credentials, or connection strings are ever recorded in this file.**

---

## Historical incident: hardcoded MongoDB credential (resolved by cluster deletion)

`backend/app.py` previously contained a real MongoDB Atlas connection string — including a live username and password — hardcoded as the fallback default for `MONGO_URI`, committed to git history since the repository's initial commit. This was flagged as a **critical** finding in the v1 repository audit.

- **Current status: the affected MongoDB Atlas cluster has been permanently deleted.** The credential is no longer valid against any live resource.
- The hardcoded fallback has been removed from `backend/app.py` as of Phase 0 (this migration). The code now requires `MONGO_URI` to be set via environment variable with **no fallback default**, and fails fast with a clear error if it is missing, rather than silently using an insecure default.
- **The old credential must never be reused**, copied into a new `.env` file, or entered anywhere, even though the cluster is gone — treat it as permanently retired.
- The credential's plaintext value is not reproduced anywhere in this repository, its history going forward, or in migration documentation.

## Insecure JWT secret fallback (fixed in Phase 0)

`backend/app.py` also previously fell back to a hardcoded, insecure default (`"supersecret"`) for `SECRET_KEY` — the value used to sign and verify JWTs — if the environment variable was unset. This has been removed; the backend now requires `SECRET_KEY` to be set explicitly and fails fast if it is not.

## Cross-user data isolation problem (NOT yet fixed — Phase 1 scope)

The v1 audit found that the frontend's live transaction data path, `frontend/app/api/transactions/route.ts` (Mongoose/MongoDB), had **no authentication or authorization check of any kind**, and its schema (`frontend/models/Transaction.ts`) had **no user/owner field at all** — meaning any client could read and write every user's income/expense data.

**As of Phase 0, this route and its supporting MongoDB code (`frontend/lib/mongodb.ts`, `frontend/models/Transaction.ts`) have been deleted entirely**, because the MongoDB cluster they depended on no longer exists. This removes the *live* exposure (there is no longer any code path that could leak data, because there is no longer a data path at all), but it does **not** constitute a fix — no user-scoped replacement exists yet. Every page that previously called this route (`dashboard`, `income`, `expenses`, `taxes`, `reports`, `insights`) now renders with empty data, by design, until Phase 1 delivers a real, user-scoped PostgreSQL/Drizzle service layer.

**Do not consider this problem "fixed" until Phase 1 ships server-side authorization scoped to the authenticated user on every data-bearing query.**

## Existing authentication concerns (legacy, unresolved — Phase 1 scope)

The legacy Flask backend's OTP-based login flow has several unresolved issues, documented here so they aren't lost before Phase 1 replaces the auth system:

- OTP is not actually delivered by any SMS provider — it is only printed to server stdout (`backend/app.py`). Fine for local development, unusable and insecure for anything real.
- No password is ever used; identity rests entirely on possession of the phone number and receipt of the OTP.
- JWTs are stored in browser `localStorage` (in the frontend login/signup pages), not an httpOnly cookie — readable by any script on the page, i.e. exposed to theft via XSS.
- No frontend route protection exists — pages under `frontend/app/*` render and fetch without checking for a session first.
- CORS on the Flask backend is fully open (`CORS(app)`, no origin allowlist).
- No rate limiting exists on OTP send/verify endpoints.

None of these are fixed in Phase 0. They are listed here so Phase 1 (Auth.js/session authentication) addresses all of them deliberately rather than by omission.

## Existing authorization concerns

Separately from the isolation problem above: the legacy Flask backend's own endpoints (`/get-income`, `/add-income`, `/dashboard-summary`, etc.) *do* correctly scope every query to the JWT's `phone` claim — this pattern is sound in isolation and is called out in `MIGRATION-CHECKPOINT.md` as worth referencing when the new service layer's authorization is built. The problem was never that backend's logic; it's that the frontend never used it, and used the unauthenticated Mongoose route instead.

## Current environment requirements (Phase 0)

- **Frontend:** no environment variables are required. See `frontend/.env.example`.
- **Legacy Flask backend:** `SECRET_KEY` and `MONGO_URI` are both required for the process to start at all (it will raise a clear error and refuse to start otherwise), but this backend is not expected to be run in Phase 0 — its MongoDB dependency no longer resolves to anything. See `backend/.env.example`.
- **PostgreSQL (`DATABASE_URL`) does not exist yet.** It will be introduced in Phase 1. Do not add it to any `.env` file yet.

## What Phase 0 fixes

- Removes the hardcoded MongoDB credential and the insecure JWT secret fallback from source code.
- Deletes all MongoDB/Mongoose-dependent frontend code (`/api/transactions` route, `lib/mongodb.ts`, `models/Transaction.ts`) so the application cannot accidentally depend on, or attempt to reach, the deleted cluster.
- Removes the `mongoose` package dependency from `frontend/package.json`.
- Makes the legacy Flask backend fail fast and clearly if run without its (now-required, no-fallback) environment variables, instead of silently misbehaving.

## What Phase 0 does NOT fix (explicitly deferred to Phase 1)

- Cross-user data isolation is not "solved," only removed along with the code that exhibited it. No replacement authorization model exists yet.
- No real authentication system exists yet (Auth.js/session auth is Phase 1).
- The legacy Flask backend's insecure practices (open CORS, no rate limiting, fake OTP delivery, localStorage JWT) are documented, not fixed.
- No PostgreSQL/Drizzle schema, migrations, or service layer exist yet.
