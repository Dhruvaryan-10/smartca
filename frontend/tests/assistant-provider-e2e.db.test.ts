// The REAL provider driver (services/assistant/provider-chat-completions.ts) through the complete external path, against the local
// PostgreSQL. Only the network is fake: an in-memory `fetch` handed to chatCompletionsDriver. Everything else is production code:
//
//   Request -> HTTP boundary (http.ts) -> session user -> body -> configuration -> consent (database) -> access plan (profile, classes,
//   inventory version) -> PostgreSQL admission -> run row -> askExternal -> orchestrator -> model guard -> provider adapter (provider.ts)
//   -> chatCompletionsDriver: encode -> fake fetch -> decode -> tool gate -> the real calculate_tax -> egress filter
//   -> chatCompletionsDriver again -> answer layer -> audit row -> release -> HTTP response
//
// What it pins: the Chat Completions wire the real driver produces across a multi-turn tool round-trip (both requests, field by field,
// each carrying the configured output-token cap);
// that the tool result on the wire is exactly the egress filter's output for the run's plan; token usage summed into the audit row;
// typed, sanitized failures (another model, 429, a transport error quoting the key, a timeout) with the right status and audit row;
// the configured model's reported usage on a refused answer (cut off, filtered) recorded and counted toward the budget exactly once; and
// that every admission refusal (consent, token budget, concurrency) happens before any provider request. The platform `fetch` is
// replaced by a tripwire for the whole file, so no request can leave the process. Throwaway users, deleted after each test.
import "../db/load-env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { assistantRuns } from "../db/schema";
import { handleAssistantHttp } from "../services/assistant/http";
import type { AssistantApiResponse } from "../services/assistant/api-contract";
import type { AssistantEvent } from "../services/assistant/events";
import { validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { grantAssistantAuthorization } from "../services/assistant/authorization-store";
import { chatCompletionsDriver } from "../services/assistant/provider-chat-completions";
import type { FetchLike } from "../services/assistant/provider-chat-completions";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../services/assistant/orchestrator";
import { assistantTools } from "../services/assistant/tools";
import { filterToolResult, readEgressClasses } from "../lib/assistant/egress-filter";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";
import type { EgressFieldClass } from "../lib/assistant/tool-contract";
import { deleteTestUser, makeTestUser } from "./helpers";

const KEY = "test-key-NOT-A-REAL-SECRET-0009";
const ENDPOINT = "https://provider.invalid/v1/chat/completions";
const RECIPIENT = "recipient-a";
const MODEL = "fixture-model-1";
// A time no other test uses, so the global concurrency count sees only this file's runs.
const NOW = Date.UTC(2042, 0, 15, 12, 0, 0);
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: MODEL,
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "3000", MODEL_MAX_OUTPUT_CHARS: "20000",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "20", ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000",
  ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", MODEL_MAX_OUTPUT_TOKENS: "1024", MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RUN_RETENTION_DAYS: "400",
};
const external = (over: Record<string, string> = {}): AssistantConfig => validateExternalEnv({ ...ENV, ...over });
const BODY = { messages: ["What is my tax this year?"] };
const TAX_ARGS = { regime: "old", assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
const FINAL_TEXT = "The engine computed the figures above.";
/** Every class but tax_corpus_text: calculate_tax stays allowed, search_tax_law (which returns corpus text) does not. */
const CLASSES_WITHOUT_CORPUS: readonly EgressFieldClass[] = ["user_free_text", "user_financial_data", "system_value"];

// --- no real network ----------------------------------------------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let realFetchCalls = 0;
before(() => {
  globalThis.fetch = (async () => {
    realFetchCalls += 1;
    throw new Error("the platform fetch must never be reached by this test");
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(realFetchCalls, 0, "no request went to the platform fetch");
});

// --- the fake provider: an in-memory fetch, the only thing that is not production code ----------------------------------------------

type Seen = { url: string; init: RequestInit; headers: Record<string, string>; sent: Record<string, unknown> };
type Step = (init: RequestInit) => Response | Promise<Response>;
function fakeProvider(...steps: Step[]): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (url, init) => {
      seen.push({ url, init, headers: { ...(init.headers as Record<string, string>) }, sent: JSON.parse(String(init.body)) });
      const step = steps.shift();
      if (step === undefined) throw new Error("the fake provider has no scripted answer left");
      return step(init);
    },
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const completion = (message: Record<string, unknown>, finish: string, usage: { prompt_tokens: number; completion_tokens: number }, model = MODEL) =>
  json({ id: "chatcmpl-e2e", object: "chat.completion", model, choices: [{ index: 0, message, finish_reason: finish }], usage });
const toolCallReply = (model = MODEL): Step => () =>
  completion(
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "calculate_tax", arguments: JSON.stringify(TAX_ARGS) } }] },
    "tool_calls",
    { prompt_tokens: 100, completion_tokens: 20 },
    model,
  );
const finalReply: Step = () => completion({ role: "assistant", content: FINAL_TEXT }, "stop", { prompt_tokens: 150, completion_tokens: 12 });
/** Never settles on its own; rejects with the signal's reason when the call is aborted, as the platform fetch does. */
const hanging: Step = (init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));

// --- the route, as app/api/assistant/route.ts calls it, with the real driver --------------------------------------------------------

function post(body: unknown) {
  return new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function send(userId: string, provider: { fetch: FetchLike }, config: AssistantConfig = external()) {
  const events: AssistantEvent[] = [];
  const response = await handleAssistantHttp(post(BODY), {
    getSessionUserId: async () => userId,
    config,
    driver: chatCompletionsDriver({ fetch: provider.fetch }),
    now: () => NOW,
    onEvent: (e) => events.push(e),
  });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as AssistantApiResponse, text, events };
}
const codeOf = (body: AssistantApiResponse) => (body.ok ? "ok" : body.error.code);

async function withUser(work: (userId: string) => Promise<void>) {
  const user = await makeTestUser("assistant-provider-e2e");
  try {
    await work(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}
const consent = (userId: string, dataClasses: readonly EgressFieldClass[] = EGRESS_FIELD_CLASSES) =>
  grantAssistantAuthorization(userId, { profileId: "full", recipient: RECIPIENT, dataClasses: [...dataClasses], issuedAt: new Date(NOW - 7_200_000), expiresAt: new Date(NOW + 7_200_000) });
const runsOf = (userId: string) => db.select().from(assistantRuns).where(eq(assistantRuns.userId, userId));

/** None of these may appear: the provider key, the endpoint, the database and auth secrets, and any extra value given. */
function assertNoSecrets(where: string, text: string, ...more: string[]) {
  for (const s of [KEY, ENDPOINT, process.env.DATABASE_URL, process.env.AUTH_SECRET, ...more].filter((v): v is string => typeof v === "string" && v.length > 0)) {
    assert.equal(text.includes(s), false, `${where} leaked ${s.slice(0, 12)}…`);
  }
}
/** A failed run after admission: one row, failed with `code`, the slot released, and no secret in the response, the row or the events. */
async function assertFailedRun(userId: string, r: Awaited<ReturnType<typeof send>>, code: string, failureKind: string) {
  const rows = await runsOf(userId);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual([row.status, row.resultCode, row.failureKind, row.modelCalls, row.toolCalls], ["failed", code, failureKind, 1, 0]);
  // Every caller of this helper has no TRUSTED usage: another model's answer, an error status (body never read), a transport failure or a
  // timeout. A refused answer from the configured model does record its usage (the tests after the failure group).
  assert.deepEqual([row.inputTokens, row.outputTokens], [null, null], "no usage is taken from another model, invented, or charged at the cap");
  assertNoSecrets("the response", r.text, userId);
  assertNoSecrets("the run row", JSON.stringify(row));
  assertNoSecrets("the events", JSON.stringify(r.events), userId);
  assert.equal(r.events.some((e) => e.type === "tool_call"), false, "no tool ran");
}

// --- the complete multi-turn path ---------------------------------------------------------------------------------------------------

test("the complete path with the real driver: a tool round-trip over the Chat Completions wire, a grounded answer, and the audit row", async () => {
  await withUser(async (u) => {
    const granted = await consent(u, CLASSES_WITHOUT_CORPUS);
    const provider = fakeProvider(toolCallReply(), finalReply);
    const r = await send(u, provider);

    // 4. The answer: 200, grounded in the tool's figures.
    assert.deepEqual([r.status, codeOf(r.body)], [200, "ok"]);
    assert.ok(r.body.ok);
    assert.equal(r.body.answer.state, "answered");
    assert.deepEqual(r.body.answer.text, { origin: "model", content: FINAL_TEXT });
    assert.ok(r.body.answer.facts.taxValues.length > 0, "the answer's figures come from the tool result");
    assert.ok(r.body.answer.facts.taxValues.every((f) => f.tool === "calculate_tax" && f.callId === "call_1"));
    assertNoSecrets("the response", r.text, u, granted.authorizationId);

    // 1. Both model calls reached the real driver, and only it.
    assert.equal(provider.seen.length, 2);
    const [row] = await runsOf(u);
    const allowedTools = row.allowedTools as string[];
    for (const call of provider.seen) {
      // 2. Where it went and how: the configured endpoint, POST, the key only as a bearer header, no redirects, the guard's signal.
      assert.equal(call.url, ENDPOINT);
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.redirect, "error");
      assert.ok(call.init.signal instanceof AbortSignal);
      assert.deepEqual(call.headers, { "content-type": "application/json", authorization: `Bearer ${KEY}` });
      // Exactly the model request's fields and the configured output-token cap: no user, authorization, session, database state,
      // credential or other limit.
      assert.deepEqual(Object.keys(call.sent).sort(), ["max_tokens", "messages", "model", "tools"]);
      assert.equal(call.sent.model, MODEL);
      assert.equal(call.sent.max_tokens, Number(ENV.MODEL_MAX_OUTPUT_TOKENS), "the configured cap, on every model request");
      assertNoSecrets("the request body", String(call.init.body), u, granted.authorizationId);
      assert.doesNotMatch(String(call.init.body), /userId|authorizationId|session|postgres/i);
      // The plan's tools, and only those: corpus text was not authorized, so search_tax_law is not offered.
      const offered = (call.sent.tools as Array<{ type: string; function: { name: string } }>).map((t) => t.function.name);
      assert.deepEqual(offered, allowedTools);
      assert.equal(offered.includes("search_tax_law"), false);
      assert.ok((call.sent.tools as Array<{ type: string }>).every((t) => t.type === "function"));
    }

    // Request 1: the system prompt and the person's words, nothing else.
    assert.deepEqual(provider.seen[0].sent.messages, [
      { role: "system", content: ORCHESTRATOR_SYSTEM_PROMPT },
      { role: "user", content: BODY.messages[0] },
    ]);

    // 3. Request 2: the same conversation, then the assistant's tool call and the tool result, in the Chat Completions form.
    const second = provider.seen[1].sent.messages as Array<Record<string, unknown>>;
    assert.equal(second.length, 4);
    assert.deepEqual(second.slice(0, 2), provider.seen[0].sent.messages);
    assert.deepEqual(second[2], {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "calculate_tax", arguments: JSON.stringify(TAX_ARGS) } }],
    });
    assert.deepEqual(Object.keys(second[3]).sort(), ["content", "role", "tool_call_id"]);
    assert.deepEqual([second[3].role, second[3].tool_call_id], ["tool", "call_1"]);
    // The tool result on the wire is exactly the egress filter's output for this run's classes, applied to what the real tool returns.
    const visible = readEgressClasses(Object.fromEntries(EGRESS_FIELD_CLASSES.map((c) => [c, (row.visibleClasses as string[]).includes(c)])));
    assert.deepEqual(row.visibleClasses, CLASSES_WITHOUT_CORPUS);
    assert.equal(visible.tax_corpus_text, false);
    const raw = await assistantTools.calculate_tax(u, TAX_ARGS);
    assert.equal(raw.status, "ok");
    assert.equal(second[3].content, JSON.stringify(filterToolResult("calculate_tax", raw, visible)));
    // No corpus-text field reached the model in either request (the only tool that returns any was never offered).
    for (const call of provider.seen) assert.doesNotMatch(String(call.init.body), /"evidence"|"corpusVersion"|"quote"|"sourceKey"/);

    // The audit row: succeeded, the plan recorded, 2 model calls, 1 tool call, and the provider's usage summed (100+150, 20+12).
    assert.deepEqual(
      [row.status, row.mode, row.authorizationId, row.profileId, row.recipient, row.modelId, row.inventoryVersion, row.modelCalls, row.toolCalls, row.toolsCalled, row.resultCode],
      ["succeeded", "external", granted.authorizationId, "full", RECIPIENT, MODEL, fingerprintInventory(), 2, 1, ["calculate_tax"], null],
    );
    assert.deepEqual([row.inputTokens, row.outputTokens], [250, 32]);
    assertNoSecrets("the run row", JSON.stringify(row));

    // The events follow the layers, carry the provider's token counts, and no identity or secret.
    assert.deepEqual(r.events.map((e) => e.type), ["assistant_request", "run_started", "model_call", "tool_call", "model_call", "run_completed"]);
    const usage = r.events.flatMap((e) => (e.type === "model_call" ? [[e.inputTokens, e.outputTokens]] : []));
    assert.deepEqual(usage, [[100, 20], [150, 12]]);
    assertNoSecrets("the events", JSON.stringify(r.events), u, granted.authorizationId);
  });
});

// --- provider failures after admission: typed, sanitized, audited, released ---------------------------------------------------------

test("an answer naming another model is 502 provider_invalid_response: no tool runs, no second call, the run is failed and released", async () => {
  await withUser(async (u) => {
    await consent(u);
    const provider = fakeProvider(toolCallReply("some-other-model"));
    const r = await send(u, provider);
    assert.deepEqual([r.status, codeOf(r.body)], [502, "provider_invalid_response"]);
    assert.equal(provider.seen.length, 1, "no second provider call");
    assert.doesNotMatch(r.text, /some-other-model/);
    await assertFailedRun(u, r, "provider_invalid_response", "ModelProviderError:invalid_response");
    assert.equal(r.events.find((e) => e.type === "provider_failure")?.type, "provider_failure");
  });
});

test("a 429 is 502 provider_rate_limited, and the provider's error body (which quoted the key) is never read or passed on", async () => {
  await withUser(async (u) => {
    await consent(u);
    const provider = fakeProvider(() => json({ error: { message: `Rate limit reached for key ${KEY}: internal-org-detail` } }, 429));
    const r = await send(u, provider);
    assert.deepEqual([r.status, codeOf(r.body)], [502, "provider_rate_limited"]);
    assert.equal(provider.seen.length, 1);
    assert.doesNotMatch(r.text, /internal-org-detail|Rate limit reached/);
    await assertFailedRun(u, r, "provider_rate_limited", "ModelProviderError:rate_limited");
    assert.doesNotMatch(JSON.stringify(r.events), /internal-org-detail/);
  });
});

test("a transport failure quoting the key is 502 provider_unavailable, and the key is in no response, run row or event", async () => {
  await withUser(async (u) => {
    await consent(u);
    const provider = fakeProvider((init) => {
      throw new Error(`ECONNRESET while sending ${(init.headers as Record<string, string>).authorization} to ${ENDPOINT}`);
    });
    const r = await send(u, provider);
    assert.deepEqual([r.status, codeOf(r.body)], [502, "provider_unavailable"]);
    assert.equal(provider.seen.length, 1);
    assert.doesNotMatch(r.text, /ECONNRESET/);
    await assertFailedRun(u, r, "provider_unavailable", "ModelProviderError:unavailable");
    assert.doesNotMatch(JSON.stringify(r.events), /ECONNRESET/);
  });
});

test("a provider that never answers is 504 provider_timeout at the configured deadline, aborted, sanitized and released", async () => {
  await withUser(async (u) => {
    await consent(u);
    const provider = fakeProvider(hanging);
    const r = await send(u, provider, external({ MODEL_TIMEOUT_MS: "200" }));
    assert.deepEqual([r.status, codeOf(r.body)], [504, "provider_timeout"]);
    assert.equal(provider.seen.length, 1);
    assert.equal(provider.seen[0].init.signal?.aborted, true, "the request was aborted, not left running");
    await assertFailedRun(u, r, "provider_timeout", "ModelProviderError:timeout");
    assert.equal(r.events.find((e) => e.type === "timeout")?.type, "timeout");
  });
});

// --- refused answers the configured provider billed: their usage is recorded ---------------------------------------------------------

const cutOff = (usage: { prompt_tokens: number; completion_tokens: number }, finish = "length"): Step => () =>
  completion({ role: "assistant", content: finish === "content_filter" ? "" : "Your tax liability under the old regime is" }, finish, usage);

test("an answer cut off at the cap is 502 provider_invalid_response, and the configured model's reported usage is in the run row", async () => {
  await withUser(async (u) => {
    await consent(u);
    const provider = fakeProvider(cutOff({ prompt_tokens: 250, completion_tokens: 32 }));
    const r = await send(u, provider);
    assert.deepEqual([r.status, codeOf(r.body)], [502, "provider_invalid_response"]);
    assert.equal(r.body.ok, false, "no answer is returned");
    assert.doesNotMatch(r.text, /liability|250|prompt_tokens|usage/, "nothing of the provider's answer or usage reaches the client");
    const rows = await runsOf(u);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.deepEqual([row.status, row.resultCode, row.failureKind, row.modelCalls, row.toolCalls], ["failed", "provider_invalid_response", "ModelProviderError:invalid_response", 1, 0]);
    assert.deepEqual([row.inputTokens, row.outputTokens], [250, 32]);
    assert.deepEqual(r.events.flatMap((e) => (e.type === "model_call" ? [[e.outcome, e.inputTokens, e.outputTokens]] : [])), [["invalid_response", 250, 32]]);
    assertNoSecrets("the response", r.text, u);
    assertNoSecrets("the run row", JSON.stringify(row));
  });
});

test("a filtered answer is refused the same way, and its reported usage is recorded", async () => {
  await withUser(async (u) => {
    await consent(u);
    const r = await send(u, fakeProvider(cutOff({ prompt_tokens: 120, completion_tokens: 0 }, "content_filter")));
    assert.deepEqual([r.status, codeOf(r.body)], [502, "provider_invalid_response"]);
    const [row] = await runsOf(u);
    assert.deepEqual([row.status, row.inputTokens, row.outputTokens], ["failed", 120, 0]);
  });
});

test("a refusal on the second call of a tool round-trip: each call's usage is counted once, and the run's total is their sum", async () => {
  await withUser(async (u) => {
    await consent(u, CLASSES_WITHOUT_CORPUS);
    const provider = fakeProvider(toolCallReply(), cutOff({ prompt_tokens: 150, completion_tokens: 40 }));
    const r = await send(u, provider);
    assert.deepEqual([r.status, codeOf(r.body), provider.seen.length], [502, "provider_invalid_response", 2]);
    // Both requests still carried the configured cap.
    assert.deepEqual(provider.seen.map((s) => s.sent.max_tokens), [Number(ENV.MODEL_MAX_OUTPUT_TOKENS), Number(ENV.MODEL_MAX_OUTPUT_TOKENS)]);
    const [row] = await runsOf(u);
    assert.deepEqual([row.status, row.modelCalls, row.toolCalls, row.toolsCalled], ["failed", 2, 1, ["calculate_tax"]]);
    assert.deepEqual([row.inputTokens, row.outputTokens], [100 + 150, 20 + 40]);
    assert.deepEqual(r.events.flatMap((e) => (e.type === "model_call" ? [[e.outcome, e.inputTokens, e.outputTokens]] : [])), [["ok", 100, 20], ["invalid_response", 150, 40]]);
  });
});

test("a refused answer's usage counts toward the token budget exactly once: neither missed nor counted twice", async () => {
  await withUser(async (u) => {
    await consent(u);
    // 283 tokens: refused at 283 or more. 282 + 1 = 283 only if each refused run is counted exactly once.
    const config = external({ ASSISTANT_MAX_TOKENS_PER_WINDOW: "283" });
    const first = await send(u, fakeProvider(cutOff({ prompt_tokens: 250, completion_tokens: 32 })), config);
    assert.equal(codeOf(first.body), "provider_invalid_response");
    // If it were counted twice (564), this run would be refused before reaching the provider.
    const secondProvider = fakeProvider(cutOff({ prompt_tokens: 1, completion_tokens: 0 }));
    const second = await send(u, secondProvider, config);
    assert.deepEqual([codeOf(second.body), secondProvider.seen.length], ["provider_invalid_response", 1], "admitted: 282 < 283");
    // If it were not counted at all (1), this run would be admitted.
    const thirdProvider = fakeProvider(finalReply);
    const third = await send(u, thirdProvider, config);
    assert.deepEqual([third.status, codeOf(third.body), thirdProvider.seen.length], [429, "usage_budget_exceeded", 0]);
    const rows = await runsOf(u);
    assert.equal(rows.reduce((sum, row) => sum + (row.inputTokens ?? 0) + (row.outputTokens ?? 0), 0), 283);
  });
});

// --- admission refusals: none reaches the provider ----------------------------------------------------------------------------------

test("without consent the request is 403 and the real driver never sends anything", async () => {
  await withUser(async (u) => {
    const provider = fakeProvider(finalReply);
    const r = await send(u, provider);
    assert.deepEqual([r.status, codeOf(r.body), provider.seen.length], [403, "consent_required", 0]);
    assert.deepEqual((await runsOf(u)).map((row) => [row.status, row.resultCode]), [["rejected", "consent_required"]]);
  });
});

test("the token budget counts the provider's reported usage: once it is used up, the next request is 429 before any provider request", async () => {
  await withUser(async (u) => {
    await consent(u);
    const config = external({ ASSISTANT_MAX_TOKENS_PER_WINDOW: "300" });
    const first = fakeProvider(toolCallReply(), finalReply);
    assert.equal((await send(u, first, config)).status, 200); // 250 + 32 = 282 tokens, under 300: admitted
    const second = fakeProvider(finalReply);
    const r = await send(u, second, config); // 282 used, still under 300: admitted, uses 162 more
    assert.equal(r.status, 200);
    const third = fakeProvider(finalReply);
    const refused = await send(u, third, config);
    assert.deepEqual([refused.status, codeOf(refused.body), third.seen.length], [429, "usage_budget_exceeded", 0]);
    assert.equal((await runsOf(u)).filter((row) => row.status === "running").length, 0);
  });
});

test("per-user concurrency: while one run waits at the real driver's fetch, the same person's second request is 429 and sends nothing", async () => {
  await withUser(async (u) => {
    await consent(u);
    let open!: () => void;
    let arrived!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    const first = fakeProvider(async (init) => {
      arrived();
      await gate;
      return finalReply(init);
    });
    const running = send(u, first);
    await reached;
    const second = fakeProvider(finalReply);
    const refused = await send(u, second);
    assert.deepEqual([refused.status, codeOf(refused.body), second.seen.length], [429, "too_many_concurrent_runs", 0]);
    open();
    assert.equal((await running).status, 200);
    assert.equal(first.seen.length, 1);
    assert.equal((await runsOf(u)).filter((row) => row.status === "running").length, 0);
  });
});
