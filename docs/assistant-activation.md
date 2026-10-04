# Ask SmartCA: activation guide

What it takes to switch the real assistant on. This document holds no values; never write a key, endpoint credential or
password into it or into any tracked file.

## Why the panel says "The assistant is not available"

That message means the environment the server runs with does not enable the assistant: `ASSISTANT_ENABLED` is unset, empty or
`false`. `readAssistantConfig` returns "disabled", and every assistant and consent request is refused as `assistant_unavailable`.
That category is "configuration", so the panel shows its not-available state. On a host such as Vercel, the variables must be set
for the right environment (Production) and a new deployment made; a running deployment keeps the values it was built with.

If the assistant is enabled but a variable is missing or invalid, the panel says "The assistant is not set up correctly."
(`assistant_misconfigured`) instead. The error names the variable server-side, never its value; `npm run assistant:preflight` prints
which.

**External mode is open** (2026-10-04, [ADR 0004](decisions/0004-assistant-provider-integration.md) "Amendment"):
`readAssistantConfig` (`frontend/services/assistant/config.ts`) accepts `ASSISTANT_ENV=external` by returning
`validateExternalEnv(env)`, so only a complete, valid external configuration is produced. Its endpoint must be https and must not be a
host on the application's own machine, so a local model cannot be reached under external mode by mistake. The
[ADR 0002](decisions/0002-assistant-egress-policy.md) assessment of the chosen provider is now the precondition of the *configuration*:
set `MODEL_APPROVED_RECIPIENTS` only after it is recorded. Tests pin the rule (`assistant-external-config.test.ts`,
`assistant-local-config.test.ts`, `assistant-http.db.test.ts`, `assistant-preflight.test.ts`).

## The real request path (already implemented)

```
Ask SmartCA button (app/components/assistant/AssistantLauncher.tsx)
→ GET /api/assistant/consent              consent status       (services/assistant/consent-http.ts → consent-service.ts)
→ GET /api/assistant/consent/disclosure   what would be shared (the egress inventory, through the access plan)
→ POST /api/assistant/consent             { consent: "granted", inventoryVersion }   per account, 30 days
→ POST /api/assistant  { messages }       app/api/assistant/route.ts → services/assistant/http.ts → service.ts:
     session user → body → configuration → consent from the database → access plan → run limits and audit
     → askExternal → orchestrator → tool gate → the six SmartCA tools (ledger, summary, tax engine, tax law)
     → egress filter → model guard → provider driver (OpenAI-compatible Chat Completions) → grounded Answer
→ AnswerView (plain text; tax-engine and ledger marks; numbered sources; notices verbatim)
```

The browser never sees the endpoint, the model or the key. It sends only the person's messages and the exact consent grant.
Figures come only from tool results. The model's text is labelled "Explanation" and rendered as plain text.

## Environment variables (server-only, set in the host environment or `frontend/.env.local`)

| Variable | Meaning |
|---|---|
| `ASSISTANT_ENABLED` | `true` to turn the assistant on |
| `ASSISTANT_ENV` | `external` for a hosted provider |
| `MODEL_ENDPOINT` | The provider's full OpenAI-compatible Chat Completions URL: `https` only, no credentials in it, never `localhost` or a loopback address |
| `MODEL_API_KEY` | The provider key. A secret: never commit it; it is held in a redacting wrapper server-side |
| `MODEL_ID` | The model identifier at that provider: letters, digits, `.` `_` `:` `-`, at most 64 characters, no `/` |
| `MODEL_APPROVED_RECIPIENTS` | Exactly one recipient id, added only after the ADR 0002 assessment |
| `MODEL_TIMEOUT_MS` | Per-call timeout |
| `MODEL_MAX_OUTPUT_CHARS` | Longest answer accepted |
| `MODEL_MAX_OUTPUT_TOKENS` | Output-token cap sent on every call |
| `MODEL_WIRE_FORMAT` | `openai-chat-completions` or `openai-chat-completions-max-tokens` |
| `ASSISTANT_RATE_WINDOW_SECONDS`, `ASSISTANT_MAX_RUNS_PER_WINDOW`, `ASSISTANT_MAX_CONCURRENT_RUNS`, `ASSISTANT_MAX_TOKENS_PER_WINDOW`, `ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS` | Per-user and global limits ([ADR 0003](decisions/0003-assistant-run-limits.md)) |
| `ASSISTANT_RUN_RETENTION_DAYS` | Days of run audit metadata kept; also used by `npm run assistant:purge-runs` |

`frontend/.env.example` documents each one. Every variable is required for an external configuration; there are no defaults,
and anything missing fails closed, naming the variable and never its value.

## Consent

- Nothing reaches a model without the person's explicit, current consent.
- The panel shows the server's disclosure exactly as received: what is always shared, and per tool what is shared and what is
  never shared. Consent is granted per account for 30 days.
- Withdrawing takes effect from the next request.
- A change to the egress inventory invalidates every grant (`consent_outdated`). The person sees the new disclosure and grants
  again.

## Activation steps

1. **Choose the provider** (any OpenAI-compatible endpoint: OpenAI, a gateway, OpenRouter, LiteLLM, Azure OpenAI, or a
   self-hosted server behind https).
2. **Record the ADR 0002 assessment** of that provider in ADR 0002: retention, training use, sub-processors and fallbacks,
   processing location, and who verified them. Settle the open consent-mechanics and legal-review questions there too.
   *Status 2026-10-04:* OpenAI API chosen; facts recorded in ADR 0002 "Provider assessment: OpenAI API", including its open
   considerations (stored completions, 30-day abuse monitoring, processing location, reasoning tokens in the output cap); owner
   sign-off pending.
3. **The reviewed gate change** is made (2026-10-04, ADR 0004 "Amendment"): `readAssistantConfig` accepts `ASSISTANT_ENV=external`
   by returning `validateExternalEnv(env)`. Do not set `MODEL_APPROVED_RECIPIENTS` in a deployment until step 2 is recorded.
4. **Configure** the variables above in `frontend/.env.local` locally, or in the host's secret store in production (on Vercel:
   Project → Settings → Environment Variables, scoped to Production, then redeploy).
5. **Prove readiness:** `npm run assistant:preflight` must print `Ready.` It contacts no provider.
6. **Verify end to end:** sign in, open Ask SmartCA, grant consent from the disclosure, ask a ledger question ("How much did I
   spend this month?") and a tax question ("Explain my latest tax calculation"), and check that the figures carry the ledger and
   tax-engine marks.

## Local model (development only, ADR 0005)

A real model on your own machine, so the whole pipeline can be tested without sending anyone's data to a hosted provider. It is
not a production option and not a route to one: the endpoint must be a loopback IP.

1. **Install and start the model.** Install Ollama (`winget install Ollama.Ollama` on Windows, or ollama.com), which runs a server on
   `127.0.0.1:11434` only. Pull the model once: `ollama pull qwen2.5:7b-instruct` (about 4.7 GB; an 8 GB GPU runs it). Do not use a
   "local router" that forwards to cloud APIs (for example FreeLLMAPI): that is a hosted provider, refused here (ADR 0005).
2. **Configure** in `frontend/.env.local` (never committed). Names only; every one is required:
   `ASSISTANT_ENABLED=true`, `ASSISTANT_ENV=local`, `MODEL_ENDPOINT` (`http://127.0.0.1:11434/v1/chat/completions`),
   `MODEL_API_KEY` (any non-empty placeholder; Ollama ignores it), `MODEL_ID` (`qwen2.5:7b-instruct`),
   `MODEL_APPROVED_RECIPIENTS` (one id, for example `local-ollama`), `MODEL_TIMEOUT_MS`, `MODEL_MAX_OUTPUT_CHARS`,
   `MODEL_MAX_OUTPUT_TOKENS`, `MODEL_WIRE_FORMAT` (`openai-chat-completions-max-tokens`: Ollama takes `max_tokens`),
   `ASSISTANT_RATE_WINDOW_SECONDS`, `ASSISTANT_MAX_RUNS_PER_WINDOW`, `ASSISTANT_MAX_CONCURRENT_RUNS`,
   `ASSISTANT_MAX_TOKENS_PER_WINDOW`, `ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS`, `ASSISTANT_RUN_RETENTION_DAYS`.
   A missing or invalid value fails closed, naming the variable. An endpoint that is not `127.0.0.1` or `[::1]` is refused.
3. **How SmartCA connects.** Exactly the external path: the same consent, session, access plan, run limits and audit, tools, egress
   filter, provider driver and answer layer. Runs are audited with mode `external` and recipient `local-ollama`.
4. **Run the real test.** `npm run build`, then `AUTH_TRUST_HOST=true npm start`. Sign up, add transactions in the Ledger, open Ask
   SmartCA, review the disclosure and allow it, then ask "What is my total income?" and check the figure against Summary.
5. **Switch it off.** Set `ASSISTANT_ENABLED=false` (or remove the variables) and restart: the panel returns to its not-available
   state.

**What reaches the model** (the egress boundary, unchanged by local mode): the system prompt, the person's own questions, the tool
definitions, and each tool result after the egress filter, with amounts written in rupees. Never a user id, email, name, row id,
import field, password, session, key or database address; never another user's data (every tool runs for the session user only);
nothing from Vault documents or saved tax computations (no tool reads them); a transaction's description only when the model asks
for it (`includeDescription`), as the consent disclosure states. Verified on 2026-10-03 by capturing every request a real model
received (151 calls).

**Expect a 7B model to be imperfect.** It sometimes calls a tool with arguments the schema refuses (a controlled "could not
complete"), and some answers are withheld by the answer layer. It must never show a wrong figure: the answer layer checks every
figure against the tool results.

## Production requirements (independent of the assistant)

- Auth.js needs `AUTH_TRUST_HOST=true` or `AUTH_URL` in production, otherwise sign-in fails with `UntrustedHost`.
- `AUTH_SECRET` and `DATABASE_URL` come from the host's secret store.
- Schedule `npm run assistant:purge-runs` once the assistant is enabled.

## Local development

```
cd frontend
npm install
npm run db:migrate
npm run dev        # http://localhost:3000
```

With the assistant variables unset, Ask SmartCA shows its not-available state, which is the correct default.
