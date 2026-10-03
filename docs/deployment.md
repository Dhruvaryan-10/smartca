# Deploying SmartCA

What a production deployment of SmartCA needs, by name only. This document holds no values; never write a secret, connection
string or key into it or into any tracked file. Nothing has been deployed yet, and the hosting target is not chosen.

## What runs

- One Next.js 16 application (`frontend/`), run as a Node.js server (`next build`, then `next start`). Every route is
  server-rendered on demand; `frontend/proxy.ts` guards every page and API route.
- One PostgreSQL database (developed on PostgreSQL 18). It holds everything, uploaded Form 16 PDFs included (`documents.content`
  is `bytea`), so no separate file storage is needed.
- Not part of the application: `backend/app.py` (legacy Flask/MongoDB, non-functional; never deploy it) and the root
  `package.json` (leftover 3D packages, unused by `frontend/`).

## Environment variables (names only)

Required:

| Name | Notes |
|---|---|
| `DATABASE_URL` | Production PostgreSQL connection string, from the host's secret store. Use TLS if the database is remote. |
| `AUTH_SECRET` | Session-signing secret, generated fresh for production (`npx auth secret`). Never reuse the local one. The app refuses to start without it. |
| `AUTH_URL` *or* `AUTH_TRUST_HOST` | Auth.js refuses an untrusted host (`UntrustedHost`). Set `AUTH_URL` to the public origin (for example `https://<production-domain>`), or `AUTH_TRUST_HOST=true` only behind a proxy that sets the `Host` header itself. |

Assistant, only after it is approved (see `docs/assistant-activation.md`; leave all unset until then, so Ask SmartCA shows its
not-available state):

`ASSISTANT_ENABLED`, `ASSISTANT_ENV`, `MODEL_ENDPOINT`, `MODEL_API_KEY` (secret), `MODEL_ID`, `MODEL_APPROVED_RECIPIENTS`,
`MODEL_TIMEOUT_MS`, `MODEL_MAX_OUTPUT_CHARS`, `MODEL_MAX_OUTPUT_TOKENS`, `MODEL_WIRE_FORMAT`, `ASSISTANT_RATE_WINDOW_SECONDS`,
`ASSISTANT_MAX_RUNS_PER_WINDOW`, `ASSISTANT_MAX_CONCURRENT_RUNS`, `ASSISTANT_MAX_TOKENS_PER_WINDOW`,
`ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS`, `ASSISTANT_RUN_RETENTION_DAYS`.

No storage, email, analytics or other external service is used. No `NEXT_PUBLIC_` variable exists; nothing above reaches the
browser.

## Checklist

- [ ] Hosting target chosen, able to run a long-lived Node.js server (or Node serverless functions) with PostgreSQL access.
- [ ] Production PostgreSQL provisioned, separate from development, with backups and point-in-time restore switched on.
- [ ] `DATABASE_URL`, `AUTH_SECRET` and `AUTH_URL` (or `AUTH_TRUST_HOST`) set in the host's secret store, per environment
      (production never shares a database or secret with preview/development).
- [ ] HTTPS only, on the production domain. Over HTTPS Auth.js issues `__Secure-` cookies that are `Secure`, `HttpOnly` and
      `SameSite=Lax`. The API is same-origin only; no CORS configuration is needed or wanted.
- [ ] Migrations applied (below) before the new version takes traffic.
- [ ] Assistant variables left unset unless the assistant has been approved and activated.
- [ ] Known gaps accepted or closed before public launch (`SECURITY.md` section 4): no rate limiting on login, signup, upload
      or import; no security headers or CSP review; no email verification or password reset.
- [ ] No `.env*` file, QA account, cookie or token in the repository (`git ls-files` shows only the two `.env.example` files).

## Build, migrate, start

From `frontend/`, with the production environment variables set:

```
npm ci
npm run db:migrate     # applies drizzle/0000-0005; idempotent, safe to re-run
npm run db:seed        # the AY 2026-27 reference row; idempotent
npm run build
npm start              # PORT defaults to 3000
```

Optional, for the assistant only once it is approved: `npm run rag:ingest` (loads the tax-law corpus),
`npm run assistant:preflight` (must print `Ready.`; contacts no provider), and a scheduled `npm run assistant:purge-runs`.

Smoke test after each deploy: open `/landing`, sign up a throwaway account, add one income and one expense, check Summary,
run one tax calculation, then delete the account's data.

## Database migrations

Six migrations exist (`frontend/drizzle/0000` to `0005`), applied in order by `npm run db:migrate`, which records what it has
applied. All are additive. This release adds no migration. Always take a database backup or snapshot before applying a new
migration in production.

## Rollback

- **Application only (no new migration in the release):** redeploy the previous build or commit. The schema is unchanged, so
  nothing else is needed.
- **Release that included a migration:** Drizzle migrations here are forward-only (there are no down migrations). Redeploy the
  previous build only if it still works against the new schema (additive changes usually do); otherwise restore the
  pre-migration backup, then redeploy the previous build.
- Form 16 extractions record the extractor version that produced them (`form16-text-v2` from this release); older rows keep
  `form16-text-v1` and stay valid.
