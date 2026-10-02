# ADR 0004: Assistant provider integration path and the external-mode gate

**Status:** Accepted (2026-10-02, project owner's choice of integration path and gating). The provider *vendor* and its ADR 0002 assessment remain open.

## Context

The assistant's external path (ADR 0002, ADR 0003) has a provider boundary (`services/assistant/provider.ts`) and one wire driver for the OpenAI-compatible Chat Completions format, but no provider was chosen, OmniRoute was never specified, and `readAssistantConfig` refuses `ASSISTANT_ENV=external`. Two decisions were needed to make the backend ready for a real provider without weakening anything: **which wire contract** SmartCA integrates, and **how external mode is gated** until ADR 0002's provider assessment (retention, training, sub-processors, processing location) is done, which is a human judgement the code cannot make.

A wire detail also had to be placed: OpenAI's current Chat Completions reference names `max_completion_tokens` as the output-token field and describes `max_tokens` as deprecated and not compatible with its newer reasoning models, while many OpenAI-compatible servers and gateways still accept only `max_tokens`.

## Decision

1. **Integration path: an OpenAI-compatible Chat Completions endpoint**, through the existing provider boundary and driver. Which service answers (OpenAI, a gateway such as an OmniRoute deployment, OpenRouter, LiteLLM, Azure OpenAI, a self-hosted server) is still only configuration (`MODEL_ENDPOINT`, `MODEL_ID`, `MODEL_API_KEY`, the one approved recipient). No SDK or package is added; there is no second provider path.
2. **The wire format is configuration, by name.** An external configuration must set `MODEL_WIRE_FORMAT`, one of a closed list:
   - `openai-chat-completions`: the output-token cap is sent as `max_completion_tokens`;
   - `openai-chat-completions-max-tokens`: the same format, with the cap sent as `max_tokens`, for compatible servers that require it.
   No default: a missing or unknown value fails closed, naming the variable and never its value. The generic configuration (`config.ts`) knows only the format *names*; the driver registry (`services/assistant/provider-registry.ts`) maps a name to a driver, and only the Chat Completions driver names the wire fields. A request carries exactly one cap field. `MODEL_MAX_OUTPUT_TOKENS` stays the only source of the value (ADR 0003 item 14); no request body, caller option, tool argument or model answer can choose the field or the value.
3. **The application service picks the driver** from the validated configuration, inside its configuration step, so an unusable format is refused and recorded before consent is read, and no route or request can supply a driver.
4. **External mode stays refused.** `readAssistantConfig` keeps refusing `ASSISTANT_ENV=external`. Enabling it remains a single, deliberate, reviewed change to that function, made only after the ADR 0002 assessment of the chosen provider is recorded.
5. **A production preflight proves readiness without enabling anything.** `npm run assistant:preflight` (`services/assistant/preflight.ts`, `scripts/assistant-preflight.ts`) validates a complete external configuration exactly as the external path will (`validateExternalEnv`, `readProviderTarget`, the registry), rejects placeholder keys and reserved test hosts, checks that every migration is applied and the assistant tables exist, reports the egress inventory fingerprint grants must name, and reports that the activation gate is still closed. It contacts no provider and prints names, codes and counts only, never a value.
6. **Retries: unchanged, none automatic** (ADR 0003 item 12). Each request is exactly one provider attempt per model call; a client's retry is a new request through consent and admission, counted and audited as its own run. The public `retryable` flag only tells a client whether a new request could help (an oversized or unusable answer, an authentication failure or a refusal is not retryable).

## Consequences

- An operator can make a deployment fully ready, and prove it, while the assistant still cannot reach any provider.
- Switching between OpenAI and a compatible gateway is a configuration change; a provider with a different wire format needs a new driver behind the same registry, and a new listed format name.
- Every existing external configuration must add `MODEL_WIRE_FORMAT` (none exists outside tests).
- Still open (ADR 0002, SECURITY.md section 5): the provider vendor and its data terms, processing location, deployment values and a spending ceiling, timeout values, fallback recipients, streaming, and a legal and privacy review.
