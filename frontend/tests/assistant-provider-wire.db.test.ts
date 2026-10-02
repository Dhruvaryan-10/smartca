// A HOSTILE OR BROKEN PROVIDER, through the REAL driver (services/assistant/provider-chat-completions.ts) and the complete external path,
// against the local PostgreSQL. The provider E2E test (assistant-provider-e2e.db.test.ts) pins the honest round-trip and the transport
// failures; this file pins what SmartCA does when a 2xx answer itself is the attack or the fault:
//
//   tool calls the model may not make     a tool outside the run's plan, a name that is no tool (a write), identity or permission
//                                         fields smuggled into tool arguments, argument text that is not JSON, a reused call id, more
//                                         calls than one answer may carry
//   answers that cannot be used           a body that is not JSON, a body over the size limit (declared or streamed)
//   answers that try to look grounded     a citation of evidence no tool returned
//   data that is not the person's         another user's ledger, which no tool call can reach
//
// For each: the public code, its status and whether it says to retry; that no tool ran (or only the honest one); that the run is
// recorded and released; which usage is counted; and that no key, endpoint, user id or other person's data reaches the response, the run
// row, the events or the wire. Only the network is fake (an in-memory `fetch`), and the platform `fetch` is a tripwire for the whole file.
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
import { MAX_PROVIDER_RESPONSE_BYTES, chatCompletionsDriver } from "../services/assistant/provider-chat-completions";
import type { FetchLike } from "../services/assistant/provider-chat-completions";
import { createTransaction } from "../services/transactions";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import type { EgressFieldClass } from "../lib/assistant/tool-contract";
import { deleteTestUser, makeTestUser } from "./helpers";

const KEY = "test-key-NOT-A-REAL-SECRET-0011";
const ENDPOINT = "https://provider.invalid/v1/chat/completions";
const RECIPIENT = "recipient-a";
const MODEL = "fixture-model-1";
// A time no other test uses, so the global concurrency count sees only this file's runs.
const NOW = Date.UTC(2043, 2, 9, 12, 0, 0);
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: MODEL,
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "3000", MODEL_MAX_OUTPUT_CHARS: "20000",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "50", ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000",
  ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", MODEL_MAX_OUTPUT_TOKENS: "1024", MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RUN_RETENTION_DAYS: "400",
};
const CONFIG: AssistantConfig = validateExternalEnv(ENV);
const BODY = { messages: ["What did I spend this year?"] };
const TAX_ARGS = { regime: "old", assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };
/** Every class but tax_corpus_text: search_tax_law (which returns corpus text) is outside the plan. */
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

// --- the fake provider ----------------------------------------------------------------------------------------------------------------

type Step = () => Response;
function fakeProvider(...steps: Step[]): { fetch: FetchLike; bodies: string[] } {
  const bodies: string[] = [];
  return {
    bodies,
    fetch: async (_url, init) => {
      bodies.push(String(init.body));
      const step = steps.shift();
      if (step === undefined) throw new Error("the fake provider has no scripted answer left");
      return step();
    },
  };
}
const USAGE = { prompt_tokens: 100, completion_tokens: 20 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const completion = (message: Record<string, unknown>, finish: string) => json({ id: "chatcmpl-wire", object: "chat.completion", model: MODEL, choices: [{ index: 0, message, finish_reason: finish }], usage: USAGE });
type WireCall = { id: string; name: string; arguments: string };
const callsReply = (...calls: WireCall[]): Step => () =>
  completion({ role: "assistant", content: null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }, "tool_calls");
const textReply = (text: string): Step => () => completion({ role: "assistant", content: text }, "stop");
const call = (id: string, name: string, args: unknown): WireCall => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });

// --- the route, as app/api/assistant/route.ts calls it, with the real driver ----------------------------------------------------------

async function send(userId: string, provider: { fetch: FetchLike }) {
  const events: AssistantEvent[] = [];
  const response = await handleAssistantHttp(
    new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) }),
    { getSessionUserId: async () => userId, config: CONFIG, driver: chatCompletionsDriver({ fetch: provider.fetch }), now: () => NOW, onEvent: (e) => events.push(e) },
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as AssistantApiResponse, text, events };
}
type Sent = Awaited<ReturnType<typeof send>>;

async function withUsers(n: number, work: (ids: string[]) => Promise<void>) {
  const users = [];
  try {
    for (let i = 0; i < n; i += 1) users.push(await makeTestUser(`assistant-provider-wire-${i}`));
    await work(users.map((u) => u.id));
  } finally {
    for (const u of users) await deleteTestUser(u.id);
  }
}
const consent = (userId: string, dataClasses: readonly EgressFieldClass[] = EGRESS_FIELD_CLASSES) =>
  grantAssistantAuthorization(userId, { profileId: "full", recipient: RECIPIENT, dataClasses: [...dataClasses], issuedAt: new Date(NOW - 7_200_000), expiresAt: new Date(NOW + 7_200_000) });
const runsOf = (userId: string) => db.select().from(assistantRuns).where(eq(assistantRuns.userId, userId));

function assertNoSecrets(where: string, text: string, ...more: string[]) {
  for (const s of [KEY, ENDPOINT, process.env.DATABASE_URL, process.env.AUTH_SECRET, ...more].filter((v): v is string => typeof v === "string" && v.length > 0)) {
    assert.equal(text.includes(s), false, `${where} leaked ${s.slice(0, 12)}…`);
  }
}

/**
 * A run the provider's 2xx answer ended, after admission: the public error, one failed and released run row of that error, no tool
 * executed, and nothing secret anywhere. `usage` is what the row must count for the call(s) made.
 */
async function assertRefusedRun(userId: string, r: Sent, expected: { status: number; code: string; retryable: boolean; failureKind: RegExp; modelCalls: number; usage: [number | null, number | null] }) {
  assert.equal(r.body.ok, false);
  assert.ok(!r.body.ok);
  assert.deepEqual([r.status, r.body.error.code, r.body.error.retryable], [expected.status, expected.code, expected.retryable]);
  const rows = await runsOf(userId);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual([row.status, row.resultCode, row.modelCalls], ["failed", expected.code, expected.modelCalls]);
  assert.match(String(row.failureKind), expected.failureKind);
  assert.deepEqual([row.inputTokens, row.outputTokens], expected.usage);
  assert.equal(row.finishedAt instanceof Date, true, "the slot was released");
  assert.equal(r.events.some((e) => e.type === "tool_call" && e.outcome === "ok"), false, "no tool executed");
  assertNoSecrets("the response", r.text, userId);
  assertNoSecrets("the run row", JSON.stringify(row)); // the row is the person's own (user_id); it must hold no secret
  assertNoSecrets("the events", JSON.stringify(r.events), userId);
}

// --- tool calls the model may not make ------------------------------------------------------------------------------------------------

test("a tool outside the run's plan is refused before anything runs, even though it is one of the six", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u, CLASSES_WITHOUT_CORPUS);
    const provider = fakeProvider(callsReply(call("c1", "search_tax_law", { question: "What is section 80C?" })));
    const r = await send(u, provider);
    await assertRefusedRun(u, r, { status: 422, code: "assistant_could_not_complete", retryable: false, failureKind: /^OrchestratorError:unknown_tool$/, modelCalls: 1, usage: [100, 20] });
    assert.equal(provider.bodies.length, 1, "no second provider request, so no tool result went out");
  });
});

test("a name that is no read tool (a write, a made-up admin tool) is refused, and nothing in its batch runs, not even an allowed call", async () => {
  await withUsers(1, async ([u]) => {
    for (const name of ["save_tax_computation", "delete_transactions", "grant_consent", "set_allowed_tools"]) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      await consent(u);
      const provider = fakeProvider(callsReply(call("c1", "calculate_tax", TAX_ARGS), call("c2", name, {})));
      const r = await send(u, provider);
      await assertRefusedRun(u, r, { status: 422, code: "assistant_could_not_complete", retryable: false, failureKind: /^OrchestratorError:unknown_tool$/, modelCalls: 1, usage: [100, 20] });
      assert.equal(provider.bodies.length, 1, name);
    }
  });
});

test("identity or permission fields smuggled into tool arguments are refused: the model cannot name a user or widen its own access", async () => {
  await withUsers(2, async ([u, other]) => {
    const smuggled: Array<[string, unknown]> = [
      ["calculate_tax", { ...TAX_ARGS, userId: other }],
      ["query_transactions", { limit: 5, userId: other }],
      ["query_transactions", { limit: 5, allowedTools: ["search_tax_law"] }],
      ["get_financial_summary", { profile: "full" }],
      ["query_transactions", { limit: 5, dataClasses: ["user_free_text"] }],
      ["calculate_tax", { ...TAX_ARGS, income: { salaryPaise: 1, userId: other } }],
    ];
    for (const [tool, args] of smuggled) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      await consent(u);
      const provider = fakeProvider(callsReply(call("c1", tool, args)));
      const r = await send(u, provider);
      await assertRefusedRun(u, r, { status: 422, code: "assistant_could_not_complete", retryable: false, failureKind: /^OrchestratorError:(invalid_tool_arguments|malformed_tool_arguments)$/, modelCalls: 1, usage: [100, 20] });
      assert.equal(provider.bodies.length, 1, `${tool} ${JSON.stringify(Object.keys(args as object))}`);
      assertNoSecrets("the response", r.text, other);
    }
  });
});

test("tool-call argument text that is not JSON is refused as malformed, never parsed leniently or run", async () => {
  await withUsers(1, async ([u]) => {
    for (const raw of ["{regime: old}", "", "[1,2", "\"calculate_tax\"", "null"]) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      await consent(u);
      const provider = fakeProvider(callsReply(call("c1", "calculate_tax", raw)));
      const r = await send(u, provider);
      await assertRefusedRun(u, r, { status: 422, code: "assistant_could_not_complete", retryable: false, failureKind: /^OrchestratorError:(malformed_tool_arguments|invalid_tool_arguments)$/, modelCalls: 1, usage: [100, 20] });
      assert.equal(provider.bodies.length, 1, JSON.stringify(raw));
    }
  });
});

test("an answer that reuses a tool-call id, or carries more calls than one answer may, is an unusable answer: nothing runs", async () => {
  await withUsers(1, async ([u]) => {
    const cases: Array<[string, WireCall[]]> = [
      ["a reused id", [call("dup", "calculate_tax", TAX_ARGS), call("dup", "calculate_tax", TAX_ARGS)]],
      ["nine calls", Array.from({ length: 9 }, (_, i) => call(`c${i}`, "calculate_tax", TAX_ARGS))],
    ];
    for (const [name, calls] of cases) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      await consent(u);
      const provider = fakeProvider(callsReply(...calls));
      const r = await send(u, provider);
      // The guard refuses the answer's shape, so its own usage stays unaccepted; only usage the adapter vouched for (the configured model's)
      // is counted.
      await assertRefusedRun(u, r, { status: 502, code: "provider_invalid_response", retryable: false, failureKind: /^OrchestratorError:invalid_model_response$/, modelCalls: 1, usage: [100, 20] });
      assert.equal(provider.bodies.length, 1, name);
    }
  });
});

// --- answers that cannot be used --------------------------------------------------------------------------------------------------------

test("a 2xx body that is not JSON is provider_invalid_response, not retryable, with no usage invented", async () => {
  await withUsers(1, async ([u]) => {
    for (const body of ["<html>gateway</html>", "", "{\"model\":", "null"]) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      await consent(u);
      const provider = fakeProvider(() => new Response(body, { status: 200 }));
      const r = await send(u, provider);
      await assertRefusedRun(u, r, { status: 502, code: "provider_invalid_response", retryable: false, failureKind: /^ModelProviderError:invalid_response$/, modelCalls: 1, usage: [null, null] });
    }
  });
});

test("an oversized answer, declared or streamed, is provider_invalid_response and NOT retryable: it was answered, not unavailable", async () => {
  await withUsers(1, async ([u]) => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(32);
    const oversized: Array<[string, Step]> = [
      ["declared", () => new Response("{}", { status: 200, headers: { "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) } })],
      ["streamed", () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(chunk); } }), { status: 200 })],
    ];
    for (const [name, step] of oversized) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      await consent(u);
      const r = await send(u, fakeProvider(step));
      // Its usage is unknown: the body was not read to the end, so nothing is counted (and nothing is estimated).
      await assertRefusedRun(u, r, { status: 502, code: "provider_invalid_response", retryable: false, failureKind: /^ModelProviderError:invalid_response$/, modelCalls: 1, usage: [null, null] });
      assert.equal(r.events.some((e) => e.type === "provider_failure" && e.code === "invalid_response"), true, name);
    }
    assert.ok(pulled * chunk.byteLength <= MAX_PROVIDER_RESPONSE_BYTES + 2 * chunk.byteLength, "reading stopped at the limit");
  });
});

// --- answers that try to look grounded ------------------------------------------------------------------------------------------------

test("a final answer citing evidence no tool returned, and claiming statute authority, is withheld: 200, no text, no invented fact", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const provider = fakeProvider(textReply("The statute says your rebate is ₹12,500 [ev_0123456789abcdef]."));
    const r = await send(u, provider);
    assert.deepEqual([r.status, r.body.ok], [200, true]);
    assert.ok(r.body.ok);
    assert.equal(r.body.answer.state, "withheld");
    assert.equal(r.body.answer.text, null);
    assert.deepEqual(r.body.answer.citations, []);
    assert.deepEqual(r.body.answer.facts.evidence, []);
    assert.ok(r.body.answer.violations.some((v) => v.code === "invented_evidence_id"));
    const [row] = await runsOf(u);
    assert.deepEqual([row.status, row.answerState, row.modelCalls, row.inputTokens, row.outputTokens], ["succeeded", "withheld", 1, 100, 20]);
    assertNoSecrets("the response", r.text, u);
  });
});

// --- data that is not the person's ----------------------------------------------------------------------------------------------------

test("another user's ledger never reaches the wire: the model's tool call runs as the session user, whatever it asks for", async () => {
  await withUsers(2, async ([u, other]) => {
    const MINE = "groceries-wire-mine-7f3a";
    const THEIRS = "salary-wire-theirs-91bc";
    await createTransaction(u, { type: "expense", amountPaise: 123_456, category: "Food", description: MINE, occurredOn: "2026-05-01" });
    await createTransaction(other, { type: "income", amountPaise: 987_654_321, category: "Salary", description: THEIRS, occurredOn: "2026-05-02" });
    await consent(u);
    const provider = fakeProvider(callsReply(call("c1", "query_transactions", { limit: 50, includeDescription: true })), textReply("Here are your transactions."));
    const r = await send(u, provider);
    assert.deepEqual([r.status, r.body.ok], [200, true]);
    assert.equal(provider.bodies.length, 2);
    const toolResultOnWire = provider.bodies[1];
    assert.ok(toolResultOnWire.includes(MINE), "the person's own row went out, as consented");
    assert.equal(toolResultOnWire.includes(THEIRS), false, "another user's description never went out");
    assert.equal(toolResultOnWire.includes("987654321"), false, "another user's amount never went out");
    for (const body of provider.bodies) assertNoSecrets("the request body", body, u, other);
    assertNoSecrets("the response", r.text, other, THEIRS);
  });
});

// --- the production driver, as the registry builds it from MODEL_WIRE_FORMAT --------------------------------------------------------------

/** Runs `work` with the platform fetch replaced by `fake` (the registry's driver uses the platform fetch), then puts the tripwire back. */
async function withPlatformFetch(fake: FetchLike, work: () => Promise<void>) {
  const tripwire = globalThis.fetch;
  globalThis.fetch = ((url: string, init: RequestInit) => fake(url, init)) as typeof fetch;
  try {
    await work();
  } finally {
    globalThis.fetch = tripwire;
  }
}
async function sendWith(userId: string, config: AssistantConfig) {
  const response = await handleAssistantHttp(
    new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) }),
    { getSessionUserId: async () => userId, config, now: () => NOW },
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as AssistantApiResponse, text };
}

test("with no driver injected, the registry's driver speaks the configured wire format: exactly one cap field, the configured value", async () => {
  await withUsers(1, async ([u]) => {
    for (const [format, field, other] of [["openai-chat-completions", "max_completion_tokens", "max_tokens"], ["openai-chat-completions-max-tokens", "max_tokens", "max_completion_tokens"]] as const) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      await consent(u);
      const provider = fakeProvider(textReply("Done."));
      await withPlatformFetch(provider.fetch, async () => {
        const r = await sendWith(u, validateExternalEnv({ ...ENV, MODEL_WIRE_FORMAT: format, MODEL_MAX_OUTPUT_TOKENS: "333" }));
        assert.deepEqual([r.status, r.body.ok], [200, true], format);
      });
      assert.equal(provider.bodies.length, 1);
      const body = JSON.parse(provider.bodies[0]) as Record<string, unknown>;
      assert.equal(body[field], 333, format);
      assert.equal(other in body, false, `${format} never sends ${other}`);
    }
  });
});

test("an unknown wire format fails closed before consent is read: 503 assistant_misconfigured, recorded, nothing sent", async () => {
  await withUsers(1, async ([u]) => {
    // No consent at all: the configuration is refused first, so the answer cannot even reveal whether consent exists.
    const provider = fakeProvider(textReply("never"));
    await withPlatformFetch(provider.fetch, async () => {
      for (const format of ["anthropic-messages", "", "OPENAI-CHAT-COMPLETIONS"]) {
        const r = await sendWith(u, { ...(CONFIG as Extract<AssistantConfig, { env: "external" }>), wireFormat: format as never });
        assert.deepEqual([r.status, r.body.ok ? "ok" : r.body.error.code], [503, "assistant_misconfigured"], JSON.stringify(format));
        assert.equal(r.text.includes(format === "" ? "\u0000" : format), false, "the value is not echoed");
      }
    });
    assert.equal(provider.bodies.length, 0);
    const rows = await runsOf(u);
    assert.ok(rows.length === 3 && rows.every((row) => row.status === "rejected" && row.resultCode === "assistant_misconfigured"));
  });
});

test("the provider refusing the key is 502 provider_configuration, not retryable, and its body (which quoted the key) is never read", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    const provider = fakeProvider(() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } }), { status: 401 }));
    const r = await send(u, provider);
    await assertRefusedRun(u, r, { status: 502, code: "provider_configuration", retryable: false, failureKind: /^ModelProviderError:authentication_failed$/, modelCalls: 1, usage: [null, null] });
  });
});

test("no automatic retry: a failing provider is asked exactly once per request; a client's retry is a new, counted, separately audited run", async () => {
  await withUsers(1, async ([u]) => {
    await consent(u);
    for (const [status, code, retryable] of [[503, "provider_unavailable", true], [429, "provider_rate_limited", true], [500, "provider_unavailable", true], [400, "provider_rejected", false]] as const) {
      await db.delete(assistantRuns).where(eq(assistantRuns.userId, u));
      const provider = fakeProvider(() => new Response("{}", { status }), () => new Response("{}", { status }));
      const first = await send(u, provider);
      assert.equal(provider.bodies.length, 1, `${status}: one attempt, no automatic retry`);
      assert.deepEqual([first.status, first.body.ok ? "ok" : first.body.error.code, first.body.ok ? null : first.body.error.retryable], [502, code, retryable]);
      // The client tries again: a new request, through consent and admission again, counted toward the window as a second run.
      const second = await send(u, provider);
      assert.equal(provider.bodies.length, 2, `${status}: the client's retry is the second attempt`);
      assert.equal(second.body.ok, false);
      const rows = await runsOf(u);
      assert.deepEqual(rows.map((row) => [row.status, row.resultCode, row.modelCalls]).sort(), [["failed", code, 1], ["failed", code, 1]]);
      assert.ok(rows.every((row) => row.finishedAt instanceof Date), "both released");
    }
  });
});
