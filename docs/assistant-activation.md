# Ask SmartCA: activation guide

What it takes to switch the real assistant on. This document holds no values; never write a key, endpoint credential or
password into it or into any tracked file.

## Why the panel says "The assistant is not available"

That message is correct behaviour, from two independent gates:

1. **The local environment doesn't enable it.** `frontend/.env.local` sets none of the assistant variables, so
   `ASSISTANT_ENABLED` is unset. `readAssistantConfig` returns "disabled", and every assistant and consent request is refused
   as `assistant_unavailable`. That category is "configuration", so the panel shows its not-available state.
2. **External mode is refused by design.** `readAssistantConfig` (`frontend/services/assistant/config.ts`) accepts only
   `ASSISTANT_ENV=synthetic` and refuses every other value, `external` included, with `real_data_mode_not_permitted`.
   [ADR 0004](decisions/0004-assistant-provider-integration.md) item 4 (accepted) keeps it that way until the
   [ADR 0002](decisions/0002-assistant-egress-policy.md) assessment of the chosen provider is recorded. Opening it is a single,
   reviewed change to that function, not a new code path. Tests pin the refusal (`assistant-config.test.ts`,
   `assistant-external.test.ts`, `assistant-external-config.test.ts`, `assistant-http.db.test.ts`).

`npm run assistant:preflight` reports both gates, printing names only:
`external configuration: assistant_disabled` and `activation gate: external mode is refused by readAssistantConfig`.

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
| `ASSISTANT_ENV` | `external` for a real provider, once the gate is opened |
| `MODEL_ENDPOINT` | The provider's OpenAI-compatible Chat Completions URL: `https` only, no credentials in it |
| `MODEL_API_KEY` | The provider key. A secret: never commit it; it is held in a redacting wrapper server-side |
| `MODEL_ID` | The model identifier at that provider |
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
3. **Make the reviewed gate change.** In `readAssistantConfig`, accept `ASSISTANT_ENV=external` by returning
   `validateExternalEnv(env)`. That function already validates the complete external configuration. Update the tests that pin
   the refusal so they pin the new rule instead. This is the reviewed change ADR 0004 describes; it is deliberately not made yet.
4. **Configure** the variables above in `frontend/.env.local` locally, or in the host's secret store in production.
5. **Prove readiness:** `npm run assistant:preflight` must print `Ready.` It contacts no provider.
6. **Verify end to end:** sign in, open Ask SmartCA, grant consent from the disclosure, ask a ledger question ("How much did I
   spend this month?") and a tax question ("Explain my latest tax calculation"), and check that the figures carry the ledger and
   tax-engine marks.

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
