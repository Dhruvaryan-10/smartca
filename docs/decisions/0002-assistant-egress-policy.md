# ADR 0002: SmartCA assistant egress policy

**Status:** Accepted (product decisions, 2026-09-29). The assistant is **capability-first**: the data the tools return may be processed by an external model, subject to explicit disclosure and consent and to provider requirements. **Not decided here:** any provider, what OmniRoute is, the consent mechanism's details, or the acceptable values of the provider requirements (see "Still open").
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
- **Which provider, and what OmniRoute is.**
- Whether a legal and privacy review is required before enabling (`SECURITY.md` §5, item 12).

## Consequences

- **The tool layer does not change.** No field is removed or redacted, and the egress inventory needs no change.
- **A real mode passes all six tools explicitly** as its `allowedTools`, instead of relying on the default, so that narrowing it later is a visible change.
- **Consent becomes a precondition in code**, checked before the model or any tool runs, in the same way synthetic mode checks its user and messages today.
- **The recipient allow-list (`MODEL_APPROVED_RECIPIENTS`) is where requirement 8 is enforced:** a recipient, including each fallback, is added only after it is assessed.
- **Configuration keeps refusing every mode but `synthetic`** until a provider is assessed and the consent mechanics are decided. Allowing a real mode is a separate, deliberate change.
- All existing limits stay: the model guard's limits, the answer layer's grounding, tool gating and fail-closed configuration.

## Out of scope

Choosing a provider; defining OmniRoute; any route, UI, streaming or consent storage; changing the tools or the gate. This record does not claim legal or regulatory compliance, and states no provider guarantee.
