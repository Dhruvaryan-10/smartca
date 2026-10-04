# SmartCA

SmartCA is a personal-finance and Indian income-tax workspace. A signed-in person keeps an income and expense ledger, sees summaries
and breakdowns of it, computes their income tax for **AY 2026-27 (FY 2025-26)** under both regimes with a deterministic tax engine,
keeps Form 16 PDFs and CSV imports in a document vault, and can ask **Ask SmartCA**, an assistant whose figures come only from
SmartCA's own tools and whose tax-law statements cite official Income Tax Department guidance.

> This README describes the repository as of **2026-10-04** (branch `feat/smartca-ui`). It is a summary: where it and a linked
> document disagree, the code and the [decision records](docs/decisions/) are the source of truth.

## Contents

- [Quick start](#quick-start)
- [Production status](#production-status)
- [Tech stack](#tech-stack)
- [Repository structure](#repository-structure)
- [Local development](#local-development)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Authentication and security](#authentication-and-security)
- [Ask SmartCA architecture](#ask-smartca-architecture)
- [AI provider configuration](#ai-provider-configuration)
- [Privacy and data handling](#privacy-and-data-handling)
- [Testing and verification](#testing-and-verification)
- [Deployment](#deployment)
- [Production checklist](#production-checklist)
- [Known limitations and remaining work](#known-limitations-and-remaining-work)
- [Documentation map](#documentation-map)
- [Troubleshooting](#troubleshooting)
- [Change workflow](#change-workflow)

## Quick start

Everything runs from `frontend/`. You need Node.js 20.9 or later (Next.js 16's requirement) and a PostgreSQL database.

```bash
cd frontend
npm install
cp .env.example .env.local      # then set DATABASE_URL and AUTH_SECRET (see "Environment variables")
npm run db:migrate              # create the schema
npm run db:seed                 # AY 2026-27 reference row
npm run rag:ingest              # load the tax-law corpus (needed for tax-law answers)
npm run dev                     # http://localhost:3000
```

With the assistant variables unset, Ask SmartCA shows its "not available" state. Everything else works without it.

## Production status

| Area | Status |
|---|---|
| Ledger, summaries, reports, rule-based insights | Implemented |
| Tax engine (AY 2026-27, old and new regime) and Tax workspace | Implemented |
| Vault: Form 16 upload and extraction, CSV import | Implemented |
| Email and password authentication, user-scoped data | Implemented |
| Production deployment | Deployed on **Vercel** with a **Neon** PostgreSQL database. Migrations and the seed were applied to it, and sign-in works (reported by the project owner; the repository holds no deployment configuration that records it). |
| Ask SmartCA, code | Complete: consent, limits, audit, tools, egress filter, provider driver, answer layer and panel. External mode is accepted by the configuration (2026-10-04, [ADR 0004](docs/decisions/0004-assistant-provider-integration.md) "Amendment"). |
| Ask SmartCA, provider | **OpenAI API approved** with conditions on 2026-10-04 ([ADR 0002](docs/decisions/0002-assistant-egress-policy.md) "Provider assessment: OpenAI API"). |
| Ask SmartCA, in production | **Not yet switched on.** No OpenAI API key has been issued and the assistant variables are not set in Vercel, so production shows "The assistant is not available." |
| Ask SmartCA, local development | Verified end to end with a real local model: **Ollama** serving `qwen2.5:7b-instruct` on `127.0.0.1` (`ASSISTANT_ENV=local`, [ADR 0005](docs/decisions/0005-local-model-provider.md)). Development only; never a production option. |

**Pending before the assistant goes live:** an OpenAI API key, the assistant variables in Vercel Production plus a redeploy,
`npm run rag:ingest` against the production database (not confirmed as done), and the open legal and privacy review for Indian
users' financial data. Also pending before a public launch: the gaps in `SECURITY.md` section 4 (for example, no rate limiting on
login, signup, upload or import). See [Known limitations](#known-limitations-and-remaining-work).

## Tech stack

Only what the repository actually uses (`frontend/package.json`):

| Concern | Technology |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript 5 |
| Styling and charts | Tailwind CSS 4 (PostCSS), Recharts |
| Database | PostgreSQL (developed on PostgreSQL 18; Neon in production), `pg` driver |
| ORM and migrations | Drizzle ORM, drizzle-kit |
| Authentication | Auth.js (`next-auth` v5 beta), Credentials provider, `bcryptjs` |
| PDF text extraction | `unpdf` (Form 16) |
| Assistant | In-house orchestrator, tools and answer layer. The provider is reached through the platform `fetch` with an OpenAI-compatible Chat Completions driver; **no AI SDK or model package is installed** (tests pin this). |
| Tests | Node's built-in test runner via `tsx --test` |
| Lint, types | ESLint 9 (`eslint-config-next`), `tsc --noEmit` |
| Hosting | Vercel (production), Neon (production PostgreSQL) |

Not part of the application: `backend/app.py`, a legacy Flask and MongoDB service that is non-functional and must never be deployed,
and the root `package.json`, which holds leftover 3D packages that `frontend/` does not use.

## Repository structure

```
SmartCA/
├── frontend/                 the application (everything below runs from here)
│   ├── app/                  Next.js App Router
│   │   ├── (app)/            signed-in pages: dashboard (Summary), income, expenses, reports (Ledger), insights (Ask),
│   │   │                     taxes (Tax), vault (Vault)
│   │   ├── api/              route handlers: auth, signup, transactions, imports/csv, documents, tax, assistant (+ consent)
│   │   ├── components/       shared UI, including the Ask SmartCA panel (components/assistant/)
│   │   ├── landing/, login/, signup/   public pages
│   ├── auth.ts               Auth.js (Node runtime): Credentials provider, bcrypt, database
│   ├── auth.config.ts        Edge-safe Auth.js config: public paths, JWT session shaping
│   ├── proxy.ts              route protection for every page and API route (Next.js 16 "proxy")
│   ├── db/                   schema.ts, client.ts, migrate.ts, seed.ts, load-env.ts
│   ├── drizzle/              SQL migrations 0000-0006 and their journal
│   ├── services/             server-side, user-scoped business logic (transactions, imports, documents, tax, ...)
│   │   └── assistant/        assistant config, HTTP and service layer, orchestrator, tools, provider driver, consent, limits
│   ├── lib/                  pure helpers (formatting, CSV, Form 16 extraction, insights, summaries)
│   │   ├── assistant/        tool contract and egress inventory, egress filter, model view, access plan, answer layer
│   │   └── rag/, rag-eval/   tax-law retrieval and its evaluation
│   ├── tax-engine/           deterministic income-tax engine; rules/ay-2026-27.ts holds the year's rules
│   ├── rag-corpus/           curated official tax-law source text (AY 2026-27), loaded by `npm run rag:ingest`
│   ├── rag-evals/            retrieval evaluation sets and baselines
│   ├── scripts/              operator scripts: preflight, run purge, corpus ingest, retrieval eval, db verification
│   ├── tests/                all tests (*.test.ts; *.db.test.ts need a database)
│   └── .env.example          every environment variable, documented (names only)
├── docs/
│   ├── decisions/            architecture decision records (ADRs 0001-0005)
│   ├── assistant-activation.md, deployment.md, design/ ...
├── SECURITY.md               implemented controls, gaps and open decisions
├── MIGRATION-CHECKPOINT.md   historical record of the MongoDB removal (not current state)
└── backend/                  LEGACY, non-functional; do not run or deploy
```

## Local development

All commands run in `frontend/` and exist in `frontend/package.json`.

```bash
npm install                     # dependencies
cp .env.example .env.local      # local environment (never committed)
npm run db:migrate              # apply drizzle/*.sql migrations (idempotent)
npm run db:seed                 # AY 2026-27 reference row (idempotent)
npm run rag:ingest              # load the tax-law corpus (idempotent); `npm run rag:ingest -- --check` validates only
npm run dev                     # development server, http://localhost:3000
```

Verification:

```bash
npm run test                    # full suite (DB tests use DATABASE_URL from .env.local)
npm run test:assistant-pure     # the assistant's pure tests (no database)
npm run typecheck               # tsc --noEmit
npm run lint                    # eslint .
npm run build                   # production build
npm start                       # serve the production build (PORT defaults to 3000)
```

Database and assistant utilities:

```bash
npm run db:generate             # generate a new migration from db/schema.ts (drizzle-kit)
npm run db:verify               # exercise the schema against the database inside a rolled-back transaction
npm run rag:eval                # evaluate tax-law retrieval against rag-evals/
npm run assistant:preflight     # check an external assistant configuration and the database; contacts no provider
npm run assistant:purge-runs    # delete assistant run-audit rows older than ASSISTANT_RUN_RETENTION_DAYS
```

> **Database tests write to the database named by `DATABASE_URL` in `.env.local`** (throwaway users, deleted after each test).
> Point it at a local development database, never at production.

To try the assistant locally with a real model, follow "Local model" in
[docs/assistant-activation.md](docs/assistant-activation.md) (Ollama with `qwen2.5:7b-instruct`, `ASSISTANT_ENV=local`).

## Environment variables

[`frontend/.env.example`](frontend/.env.example) documents every variable. All are **server-only**: there is no `NEXT_PUBLIC_`
variable, so nothing reaches the browser. Locally they go in `frontend/.env.local`; in production, in Vercel's environment variables.
**Never put a real value in any tracked file.**

### Application

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | local and production | PostgreSQL connection string. In production the Neon string, with TLS. |
| `AUTH_SECRET` | local and production | Auth.js session-signing secret. The app refuses to start without it. Generate a fresh one for production (`npx auth secret`); never reuse the local one. |
| `AUTH_URL` or `AUTH_TRUST_HOST` | production | Auth.js refuses an untrusted host (`UntrustedHost`). Set `AUTH_URL` to the public origin, or `AUTH_TRUST_HOST=true` behind a proxy that sets the `Host` header. See [docs/deployment.md](docs/deployment.md). |

### Assistant (Ask SmartCA)

Off unless `ASSISTANT_ENABLED` is exactly `true`. When it is on, **every** variable below is required and validated, with no
defaults. Anything missing or invalid fails closed, naming the variable and never its value.

| Variable | Type | Meaning |
|---|---|---|
| `ASSISTANT_ENABLED` | boolean | `true` to turn the assistant on |
| `ASSISTANT_ENV` | enum | `external` (hosted provider, production), `local` (a model on this machine, development only) or `synthetic` (tests). Any other value is refused. |
| `MODEL_ENDPOINT` | URL | Full Chat Completions URL. External: `https` only, no credentials, never `localhost` or a loopback address. Local: `127.0.0.1` or `[::1]` only. |
| `MODEL_API_KEY` | secret | Provider key. Never committed; held server-side in a redacting wrapper. |
| `MODEL_ID` | model name | Letters, digits, `.` `_` `:` `-`, at most 64 characters, no `/` |
| `MODEL_APPROVED_RECIPIENTS` | identifier | Exactly one recipient id; consent grants are bound to it |
| `MODEL_TIMEOUT_MS` | integer | Per-call timeout, 1 to 120000 |
| `MODEL_MAX_OUTPUT_CHARS` | integer | Longest answer accepted, 1 to 50000 |
| `MODEL_MAX_OUTPUT_TOKENS` | integer | Output-token cap sent on every call, 1 to 50000 |
| `MODEL_WIRE_FORMAT` | enum | `openai-chat-completions` or `openai-chat-completions-max-tokens` |
| `ASSISTANT_RATE_WINDOW_SECONDS` | integer | Window the per-user limits count over, 1 to 86400 |
| `ASSISTANT_MAX_RUNS_PER_WINDOW` | integer | Runs one person may start per window, 1 to 10000 |
| `ASSISTANT_MAX_CONCURRENT_RUNS` | integer | Runs one person may have in progress, 1 to 20, at most the global value |
| `ASSISTANT_MAX_TOKENS_PER_WINDOW` | integer | Model tokens one person may use per window, 1 to 100000000 |
| `ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS` | integer | Runs in progress across everyone, 1 to 10000 |
| `ASSISTANT_RUN_RETENTION_DAYS` | integer | Days run-audit metadata is kept, 1 to 3650 |

**Local vs production:** locally the assistant either stays off or uses `ASSISTANT_ENV=local` with Ollama. Production uses
`ASSISTANT_ENV=external` with the approved OpenAI configuration ([below](#ai-provider-configuration)). A local configuration cannot
be used under `external`: the loopback endpoint is refused.

## Database

- **One PostgreSQL database holds everything**, uploaded Form 16 PDFs included (stored as `bytea`), so there is no separate file
  storage. The decision to use PostgreSQL over MongoDB is [ADR 0001](docs/decisions/0001-postgres-over-mongodb.md).
- **Tables** (`frontend/db/schema.ts`):
  - users and money: `users`, `assessment_years`, `transactions`, `import_batches`, `deductions`, `tax_computations`
  - Vault: `documents`, `document_files`, `document_extractions`
  - assistant: `assistant_authorizations` (consent), `assistant_runs` (metadata-only audit and limit accounting)
  - tax-law corpus: `tax_sources`, `tax_source_chunks`, `tax_corpus_releases` (global, read-only reference data)
- **Migrations:** Drizzle SQL files in `frontend/drizzle/` (`0000` to `0006`), generated from `db/schema.ts` with
  `npm run db:generate` and applied in order by `npm run db:migrate`, which records what it has applied. They are forward-only:
  there are no down migrations.
- **Seed:** `npm run db:seed` inserts the AY 2026-27 assessment-year row. Idempotent.
- **Tax-law corpus:** loaded by `npm run rag:ingest` from the committed `rag-corpus/ay-2026-27/` files. It is not part of the
  migrations or the seed, and only that script writes it. Without it, tax-law questions have no evidence to cite.
- **Production considerations:**
  - Migrations are not run by the Vercel build (`npm run build` is `next build`). Apply them yourself before the new version takes
    traffic, with `DATABASE_URL` pointing at production.
  - Take a backup or snapshot before applying a new migration.
  - Keep production separate from development and preview databases.
  - `npm run assistant:preflight` reports whether every migration is applied and the assistant tables exist.

## Authentication and security

- **Auth.js with email and password** (Credentials provider, `frontend/auth.ts`). Passwords are hashed with bcrypt (cost 12) and
  never stored or compared in plain text; over-long passwords that bcrypt would truncate are refused.
- **Sessions are JWTs** (`auth.config.ts`, `strategy: "jwt"`) signed with `AUTH_SECRET`. Over HTTPS, Auth.js issues `Secure`,
  `HttpOnly`, `SameSite=Lax` cookies.
- **Route protection:** `frontend/proxy.ts` runs the edge-safe `auth.config.ts` on every page and API route. A request without a
  session is redirected to `/login` before anything renders. Only the public pages and `/api/auth/*` are allow-listed.
- **User scoping:** every service in `frontend/services/` takes the user id from the server session, never from the request, and
  scopes every query by it. The assistant's tools run for the session user only.
- **Same-origin API:** there is no CORS configuration.
- **Never commit:** any `.env*` file other than the two `.env.example` templates, `MODEL_API_KEY`, `AUTH_SECRET`, `DATABASE_URL`,
  QA accounts, cookies or tokens. `.gitignore` ignores `.env*` (except `.env.example`) and local tooling (`.claude/`, `.serena/`,
  `graphify-out/`, the local `SmartCA/` notes vault).

Current controls, gaps and open decisions are maintained in [SECURITY.md](SECURITY.md).

## Ask SmartCA architecture

The browser never sees the endpoint, the model or the key. It sends only the person's messages and their exact consent decision.

```
Ask SmartCA panel (app/components/assistant/AssistantLauncher.tsx)
  → GET  /api/assistant/consent              consent status
  → GET  /api/assistant/consent/disclosure   what would be shared, per tool, from the egress inventory
  → POST /api/assistant/consent              explicit grant: per account, 30 days, bound to the disclosed inventory version
  → POST /api/assistant  { messages }        app/api/assistant/route.ts → services/assistant/http.ts → service.ts
       1. session user, body checks
       2. configuration (readAssistantConfig; fails closed) and provider target (exactly one recipient)
       3. consent read from the database → access plan (consent ∩ profile ∩ configured recipient)
       4. run limits (per user, global; PostgreSQL, atomic) → audit row
       5. orchestrator: at most 4 model rounds and 8 tool calls per run
            → tool gate (only the plan's tools; read-only)
            → the SmartCA tools, run for the session user
            → egress filter (field-level, by data class) → model view (amounts written in rupees)
            → model guard (timeout, run budget, output cap, approved recipient)
            → provider driver (OpenAI-compatible Chat Completions)
       6. answer layer: grounds every figure against the raw tool results; withholds an unsafe answer
       7. audit row released (metadata only)
  → AnswerView: plain text, ledger and tax-engine marks on figures, numbered sources, notices verbatim
```

Withdrawing consent takes effect from the next request. A change to the egress inventory invalidates every grant
(`consent_outdated`), so people see the new disclosure and grant again.

### The tools

The external profile allows **seven** read-only tools (`lib/assistant/tool-contract.ts`). Earlier documents say "six": the seventh,
`get_saved_tax_computation`, was added on 2026-10-03.

| Tool | What it does |
|---|---|
| `search_tax_law` | Finds passages of official Indian income-tax guidance (the ingested corpus) as cited evidence. Refuses a question that carries personal details. |
| `query_transactions` | Lists the person's own transactions with filters (at most 50 rows per call; totals cover every match). Descriptions only when the model asks. |
| `get_financial_summary` | The person's income, expenses, savings and category and month breakdown (default: 12 months to their latest transaction). |
| `calculate_tax` | Runs the deterministic tax engine for one regime. |
| `compare_tax_regimes` | Runs the engine for both regimes and returns both results and the comparison. It does not recommend a regime. |
| `simulate_tax` | The signed change in tax between a base situation and a scenario in one regime. |
| `get_saved_tax_computation` | The person's most recently saved computation from the Tax page, exactly as saved. |

Synthetic mode offers fewer tools; it is a test transport.

### Tax-law evidence prefetch

When the person's question is about Indian income-tax law (`lib/assistant/law-question.ts`), the orchestrator runs
`search_tax_law` itself before the model is first called, through the same tool path and checks. The model therefore starts with
official evidence instead of depending on its own tool use. A question the search tool would refuse, for example one carrying
personal details, is not prefetched. The answer layer requires a tax-law claim to be supported by a cited passage, and a claim that a
named investment qualifies for a deduction to be supported by a passage or the person's own words that name it.

### Local and production paths

They use the same code path but are **different environments**:

| | Local development | Production |
|---|---|---|
| `ASSISTANT_ENV` | `local` | `external` |
| Model | Ollama, `qwen2.5:7b-instruct`, on the developer's machine | OpenAI API, `gpt-5.6-terra` |
| Endpoint | `http://127.0.0.1:11434/v1/chat/completions` (loopback only) | `https://api.openai.com/v1/chat/completions` (https, never loopback) |
| Wire format | `openai-chat-completions-max-tokens` (Ollama takes `max_tokens`) | `openai-chat-completions` (`max_completion_tokens`) |
| Data leaves the machine | No | Yes, to the approved recipient, after consent |

Both run the same consent, access plan, limits, audit, tools, egress filter, model guard and answer layer. A 7B local model is
imperfect: it sometimes calls a tool wrongly or has an answer withheld, but the answer layer never releases a figure that is not in
a tool result.

## AI provider configuration

The approved production configuration ([ADR 0002](docs/decisions/0002-assistant-egress-policy.md) "Provider assessment: OpenAI API",
accepted 2026-10-04):

| Setting | Value |
|---|---|
| Provider | OpenAI API |
| `ASSISTANT_ENV` | `external` |
| `MODEL_ENDPOINT` | `https://api.openai.com/v1/chat/completions` |
| `MODEL_ID` | `gpt-5.6-terra` |
| `MODEL_WIRE_FORMAT` | `openai-chat-completions` (the output cap goes in `max_completion_tokens`) |
| `MODEL_APPROVED_RECIPIENTS` | `openai` |
| `MODEL_API_KEY` | **Set only in Vercel's environment variables, marked Sensitive. Never committed, never in this README.** |

- **`store: false` on every request.** The Chat Completions driver (`services/assistant/provider-chat-completions.ts`) always sends
  it, in every wire format. OpenAI stores Chat Completions by default on new accounts, so SmartCA opts out explicitly. No request,
  caller, tool or model answer can change it.
- **What the request carries:** the model id, the conversation, the allowed tools' definitions, the filtered tool results, the
  output-token cap and `store: false`. Never a user id, session, email, key or database detail. The key travels only in the
  `Authorization` header, and the driver follows no redirects.
- **What the answer must be:** exactly one assistant choice from the configured model and recipient, not cut off at the cap. Anything
  else is refused as `provider_invalid_response`. The answer layer then grounds every figure.
- **Conditions of the approval:** OpenAI training opt-in stays disabled; `store: false` is always sent; consent, egress filtering,
  grounding, the access plan and audit stay mandatory; `MODEL_API_KEY` is never committed; the legal and privacy review for Indian
  users' financial data is still open.
- **Sizing note:** `max_completion_tokens` counts the model's reasoning tokens, and SmartCA refuses an answer cut off at the cap. Size
  `MODEL_MAX_OUTPUT_TOKENS` with a test call.

Full steps: [docs/assistant-activation.md](docs/assistant-activation.md).

## Privacy and data handling

What reaches the model is decided by the egress inventory (`ASSISTANT_EGRESS_INVENTORY`, `lib/assistant/tool-contract.ts`), which
classifies every field of every tool result. A test runs the real tools against it in both directions so it cannot drift. Fields no
entry covers stop the run. The person sees this inventory as the consent disclosure before anything is sent.

**Sent, after explicit consent:** the system prompt, the person's own questions, the tool definitions, and each tool result after the
egress filter (amounts written in rupees). That includes their ledger figures, category and source names, transaction descriptions
when the model asks for them, tax inputs and results, their saved tax computation when asked for, and public tax-law passages.

**Never sent:** user id, email, name, row ids, import fields, passwords, sessions, keys or database addresses; another user's data
(every tool runs for the session user only); anything from Vault documents (no tool reads them).

**Other rules:**
- Figures in an answer come only from tool results. The model's text is labelled "Explanation", rendered as plain text, and withheld
  if it states a figure no tool returned.
- The run audit (`assistant_runs`) is metadata only: codes, counts, tool and class names, token counts and times. Never a message,
  answer, argument, result or credential. It is deleted after `ASSISTANT_RUN_RETENTION_DAYS` by `npm run assistant:purge-runs`.
- There is no redaction or detection of personal data in free text; the checks are structural ([SECURITY.md](SECURITY.md) section 4).

**Provider facts** (from OpenAI's official documentation, recorded in ADR 0002, not legal advice):
- API data is not used for training unless the organization opts in.
- Abuse-monitoring logs are kept for up to 30 days. Zero Data Retention requires OpenAI's approval, which this deployment does not
  have.
- Encryption is AES-256 at rest and TLS 1.2+ in transit.
- The documentation does not state where data sent to the global `api.openai.com` host is processed. India data residency is
  storage-only, with no in-region inference.
- Whether this is acceptable under applicable Indian law is an **open** question. The repository makes no compliance claim.

## Testing and verification

| Check | Command | Latest result |
|---|---|---|
| Full test suite | `npm run test` | **1294 / 1294 pass** |
| Assistant pure tests | `npm run test:assistant-pure` | **398 / 398 pass** |
| Typecheck | `npm run typecheck` | passing |
| Lint | `npm run lint` | passing |
| Production build | `npm run build` | passing |
| Assistant preflight | `npm run assistant:preflight` | with the OpenAI configuration, every check passes except "not a placeholder: `MODEL_API_KEY`", because no real key exists yet |

These are the latest results from the current development state (2026-10-04, against a local PostgreSQL database). They are a
snapshot: rerun them after every change.

What the tests pin, among others:
- every refusal stops before the provider and before any tool
- external mode only from a complete, valid configuration
- a loopback endpoint refused under external mode
- `store: false` on every request
- consent bound to the inventory fingerprint
- no other user's data on the wire
- no AI SDK installed

## Deployment

```
GitHub ──► Vercel project (Root Directory: frontend) ──► environment variables ──► database ──► build ──► deploy ──► verify
```

1. **GitHub:** push the reviewed branch. Vercel builds from the repository.
2. **Vercel project:** the application lives in `frontend/`, so the project's Root Directory must be `frontend`. The repository has no
   `vercel.json`; Vercel's Next.js defaults apply (`npm run build`).
3. **Environment variables** (Vercel → Project → Settings → Environment Variables, scoped per environment):
   - `DATABASE_URL`, `AUTH_SECRET`, and `AUTH_URL` or `AUTH_TRUST_HOST`
   - the 16 assistant variables when the assistant is switched on
   - mark secrets Sensitive. Production must not share a database or secret with Preview or Development. Secrets belong only here,
     never in Git.
4. **Database:** from a trusted machine with `DATABASE_URL` set to production (in the shell, not a committed file), run
   `npm run db:migrate`, `npm run db:seed` and `npm run rag:ingest`. Back up first.
5. **Build and deploy:** Vercel builds on push, or redeploy from the dashboard. Environment-variable changes apply only to a new
   deployment.
6. **Verify:** sign up, sign in, add an income and an expense, check Summary, run a tax calculation, and (once enabled) open Ask
   SmartCA, grant consent and ask one ledger question and one tax-law question. Check the Vercel function logs for errors.

Rollback: redeploy the previous deployment. Migrations are forward-only, so if a release included one, the previous build must still
work against the new schema, or restore the pre-migration backup. See [docs/deployment.md](docs/deployment.md).

## Production checklist

- [ ] `git status` clean; the branch is reviewed and pushed
- [ ] `npm run test`, `npm run typecheck`, `npm run lint` and `npm run build` all pass
- [ ] Production database backed up; `npm run db:migrate`, `npm run db:seed` and `npm run rag:ingest` applied
- [ ] Vercel Production has `DATABASE_URL`, `AUTH_SECRET`, and `AUTH_URL` or `AUTH_TRUST_HOST`
- [ ] Assistant: all 16 variables set with the approved OpenAI values; `MODEL_API_KEY` marked Sensitive
- [ ] `npm run assistant:preflight` prints `Ready` against the production values (contacts no provider)
- [ ] OpenAI organization: training opt-in disabled
- [ ] Secret check: `git ls-files | grep -i env` shows only the two `.env.example` files; no key, token or connection string in the
      diff
- [ ] Redeployed on Vercel after the environment change
- [ ] Live: sign up and sign in with a throwaway account
- [ ] Live: Ask SmartCA consent, one ledger question and one tax-law question; figures carry ledger or tax-engine marks; the first
      answer comes back from model `gpt-5.6-terra`
- [ ] Vercel function logs checked; no errors
- [ ] `npm run assistant:purge-runs` scheduled

## Known limitations and remaining work

From the repository and its decision records:

- **Assistant in production:** awaits an OpenAI API key, the Vercel variables and a redeploy. The legal and privacy review for
  Indian users' financial data is open ([ADR 0002](docs/decisions/0002-assistant-egress-policy.md), [SECURITY.md](SECURITY.md)
  section 5).
- **Tax-law corpus in production:** `npm run rag:ingest` has not been confirmed as run against the production database.
- **[SECURITY.md](SECURITY.md) section 4 gaps:**
  - no rate limiting on login, signup, upload or import
  - no email verification or password reset
  - no security-headers or CSP review
  - no malware scanning or application-level encryption of stored documents; PDF parsing runs in the server process
  - one database role for everything
  - no audit outside the assistant
- **Answer layer:** phrase-based and conservative, not a proof. It does not check that a cited passage supports the sentence citing
  it.
- **Tax coverage:** one assessment year (AY 2026-27); corpus sections that could not be officially sourced are listed as known gaps,
  and retrieval refuses rather than guessing.
- **Not implemented:** streaming answers, fallback providers, a monetary spending ceiling, export of assistant events to a log
  system.

## Documentation map

| Document | What it covers |
|---|---|
| [docs/decisions/0001-postgres-over-mongodb.md](docs/decisions/0001-postgres-over-mongodb.md) | Why PostgreSQL and Drizzle |
| [docs/decisions/0002-assistant-egress-policy.md](docs/decisions/0002-assistant-egress-policy.md) | What may reach a model, consent, and the OpenAI provider assessment and owner decision |
| [docs/decisions/0003-assistant-run-limits.md](docs/decisions/0003-assistant-run-limits.md) | Per-user and global limits, run audit and retention |
| [docs/decisions/0004-assistant-provider-integration.md](docs/decisions/0004-assistant-provider-integration.md) | Chat Completions integration, wire formats, the external-mode gate and its 2026-10-04 amendment |
| [docs/decisions/0005-local-model-provider.md](docs/decisions/0005-local-model-provider.md) | Local Ollama development mode |
| [docs/assistant-activation.md](docs/assistant-activation.md) | Turning the assistant on: variables, consent, steps, local model |
| [docs/deployment.md](docs/deployment.md) | Deployment requirements, migrations, rollback |
| [SECURITY.md](SECURITY.md) | Implemented controls, gaps, open decisions |
| [frontend/.env.example](frontend/.env.example) | Every environment variable |
| [frontend/rag-corpus/README.md](frontend/rag-corpus/README.md) | Tax-law corpus rules |
| [docs/design/](docs/design/) | Frontend design system |
| [MIGRATION-CHECKPOINT.md](MIGRATION-CHECKPOINT.md), [docs/SMARTCA-REPOSITORY-AUDIT.md](docs/SMARTCA-REPOSITORY-AUDIT.md) | Historical records |

Some documents predate the latest changes and say so in places:
- `docs/deployment.md` says nothing is deployed and lists six migrations; there are seven, and the app is on Vercel.
- `docs/assistant-activation.md` and ADR 0005 speak of six tools and say no tool reads saved tax computations, which predates
  `get_saved_tax_computation`.
- The ADR 0004 amendment and the activation guide still describe the OpenAI sign-off as pending; ADR 0002 records it as accepted.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Sign-up or any page fails with a database error such as `relation "users" does not exist` | Migrations not applied to that database. Run `npm run db:migrate` (and `npm run db:seed`) with `DATABASE_URL` pointing at it. |
| Tax page reports the assessment year as unsupported | Seed not run, so the AY 2026-27 row is missing: `npm run db:seed`. |
| Tax-law questions get no evidence or are refused | Corpus not loaded: `npm run rag:ingest` (validate first with `-- --check`). |
| Startup error about `AUTH_SECRET` | Not set. Generate one (`npx auth secret`) and set it in `.env.local` or Vercel. |
| Sign-in fails with `UntrustedHost` | Set `AUTH_URL` to the public origin, or `AUTH_TRUST_HOST=true`. |
| Vercel build fails or finds no Next.js app | Root Directory is not `frontend`. Otherwise reproduce locally with `npm run build` and `npm run typecheck`. |
| A variable change has no effect on Vercel | Not redeployed, or set for the wrong environment (Preview instead of Production). |
| Ask SmartCA: "The assistant is not available." | `ASSISTANT_ENABLED` is unset, empty or `false` in the running deployment. |
| Ask SmartCA: "The assistant is not set up correctly." | Enabled, but a variable is missing or invalid (for example a loopback endpoint under `external`, a `MODEL_ID` with `/`, two recipients). Run `npm run assistant:preflight` with the same values; it names the variable, never the value. |
| Preflight: "not a placeholder: `MODEL_API_KEY`" | A placeholder or test key. Expected until a real key is set. |
| Preflight: database migrations or assistant tables fail | Run `npm run db:migrate` against that database. |
| "The model service refused the request" or a configuration error from the provider | Wrong or revoked key, or the model is unavailable to the account. Check the key in Vercel and the OpenAI project. |
| "The model service returned an answer that could not be used" | The answer was cut off at `MODEL_MAX_OUTPUT_TOKENS` (raise it; reasoning counts toward it), or named a different model than `MODEL_ID`. |
| Consent asked again for everyone | The egress inventory changed, so every grant is `consent_outdated` by design. |

## Change workflow

1. **Inspect:** read the relevant code, ADRs and `SECURITY.md` before changing anything.
2. **Implement:** match the surrounding code. A change to what reaches a model is a change to the egress inventory and a reviewed
   consent event.
3. **Test:** `npm run test` (and `npm run test:assistant-pure` for assistant work); add or update tests that pin the new rule.
4. **Typecheck and lint:** `npm run typecheck`, `npm run lint`.
5. **Build:** `npm run build`.
6. **Review the diff:** `git diff`, including a check for secrets and `.env` files.
7. **Commit**, **push**, and let Vercel build. Apply migrations and set environment variables before the new version takes traffic.
8. **Deploy and verify** with the [production checklist](#production-checklist).
