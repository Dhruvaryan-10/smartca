# ADR 0002: SmartCA assistant egress policy

**Status:** Accepted (product decisions, 2026-09-29). The assistant is **capability-first**: the data the tools return may be processed by an external model, subject to explicit disclosure and consent and to provider requirements. **Not decided here:** what OmniRoute is, the consent mechanism's details, or the acceptable values of the provider requirements (see "Still open"). **2026-10-04:** the owner chose the OpenAI API; its facts are recorded under "Provider assessment: OpenAI API", and the owner accepted it with conditions the same day.
**Date:** proposed 2026-09-29 after commit `ec271a1`; product decisions accepted 2026-09-29

## Context

The assistant's server-side path exists and is tested, but it is connected to nothing: there is no connected model provider and no UI, the one API route (`POST /api/assistant`) refuses every request, and configuration refuses every mode except `synthetic` (`frontend/services/assistant/config.ts`). What OmniRoute is, and which provider would be used, are undecided (`SECURITY.md` §5).

Before any real `ModelAdapter` is connected, SmartCA must decide what may be sent to it. Every model call would carry the system prompt and tool definitions, the whole conversation, the model's own tool arguments, and **every tool result, resent each round, exactly as the tool returned it** (`SECURITY.md` §3).

## Facts (implemented, not decisions)

### The inventory

The complete field inventory is **`ASSISTANT_EGRESS_INVENTORY`** in `frontend/lib/assistant/tool-contract.ts`. It names every field of every real tool's result and classes it as one of:

| Class | Meaning |
|---|---|
| `user_free_text` | Text a person wrote (ledger text), or text the model sent as a tool argument, which can repeat the person's words |
| `user_financial_data` | The person's own figures and dates, or figures computed from them |
| `tax_corpus_text` | Text and metadata of retrieved public tax guidance |
| `system_value` | Fixed-shape values carrying no personal text: status, enum codes, flags, counts, ids, validated dates and years, versions, SmartCA's own notices |

`frontend/tests/assistant-egress-inventory.db.test.ts` runs the real tool wrappers against the inventory in both directions, so it cannot silently drift: a new field fails, free text inside a field classed as figures fails, and a stale entry fails. The code is the authority; the summary below is a reading of it on this date.

### What the inventory records today

| Tool | `user_free_text` | `user_financial_data` | `tax_corpus_text` |
|---|---|---|---|
| `query_transactions` | each transaction's `category`, `description` (only when the model asks) and `source`; the `filter.category` the model sent | transaction dates, types and amounts; totals over every match | none |
| `get_financial_summary` | up to five `categories[].category` names | period, range, month keys and monthly totals, income, expenses, savings, savings rate, transaction count, category totals and shares | none |
| `search_tax_law` | section references read from the model's question or `sectionRef` (`unmatchedSectionRefs`, `sectionResolutions[].requested`; on a refusal `detail.sectionRefs`, `detail.yearMismatch.stated`) | none | evidence `title`, `quote`, `publisher`, `url`, `sourceKey`, `sectionRef`, `corpusVersion`; `sectionResolutions[].resolvedTo`; corpus version |
| `calculate_tax`, `compare_tax_regimes`, `simulate_tax` | none in a result (the inputs are amounts, enums and flags) | the exact income and deduction input, the age category, and the engine's full computed result, comparison or delta | none |
| every tool | a refusal `message` can repeat the name of an unknown argument field the model sent | | |

Not in any tool result: the user id, email, credentials, documents, filenames, import metadata. The person's own chat text is not a tool result, but it is sent as the conversation.

### What is already enforced

- **Tool gating** (`75527d6`): `runAssistant` and `askAssistant` take an optional `allowedTools`, defaulting to all six; only allowed tools are declared to the model, and a call to any other is refused (`unknown_tool`) before any tool in its batch runs.
- **Synthetic mode** (`ec271a1`) declares only the five tools it serves; `query_transactions` is never offered, and its in-tool refusal remains as a second line of defence.
- **The model boundary** (`c7d1354`): an approved-recipient allow-list (a response from any other recipient, or from none, fails closed), a per-call timeout, a run budget, an output cap, and typed provider errors with no provider text. Configuration fails closed and redacts the key.
- Ledger free text is length-capped and labelled as untrusted data; descriptions are opt-in per call; `search_tax_law` refuses a question that looks like it carries personal details (structural checks only).
- **Field-level egress filtering** (`frontend/lib/assistant/egress-filter.ts`): when a run sets `visibleClasses`, each tool result is filtered by its `ASSISTANT_EGRESS_INVENTORY` classes before it is serialized for the model; a field the inventory does not classify stops the run (`tool_result_unclassified`), and the raw result goes only to the server-side answer layer.
- **Authorization, access plan and disclosure** (`authorization.ts`, `access-plan.ts`, `egress-disclosure.ts`, all pure): a person's explicit consent is bound to a user, a profile, one recipient, a list of data classes and a validity window; the plan is profile ∩ authorization ∩ configured recipients; the disclosure lists, from the inventory, every field an external run would send or withhold, with a fingerprint of the inventory (`inventoryVersion`) that the plan's audit record carries.
- **An external entry point** (`frontend/services/assistant/external.ts`, `askExternal`) composes all of the above around `askAssistant`. **Nothing can run it:** it is called only by the application service behind `POST /api/assistant`, and `readAssistantConfig` still refuses every mode but `synthetic`, so that route refuses every request; no provider is connected and there is no UI.
- **Consent storage, run audit and per-user limits** (implemented; see `SECURITY.md` section 2): authorizations are stored server-side with revocation and the inventory version shown; every assistant run attempt is recorded as metadata only; per-user run, concurrency and token limits and a global concurrency cap are enforced atomically from required configuration, and run rows are deleted after a required retention period (ADR 0003). Every tool has an explicit effect, and a `write` tool is refused.
- **Consent API** (implemented after acceptance; `services/assistant/consent-http.ts`): `GET /api/assistant/consent/disclosure`, and `GET`/`POST`/`DELETE /api/assistant/consent`, for the signed-in person only. The server sets every term of a grant (the external profile, the configured recipient, the profile's classes, the validity window); the request states only the decision and the `inventoryVersion` of the disclosure shown, which must be the current one. While external mode is refused, the disclosure, status and grant answer with a configuration refusal; withdrawal (`DELETE`) does not depend on the configuration.
- There is **no** redaction or personal-data detection, no user interface for consent, no log sink for the assistant's events, and no automatic retries.

## Decision (accepted product decisions)

Each answers the question of the same number in the proposed version of this record. "May be processed" means it may be sent to an **approved** external model recipient, and only after the person's explicit consent (6 and 7).

1. **User free text:** the person's chat text and other free text may be processed by the AI.
2. **Ledger text:** transaction `description`, `source` and `category` names, and the summary's `categories[].category`, may be available to the model. Descriptions stay opt-in per call (`includeDescription`), as they are today.
3. **`query_transactions`:** available. A real provider's tool set is all six tools, with today's limits (at most 50 rows per call, default 20; more than 5,000 matches refused).
4. **Exact financial figures:** available: amounts, dates, totals, the exact tax inputs and the engine's results.
5. **Model-supplied tool arguments:** flow normally, including the argument text a result or a refusal repeats.
6. **Tax-corpus evidence:** available.
7. **Consent and disclosure:** external AI processing **requires explicit disclosure to, and consent from, the person** before any of their data is sent. Without it, nothing is sent.
8. **Provider requirements:** any provider, router or fallback recipient must be assessed on **retention, training use, sub-processors and fallbacks, and processing location** before it is added to the approved recipients. This record states that these must be covered; it does not claim that any provider meets them.

Every field this permits is listed, by path, in `ASSISTANT_EGRESS_INVENTORY`. The inventory therefore stays the exact description of what is disclosed, and its test keeps it current.

### Still open (not decided; to be recorded here when decided)

- **Provider requirements, values:** what retention period, training-use terms, sub-processor and fallback conditions, and processing locations are acceptable, and who verifies them and how. No provider can be approved until these are set.
- **Consent mechanics:** the disclosure text, and when consent is asked (per account, per session or per question). Storage, revocation (it takes effect from the next request), the record of what was disclosed (the inventory version) and the consent API are implemented; the implementation grants per account for a fixed 30 days (`CONSENT_VALIDITY_DAYS`), a default that does not settle this question. **Decided (implementation rule): a change to the egress inventory invalidates consent.** This replaces the earlier rule that it did not. Consent is for the exact inventory the person was shown: every grant stores that inventory's fingerprint (`inventoryVersion`, from `fingerprintInventory`), and `planModelAccess` refuses a grant whose fingerprint is not the one in force (`inventory_changed`, public `consent_outdated`, 403), after the other authorization checks and before any limit, run row, tool or provider call. Class-by-class enforcement alone does not bound a change: the external profile, and so every grant, covers all four classes, so a field or tool added later under any class would otherwise be sent under an old grant. Any change to the inventory (added, removed or reclassified field, or a new tool) therefore requires a new grant, made through the ordinary disclosure and consent flow; the consent status reports `outdated` until then. A test pins the fingerprint in force, so every inventory change is a reviewed consent event. `AUTHORIZATION_VERSION` is a separate thing: the version of the authorization record and its rules, bumped only when they change.
- **Which provider:** chosen 2026-10-04 by the project owner: the **OpenAI API**. Its facts are recorded in "Provider assessment: OpenAI API" below, and the owner accepted it on 2026-10-04 with conditions (see "Owner decision" there). What OmniRoute is remains open.
- Whether a legal and privacy review is required before enabling (`SECURITY.md` §5, item 12).

## Provider assessment: OpenAI API (recorded 2026-10-04)

**Status: accepted by the project owner on 2026-10-04, with conditions (see "Owner decision" below).** Compiled on 2026-10-04 from OpenAI's official documentation (sources at the end of this section), read that day. It states what those pages say and nothing more; where they are silent, it says so. It is not legal advice, and it does not decide whether these terms are acceptable for SmartCA: the owner records that decision, with who verified it, under "Owner decision" below.

**The configuration under assessment** (names and public values only; no key exists yet):

| Setting | Value |
|---|---|
| Provider | OpenAI API (OpenAI's own platform, not a router or reseller) |
| `MODEL_ENDPOINT` | `https://api.openai.com/v1/chat/completions` (the global host; no data-residency region) |
| `MODEL_ID` | `gpt-5.6-terra` |
| `MODEL_WIRE_FORMAT` | `openai-chat-completions` (the output cap is sent as `max_completion_tokens`) |
| `MODEL_APPROVED_RECIPIENTS` | `openai` (exactly one; no fallback recipient) |

**1. Data retention.** "Except for certain endpoints and features listed in our platform documentation, OpenAI may securely retain API inputs and outputs for up to 30 days to provide the services and to identify abuse. After 30 days, API inputs and outputs are removed from our systems, unless we are legally required to retain them." (Enterprise privacy.)

**2. Training use.** "As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in to share data with us)." (Data controls.) The enterprise privacy page says the same: by default business data is not used for training; data a customer has explicitly opted in to share may be. *For SmartCA:* the OpenAI organization must not opt in to data sharing.

**3. Abuse-monitoring retention.** "By default, abuse monitoring logs are generated for all API feature usage and retained for up to 30 days, unless longer retention is required by law." The storage table gives `/v1/chat/completions` 30 days of abuse-monitoring retention. Excluding customer content from these logs (Zero Data Retention or Modified Abuse Monitoring) is "subject to prior approval by OpenAI and acceptance of additional requirements", through OpenAI's sales team. Access to stored API data is limited to "(1) authorized employees that require access for engineering support, investigating potential platform abuse, and legal compliance and (2) specialized third-party contractors who are bound by confidentiality and security obligations, solely to review for abuse and misuse." (Enterprise privacy.)

**4. Application-state retention for `/v1/chat/completions`.** The data-controls storage table: application state retention "None, see below for exceptions"; Zero Data Retention eligible "Yes, see below for limitations". The listed exceptions are audio outputs, kept 1 hour (SmartCA sends none), and prompt caching, which "may store encrypted key/value tensors in GPU-local storage as application state", not retained after the 24-hour expiration. **The `store` parameter matters here:** "Chat completions are stored by default for new accounts" (Migrate to the Responses API guide), and `store` means "whether or not to store the output of this chat completion request for use in our model distillation or evals products" (API reference). Under Zero Data Retention, `store` is always treated as `false`. The pages read do **not** state how long a stored chat completion is kept. *For SmartCA:* the Chat Completions driver (`services/assistant/provider-chat-completions.ts`) explicitly sends `store: false` on every request, in every wire format, so SmartCA does not rely on the account's default. See consideration (a).

**5. Security and encryption.** "OpenAI encrypts all data at rest (AES-256) and in transit between our customers and us and between us and our service providers (TLS 1.2+), and uses strict access controls to limit who can access data." (Enterprise privacy.) "Our API Platform has been audited and certified for SOC 2 Type 2 compliance." The Trust Portal states that the most recent SOC 2 Type 2 report covers July 1, 2025 to June 30, 2026 (the report itself is available only to authenticated users and was not read), and that the API is ISO/IEC 27001 certified, with 27017, 27018 and 27701 also listed.

**6. Sub-processors** (OpenAI Sub-processor list, "Last updated: July 9, 2026"), for Customer Data as defined in OpenAI's Data Processing Agreement. Those listed for the API:

| Purpose | Entities (locations as listed) |
|---|---|
| Cloud infrastructure | Microsoft (23 countries, including India and the United States), CoreWeave (Norway, Spain, Sweden, UK, US), Oracle Cloud Infrastructure (Brazil, Japan, Malaysia, Netherlands, UK, US), Google Cloud Platform (Finland, Japan, Netherlands, Norway, UK, US), Amazon Web Services (US), Cerebras (US, Canada) |
| Content delivery | Cloudflare (the data center closest to the end user) |
| Data warehousing; infrastructure management | Snowflake (US), Confluent (US); both marked "except where Zero Data Retention (ZDR) is used" |
| Content moderation | TaskUs (Philippines), Accenture (US, Canada, Philippines), Cinder Technologies (US; except where ZDR is used). Per the list: "For content that OpenAI's models flag as being in violation of OpenAI's policies, OpenAI may share samples of the flagged Customer Content with relevant Sub-processors", retained "only … for the period of review" |
| Customer support | TaskUs, Intercom, Salesforce, Pylon Labs (premium support, at the customer's election), Accenture: data is processed "only to the extent Customer explicitly elects to share such data in the course of the support case" |
| Authentication | Okta (via Auth0, US) |

OpenAI affiliates (OpenAI OpCo and OpenAI LLC in the US, and OpenAI entities in Ireland, the UK and Japan) also provide support, with Standard Contractual Clauses among affiliates.

**7. Processing and data location.** Data residency is configured per project, when the project is created, and requests must use the region's hostname; eligibility is through OpenAI's sales team. Regional *processing* (inference in the region) is available only in the United States, Europe (EEA + Switzerland) and the United Arab Emirates. **India (`in.api.openai.com`) offers storage at rest only, not regional processing**, and every non-US region requires approval for abuse-monitoring controls and a Modified Retention amendment. Under residency, content is stored at rest in the region "to the extent the endpoint requires data persistence to function". "Extended prompt caching in regions that do not support Regional processing may require that OpenAI process and temporarily store Customer Content outside of the Region." `store=true` cannot be set in non-US regions. **The pages read do not state where data sent to the global host `api.openai.com` (the configured endpoint) is processed or stored.** The sub-processor list above spans many countries.

**8. Considerations for SmartCA** (financial and tax data of Indian users; what reaches the model is the "What the inventory records today" table above, after consent):

- **(a) Stored completions.** By (4), a new OpenAI account stores Chat Completions by default, for an unstated period, for distillation and evals. SmartCA's Chat Completions driver therefore explicitly sends `store: false` on every request (a constant in `encodeChatCompletion`; no request, caller, tool or model answer can change it; pinned by `tests/assistant-provider-chat.test.ts` and the end-to-end route tests). The consent disclosure today does not mention provider-side storage.
- **(b) 30-day abuse-monitoring retention** of every input and output, including ledger amounts, category and source names, opt-in transaction descriptions, and tax inputs and results. It is visible to authorized OpenAI staff and moderation contractors; flagged samples may go to the moderation sub-processors in the US, Canada and the Philippines. Removing this needs OpenAI's Zero Data Retention or Modified Abuse Monitoring approval, which this deployment does not have.
- **(c) Location.** Indian users' data goes to the global host, whose processing location the documentation does not state. India residency would store at rest in India but still process inference elsewhere, and it requires approval, a new project and `MODEL_ENDPOINT` on `in.api.openai.com`. Whether this is acceptable under applicable Indian law is the open legal and privacy question above; this record does not answer it.
- **(d) Training opt-in** must stay off at the organization level (2).
- **(e) Output-token cap includes reasoning.** `max_completion_tokens` is "an upper bound for the number of tokens that can be generated for a completion, including visible output tokens and reasoning tokens", and `gpt-5.6-terra` is a reasoning model (`reasoning.effort` default `medium`). SmartCA refuses an answer cut off at the cap (`finish_reason: "length"`, `invalid_response`), so `MODEL_MAX_OUTPUT_TOKENS` must leave room for reasoning; size it by a test call, not by answer length alone. The model's documented maximum is 128,000 output tokens; SmartCA's in-code ceiling is 50,000.
- **(f) Exact model name.** SmartCA refuses an answer whose `model` differs from `MODEL_ID`. OpenAI lists the snapshot of `gpt-5.6-terra` as `gpt-5.6-terra` itself. Confirm on the first live call; a provider answering with a dated snapshot name would make every answer `provider_invalid_response`, failing closed.
- **(g) API status.** "While Chat Completions remains supported, Responses is recommended for all new projects." No deprecation or shutdown date is stated. `gpt-5.6-terra` supports `v1/chat/completions` and function calling, with a context window of 1,050,000 tokens and no deprecation label. Price: $2 input and $12 output per 1M tokens, with prompts over 272K input tokens priced at 2x input and 1.5x output. SmartCA's per-user and global token limits are the spending bound.
- **(h) Prompt caching** may hold encrypted key/value tensors in GPU-local storage for up to 24 hours (4). SmartCA does not request extended caching.

**Unchanged by this record:** the egress inventory and filter, consent and its disclosure, the access plan, tool gating, run limits and audit, retention, the model guard, the answer layer and fail-closed configuration.

**Owner decision:**

- **Decision:** Accepted. OpenAI is the approved external language-model provider for SmartCA, subject to the controls and limitations documented in ADR 0002.
- **Verified by:** Dhruvaryan Chugh, project owner.
- **Date:** 2026-10-04.
- **Conditions:**
  - OpenAI API training opt-in must remain disabled.
  - SmartCA must explicitly send `store: false`.
  - SmartCA's existing consent, egress filtering, grounding, access-plan and audit controls remain mandatory.
  - `MODEL_API_KEY` must never be committed to source control.
  - The legal/privacy review for Indian users' financial data remains an open pre-production consideration.

**Sources (official OpenAI documentation, read 2026-10-04):**
- Data controls in the OpenAI platform: https://developers.openai.com/api/docs/guides/your-data (training, abuse monitoring, storage table, ZDR, data residency)
- Enterprise privacy (updated January 8, 2026): https://openai.com/enterprise-privacy/ (retention, training, encryption, SOC 2, access)
- Sub-processor list (last updated July 9, 2026): https://openai.com/policies/sub-processor-list/
- Trust Portal: https://trust.openai.com/ (SOC 2 Type 2 period, ISO certifications)
- GPT-5.6 Terra model page: https://developers.openai.com/api/docs/models/gpt-5.6-terra
- Migrate to the Responses API: https://developers.openai.com/api/docs/guides/migrate-to-responses (Chat Completions status; `store` default)
- Chat Completions API reference, create: https://developers.openai.com/api/docs/api-reference/chat/create (`store`, `max_completion_tokens`, `max_tokens`)

## Consequences

- **The tool layer does not change.** No field is removed or redacted, and the egress inventory needs no change.
- **A real mode passes all six tools explicitly** as its `allowedTools`, instead of relying on the default, so that narrowing it later is a visible change.
- **Consent becomes a precondition in code**, checked before the model or any tool runs, in the same way synthetic mode checks its user and messages today.
- **The recipient allow-list (`MODEL_APPROVED_RECIPIENTS`) is where requirement 8 is enforced:** a recipient, including each fallback, is added only after it is assessed.
- **Configuration keeps refusing every mode but `synthetic`** until a provider is assessed and the consent mechanics are decided. Allowing a real mode is a separate, deliberate change.
- All existing limits stay: the model guard's limits, the answer layer's grounding, tool gating and fail-closed configuration.

## Out of scope

Choosing a provider; defining OmniRoute; any route, UI, streaming or consent storage; changing the tools or the gate. This record does not claim legal or regulatory compliance, and states no provider guarantee.
