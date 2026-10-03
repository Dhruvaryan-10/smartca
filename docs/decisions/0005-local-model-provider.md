# ADR 0005: A local model for development (ASSISTANT_ENV=local)

**Status:** Accepted (2026-10-03, project owner's choice: a local Ollama model, and a separate development-only mode). ADR 0004 item 4 is unchanged: external mode stays refused, and the hosted provider and its ADR 0002 assessment remain open.

## Context

Ask SmartCA had only been run against stand-in models. A real model was needed to verify the whole pipeline (consent, session, tools, egress filter, provider driver, answer layer, panel) without sending anyone's data to a hosted provider, which ADR 0002 does not yet permit. Two candidates existed on the development machine:

- **FreeLLMAPI** (a desktop "local OpenAI-compatible LLM router"). Its server code forwards requests to about 70 third-party cloud APIs (aggregators, US and Chinese providers) with fallbacks between them. It is not a local model: using it would send ledger and tax data to unassessed recipients, which ADR 0002 item 8 forbids. Rejected.
- **Ollama** (open source, MIT, signed by Ollama Inc.) serving `qwen2.5:7b-instruct` on the same machine, listening on 127.0.0.1 only. It speaks the OpenAI-compatible Chat Completions format with native tool calls, which the existing driver already handles. Chosen.

The external configuration requires an `https` endpoint, and `readAssistantConfig` refuses every mode but `synthetic`, so a local server could not be configured at all.

## Decision

1. **A separate mode, `ASSISTANT_ENV=local`** (`validateLocalEnv` in `services/assistant/config.ts`). It is the external configuration in every respect: every model variable, exactly one approved recipient, the output-token cap and wire format, every per-user and global limit, the run retention. Only the endpoint rule differs: the host must be the loopback IP literal `127.0.0.1` or `[::1]` (not `localhost`, which a name lookup could re-point), `http` or `https`, with no credentials. The driver follows no redirects, so a local configuration cannot send anything off the machine.
2. **The same path.** `readProviderTarget` accepts `local` exactly as `external`, so consent, the access plan, the run limits and audit, the tools, the egress filter, the model guard, the driver and the answer layer are all unchanged. Consent grants name the configured recipient (`local-ollama` locally).
3. **External mode is untouched.** `readAssistantConfig` still refuses `ASSISTANT_ENV=external`; its tests are unchanged. Enabling a hosted provider is still the reviewed ADR 0004 change, after the ADR 0002 assessment.
4. **Run audit.** Local runs go through the external provider path and are recorded with `mode = 'external'` (the database allows only `synthetic` and `external`); the recipient (`local-ollama`) and the model id distinguish them. No migration.
5. **What a real model taught us, fixed in SmartCA, not in the model:**
   - Tool results carry money as integer paise. A 7B model stated paise as rupees (₹1,50,00,000 for ₹1,50,000). The answer layer withheld every such answer, but no answer was usable. Tool results are now **written for the model** with each `...Paise` amount in rupees, as SmartCA's pages write it (`lib/assistant/model-view.ts`, applied after the egress filter). It re-renders values the filter already allowed and adds no data, so the egress inventory, the disclosure and existing consents stand. The answer layer still grounds against the raw paise.
   - The client sends the person's earlier questions, never the model's answers. As separate turns they read as unanswered questions. They are now one user turn: earlier questions labelled as already-answered context, then the question to answer (`services/assistant/ask.ts`).
   - The decoder refuses text containing `<tool_call>` markup (a tool call the server did not parse) as an invalid response.
   - The system prompt adds four constraints: amounts are copied exactly as written; earlier messages are context; a figure the person states is their assumption, never SmartCA's data; call a tool before answering about the person's own money, and never claim a refusal no tool made.

## Consequences

- Ask SmartCA can be developed and tested end to end against a real model with no data leaving the machine.
- A local configuration is never a route to a hosted service: an endpoint that is not a loopback IP is refused.
- Running a model locally is a development tool, not a deployment option for a hosted SmartCA (the model would have to run on the same host as the application).
- A 7B model is not reliable enough for production answers: in 33 fresh runs it answered 13 of 15 factual questions correctly and released no wrong figure, but some answers were withheld or unhelpful. The hosted provider decision (ADR 0002) stays the production blocker.
