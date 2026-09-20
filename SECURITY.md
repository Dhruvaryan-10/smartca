# SmartCA — Security Notes

_Current as of 2026-09-20, through Phase 6I and the Phase 6 hardening pass. An earlier version of this file described the Phase 0 state, from before PostgreSQL and authentication existed. Both now exist (see section 2); that earlier state survives only as the labelled history in section 1._

It separates three things, and only the first is a claim about the code:

1. **Implemented**: checked against the code and its tests.
2. **Open decisions**: questions that must be answered before something is built or connected. Not implemented.
3. **Future work**: known gaps. Not implemented.

**No real secrets, credentials or connection strings are recorded here, and none must be.** Nothing in this file is a legal conclusion. SmartCA has not been assessed against any privacy or data-protection law, and no compliance is claimed.

For the migration record see `MIGRATION-CHECKPOINT.md` and `docs/SMARTCA-REPOSITORY-AUDIT.md` (the v1 audit). Both are historical records: `MIGRATION-CHECKPOINT.md` in particular still describes the Phase 0 state in places, and is out of date about the current system.

---

## 1. Historical findings from v1 and Phase 0 (all resolved; not the current state)

**Everything in this section is history.** It records what the v1 audit found and how each item was closed. It does not describe the current application, which uses PostgreSQL and Auth.js (section 2). **MongoDB is no longer an application dependency:** the MongoDB and Mongoose code was deleted in Phase 0 and the `mongoose` package removed; the frontend has no MongoDB package. The only MongoDB code left in the repository is the legacy Flask service below, which is not part of the application.

- **Hardcoded MongoDB credential (v1).** `backend/app.py` once held a live connection string as a fallback default. The Atlas cluster has been permanently deleted, the fallback removed, and the credential must never be reused or copied anywhere. Its value is not reproduced anywhere in this repository.
- **Insecure JWT secret fallback (v1).** The `"supersecret"` default for `SECRET_KEY` was removed; the legacy backend now refuses to start without it.
- **Unauthenticated, ownerless transaction route (v1).** The route and its MongoDB code were deleted in Phase 0. **This is closed, not merely removed, and is no longer an open Phase 1 problem:** Phase 1 delivered authentication and a PostgreSQL service layer in which every query is scoped to the authenticated user (see section 2).
- **Legacy Flask backend (v1; the file is still in the repository).** `backend/app.py` is a PyMongo service that is **not part of the application**. It is non-functional (its MongoDB cluster no longer exists), and its own flaws were documented rather than fixed: open CORS, no rate limiting, a one-time code printed to the console instead of delivered, tokens kept in `localStorage`. It must not be run or exposed, and is slated for removal.

## 2. Implemented

In one paragraph, the current system: the application stores its data in **PostgreSQL through Drizzle**, authenticates people with **Auth.js sessions**, and reaches user data only through a **user-scoped service layer**. MongoDB is not used. The assistant layer described below has **no production API route, no UI and no model provider**, and no rate limiting exists anywhere.

### Configuration
- `DATABASE_URL` and `AUTH_SECRET` are required. There is no fallback: the app stops with a clear error if either is unset. Values live in `frontend/.env.local` (git-ignored); only `frontend/.env.example`, which lists names without values, is committed.
- No model-provider, gateway or OmniRoute configuration exists, because none is connected (see 5).

### Authentication and route protection
- Auth.js sessions (JWT strategy), email and password sign-in through the Credentials provider, bcrypt password hashing, one generic sign-in failure message, and server-side password bounds (8 characters minimum, 72 bytes maximum).
- `frontend/proxy.ts` protects pages and API routes. Public paths are an explicit allow-list (`/`, `/landing`, `/login`, `/signup`, `/api/auth/*`); an unauthenticated request to anything else is redirected before a page renders.
- The user id comes only from the server-verified session (`services/session.ts`), never from a request body, query string or header the client controls.

### Data isolation and validation
- Every user-owned table has a non-null `user_id` foreign key with cascade delete. Service functions take an explicit `userId` and filter by it in the query itself, so another user's row is unreachable rather than checked afterwards. Tests cover cross-user access.
- API routes read a fixed allow-list of body fields. All inputs are validated on the server, including strict calendar dates. Money is stored as integer paise.
- **Documents and CSV import:** authenticated, user-scoped upload, list, download and delete (another user's document is a plain 404). Uploads are size-capped before parsing (5 MB PDF, 2 MB CSV) and checked by content and declared type; file names are sanitised. Downloads are `attachment`, `nosniff` and `private, no-store`. PDFs are read as text only, with limits enforced while reading. Extracted values are untrusted until the person confirms them. CSV import commits only after re-validation, and a row matching an earlier import is never dropped silently.

### Logging and errors
- Document contents, PAN, salary figures and CSV rows are never logged. Unexpected database errors on upload, Form 16 confirmation, CSV import and tax-law retrieval are replaced by a generic error that keeps only the database error code (the driver would otherwise echo the statement's parameters).
- The assistant code (`services/assistant/`, `lib/assistant/`) contains no logging and stores nothing (a test pins the absence of `console` in every assistant source file). An unexpected error inside a real tool is replaced by an `AssistantFailure` that keeps only a code, the error's class name and a database error code; the composed entry point does the same for anything else unexpected, including a model adapter's own failure. See the assistant section below.

### Deterministic tax engine
- Pure (no auth, database or network imports) and versioned. It refuses unsupported rules and unsupported assessment years instead of guessing. All tax figures come from it.

### Tax-law corpus and retrieval (Phases 5A to 5C)
- The corpus is global reference data with no user column. Only the manual `npm run rag:ingest` script writes it; nothing under `app/` can reach ingestion. Sources must be `https` addresses on `.gov.in` or `.nic.in`. The corpus is official guidance only (no statute or circular text).
- Retrieval only reads, takes no user id, and makes no network call. It refuses (with a typed `insufficient_evidence` and no evidence) a question that names an assessment year other than the requested one, and a question that demands statute or circular text the corpus does not hold. Guidance is never relabelled as either. Static tests pin these properties.
- **Limit:** retrieval cannot see a claim that rests on a circular the question never mentions. The answer layer (below) checks a model's wording for that, by phrases only; it has been exercised on fixtures and never on a real model.

### The assistant layer (Phases 6B to 6I and the hardening pass)
**What exists:** six read-only tools (`search_tax_law`, `query_transactions`, `get_financial_summary`, `calculate_tax`, `compare_tax_regimes`, `simulate_tax`), strict argument validators, a bounded orchestrator, a provider-neutral `ModelAdapter` interface, an **answer layer** (`lib/assistant/answer.ts`) that decides what a model's text may say, and one composed server-side entry point (`services/assistant/ask.ts`, `askAssistant`) that runs the orchestrator and returns only a validated `Answer`. **What does not:** a real model provider, an API route, any UI, streaming. Nothing outside the tests calls this code, and a scan found no route, page or component that imports it, so no request from a browser can reach it today.

- **Identity.** Every tool is `(userId, args)`. The authenticated `userId` is supplied by the caller and is never an argument: a `userId` field in tool arguments is rejected by name at any level (as is any other unknown field), it is absent from every tool schema and the system prompt, and it is never sent to the model. Nothing enforces that the caller is trusted: `askAssistant` and `runAssistant` accept any non-empty string, so a future route must take it from the server's session and from nowhere else.
- **Read-only.** The tool layer imports no write function and no database client; a test pins its imports. It cannot reach the generic computation writer, the save path, the Tax workspace loader, or the deductions writers, and it never saves a computation.
- **Deterministic figures.** Tax figures come only from the engine (`calculate_tax`, `compare_tax_regimes`, and `simulate_tax`, which uses the engine's `scenarioDelta` for a signed change). Engine refusals and typed retrieval refusals are passed through unchanged; nothing is retried with altered input. `compare_tax_regimes` returns figures and a fixed notice that it is not a recommendation.
- **Orchestrator.** A model can only name one of the six tools; the name is looked up in a fixed allow-list, and every call in a batch (name, JSON, per-tool validator) is checked before any of it runs. Unknown tools, malformed or invalid arguments, exceeded limits and invalid model responses are typed errors, and a model-chosen field name that appears in one is clipped to 40 printable characters. The orchestrator itself passes a provider's or a tool's own failure on unchanged; the real tools and `askAssistant` are what sanitise it (below). The real tool set is loaded only when the caller supplies none, so importing the orchestrator loads no database client.
- **Untrusted data.** Transaction descriptions, sources, categories and retrieved passages are treated as data, never instructions: they are sent only as tool messages, the system prompt says so, and nothing is done because of what they say. This reduces prompt-injection risk; it does not eliminate it.
- **Model adapter.** The interface file has no imports, no provider name, no network call and no credential. A request carries only messages and tool declarations. The guards are strict allow-lists of field **names**: a `userId` field on a request, a message or a tool declaration is refused by name. They do **not** read text: a user id typed into a message, or written into a tool's JSON schema, is not detected there. Keeping it out of the conversation is the orchestrator's job (it never sends one) and the caller's. A model's tool arguments are held as either parsed JSON objects or an explicit `malformed` form, never as unparsed text posing as parsed.
- **Answer layer (Phase 6I, hardened).** `buildAnswer` is pure and has no imports. It keeps **tool facts** (evidence, tax figures verbatim in paise, ledger figures, typed refusals) apart from **model text**, and releases the text only if no blocking rule is broken; the facts stand either way. It enforces: every citation is a well-formed `[ev_...]` id that a tool returned in this run; a money amount in the text (₹, Rs, INR, "rupees", lakh, crore, thousand, digits with groups or of four or more digits, or written in words) must equal a figure a tool returned, the person stated, or a cited quote holds, matched by value and never computed by the layer (a sum, a difference, a share or a rounded figure is withheld); no regime is recommended or implied to save money unless the person said it; no date is stated as a deadline without a source (none exists); no wording claims statute or circular authority without evidence of that tier; a law claim needs a citation. **A negation licenses a claim only when it sits right before it in the same clause**, so "This is not guidance, the statute says..." is withheld while "This is official guidance, not statute text" is released. Typed refusals are preserved; invalid or conflicting tool results are refused; ledger free text never enters the facts.
- **Composed entry point (hardening).** `askAssistant({ userId, userMessages }, { model, tools? })` returns an `Answer` and nothing else: the orchestrator's own result, and the model's raw text, are never returned. Its input has no field for an assistant, tool or system message, and anything that is not a plain string of the person's own words is refused before the model is called, so a caller cannot smuggle in a turn to make a figure look trusted. Only the person's own turns are used to ground the answer. It is not a route and is not exposed to the browser.
- **Error boundary (hardening).** An unexpected error in a real tool, or from the model adapter through `askAssistant`, becomes an `AssistantFailure`: a code, the error's class name and a database error code, and nothing else (no message, statement, bound parameter, cause or raw tool result). This closes the case where a Drizzle error, which embeds its parameters (for a ledger query, the `userId`) in its message, would otherwise have been rethrown as it was. Typed refusals, `OrchestratorError` and `NotAuthenticatedError` are unchanged. Raw tool results reach only the server-side callback, never a log, an error or a return value.
- **Tests.** The assistant's pure code and pure tests need no database and no `DATABASE_URL` (`npm run test:assistant-pure`; a test walks their import graph and fails if any path reaches the database client, and requires every assistant test that does reach it to be named `*.db.test.ts`). The `*.db.test.ts` files run the real tools and need the local PostgreSQL; they write only throwaway rows, which they delete.

### Current safety bounds

| Area | Bound |
|---|---|
| Model rounds | 4 model calls per run (so at most 3 rounds of tool calls before a final answer); a run still asking for tools on the 4th is refused |
| Tool calls | 8 in total; the whole batch is validated before any runs; no retry |
| Conversation in | the orchestrator: 1 to 40 turns, user and assistant text only, last turn the user's, 50,000 characters each; no system or tool message. `askAssistant`: 1 to 20 of the person's own messages as plain text, 50,000 characters each, no assistant turn at all |
| Answer text | more than 20,000 characters is withheld |
| Tool result | more than 50,000 characters is refused, never truncated |
| `query_transactions` | at most 50 rows (default 20), newest first; totals cover every match; more than 5,000 matches is refused, not truncated |
| Transaction fields | date, type, amount, category and source only by default. **Descriptions are opt-in** (`includeDescription`). Description is capped at 200 characters, source at 50, category at 100, cut with a visible ellipsis. No ids, import fingerprints, batch ids, filenames or timestamps |
| `get_financial_summary` | with no period, the 12 calendar months ending at the latest transaction (taken from the data, not a clock; no tax-year rule). An explicit period needs both ends and at most 366 days. No descriptions or ids; category names capped at 100 |
| `search_tax_law` | question at most 300 characters; refused if it contains an `@`, a PAN-shaped code, a run of 9 or more digits, or more than 8 figures (structural checks, **not** a personal-data detector); the refusal does not echo the question; section at most 20 characters; at most 5 evidence items, with `evidenceId` kept and `chunkId` and ranking score dropped |
| Caller-facing activity | metadata only: round, call id, tool, outcome, refusal reason, evidence ids. No arguments, results or ledger rows, in the result or in any error. The model still receives whole tool results, because it needs them. The one exception is the opt-in `onToolResult` callback, server-side only, which receives a deep copy of each full result so the answer layer can ground an answer in it; it must never log, return or put in an error what it receives (`askAssistant` does not) |
| Model interface | at most 100 messages, 50,000 characters per message, 20 tool declarations, 8 tool calls per response, 20,000 characters of arguments |

## 3. What would leave SmartCA if an external provider were connected

This is **not** the case today. If it were, every model call would carry the system prompt and tool schemas, the whole conversation, every earlier tool result (resent each round), and the model's own tool arguments. In practice that can include up to 50 transactions per call (dates, amounts, categories, sources, and descriptions when asked for), ledger totals and summaries, exact income and deduction figures and the age category the model passes to the tax tools, plus the user's own chat text. It would not include the user id, email, credentials, documents, filenames or import metadata.

## 4. Not in place

- **No rate limiting anywhere:** not on login, signup, upload, import, or any future assistant route. No cost or token ceilings either.
- **No audit or disclosure logging.** Nothing records what would be sent to a provider, when, or for whom.
- **No consent or opt-in mechanism** for an assistant, and no retention policy for conversations (none are stored today).
- **No redaction or detection of personal data in free text.** Category and source are always sent (capped); descriptions when asked for. The `search_tax_law` and chat-text checks are structural only, and a personal detail can be phrased around them. The user's own chat text is not screened.
- `query_transactions` totals cover every match (with no filter, the whole ledger, as two aggregate numbers). Only the summary has a default period. The transactions read itself (`listTransactions`) still loads the whole ledger before filtering in memory.
- **The answer layer is phrase-based and conservative, not a proof.** It does not establish that a released answer is true, and it does not check that a cited passage supports the sentence that cites it. A figure is grounded by any returned quote, not necessarily the one cited. A negation licenses a claim only within a few words before it in the same clause; an unusual wording can still slip past a phrase, and an honest sentence phrased around a pattern can be withheld (the rules are tuned to withhold rather than release). A bare number of fewer than four digits with no marker, and a number written in words without a magnitude or a rupee word ("five hundred"), are not read as money. It has been run on fixtures, including deliberately compromised model texts; **no real model has been run through it**, so how a real model behaves is unmeasured.
- **The composed entry point does not authenticate.** It trusts the `userId` it is given; a route must supply it from the server's session. The assistant modules carry no `server-only` marker; nothing under `app/` imports them today.
- Isolation of PDF parsing (it runs in the server process and can be occupied by hostile content), application-level encryption of stored documents, malware scanning, email verification and password reset, security headers and CSP review, backups and production hardening.
- Database-level protection of the corpus: the database has one application role, so "handlers cannot mutate the corpus" is enforced by code layout and tests, not a grant.
- Nothing is deployed.

### Tests that pin "no provider"

`tests/rag-security.test.ts` and `tests/assistant-model.test.ts` assert that no model, embedding or routing package is installed. Connecting a real provider will require changing them, and that change must be deliberate and visible in review.

## 5. Open decisions (must be made before connecting a real model provider)

None of these is decided. Do not treat any as settled.

1. **Which provider or router**, and **what OmniRoute is**: whether it is an external service, a self-hosted gateway, or an internal module. The project names it as an intended role only.
2. **Provider data terms:** retention, whether data may be used for training, sub-processors, and deletion.
3. **Data-processing location.**
4. **Whether financial free text may leave SmartCA at all**, and if so which fields and rows, and whether ledger text is sent, redacted or omitted.
5. **User consent and opt-in:** what the person is told and how they turn it off.
6. **Rate limiting** and cost, token and latency ceilings for an assistant route.
7. **Audit and disclosure logging:** what is recorded about what was sent, and its retention and access.
8. **Provider timeout and error policy:** the interface has no timeout, abort signal or provider-error taxonomy.
9. **Fallback recipients:** if routing can fall back, each fallback is another recipient of the same data.
10. **Credentials:** where they are stored, who issues them, and rotation. (They must be server-only environment variables; see below.)
11. **Streaming:** wanted or not. It is deferred and not implemented.
12. **Legal and privacy review** of the above by someone qualified. None has been done.

## 6. Requirements for any future provider credential or configuration

Server-only environment variables read at startup, failing closed when unset, in the same way as `DATABASE_URL`. Never committed (only names in `.env.example`), never `NEXT_PUBLIC_`, never imported into client code, never logged, and never placed in a prompt, a tool schema or a tool result. Prompts and tool results carry personal financial data, so they are server-only too.

## 7. Future work

An assistant API route and UI (calling `askAssistant`, with the `userId` from the session); a real `ModelAdapter` implementation and its contract tests (no live calls in CI); evaluation of a **real** model through the answer layer (behaviour, groundedness, citation validity, injection tests; only a fixture evaluation of the layer's own rules exists); a deadlines source; rate limiting; audit logging; database-level corpus protection; PDF-parse isolation; removal of the legacy Flask backend.
