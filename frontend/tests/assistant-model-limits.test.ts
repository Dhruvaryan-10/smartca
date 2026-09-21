// Phase 6K: the provider-neutral limits on ModelAdapter (services/assistant/model.ts). PURE: no provider, no network, no database, no
// DATABASE_URL. Every adapter here is a local fake; time is real but the margins are wide (a hung fake is cut off after a few
// tens of milliseconds).
//
// What is pinned: a per-call timeout and a caller's AbortSignal are enforced even when the adapter ignores them; a total run budget
// bounds a whole run; every failure is a typed, provider-neutral ModelProviderError with a fixed message; a response carries
// recipient/model metadata; an oversized answer is refused; and a response from a recipient that is not on the approved list (or
// that names none) fails closed before any of its content is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_ERROR_CODES,
  MAX_MESSAGE_CHARS,
  MAX_MODEL_TIMEOUT_MS,
  ModelProviderError,
  ModelResponseError,
  assertModelResponse,
  withModelGuard,
} from "../services/assistant/model";
import type { ModelAdapter, ModelCallInfo, ModelCallOptions, ModelRequest } from "../services/assistant/model";
import { runAssistant } from "../services/assistant/orchestrator";
import { askAssistant } from "../services/assistant/ask";
import { AssistantFailure } from "../lib/assistant/failure";
import { USER, ask, call, scriptedModel, stubTools, text, toolCalls } from "./helpers-orchestrator";
import { everythingOn } from "./helpers-errors";

const request = (): ModelRequest => ({ messages: [{ role: "user", content: "hello" }] });
const META = { recipient: "synthetic-local", model: "fixture-v1", inputTokens: 12, outputTokens: 3 };
const NO_META = Symbol("no metadata");
const okText = (t = "fine", meta: unknown = META) => ({ kind: "text", text: t, ...(meta === NO_META ? {} : { meta }) });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An adapter that never answers until its signal is aborted, and records what it was told. */
function hangingAdapter(): ModelAdapter & { seen: ModelCallOptions[]; aborted: () => boolean } {
  const seen: ModelCallOptions[] = [];
  return {
    seen,
    aborted: () => seen.some((o) => o.signal?.aborted === true),
    complete: (_request, options) => new Promise((_resolve, reject) => {
      seen.push(options ?? {});
      options?.signal?.addEventListener("abort", () => reject(new Error("aborted by the guard")), { once: true });
    }),
  };
}
/** An adapter that IGNORES the signal entirely and never answers: only the guard's own deadline can stop it. */
const deaf: ModelAdapter = { complete: () => new Promise(() => undefined) };
const answering = (response: unknown, delayMs = 0): ModelAdapter => ({ complete: async () => { if (delayMs > 0) await sleep(delayMs); return response as never; } });

const rejectsProvider = async (work: () => Promise<unknown>, code: string, label: string) => {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof ModelProviderError, `${label}: expected a ModelProviderError, got ${String(error)}`);
    assert.equal(error.code, code, label);
    return true;
  });
};

// --- timeout and abort ------------------------------------------------------------------------------------------------------

test("a per-call timeout is enforced: a hung adapter is cut off, told to stop, and the error is typed", async () => {
  const adapter = hangingAdapter();
  const started = Date.now();
  await rejectsProvider(() => withModelGuard(adapter, { timeoutMs: 40 }).complete(request()), "timeout", "hung adapter");
  assert.ok(Date.now() - started < 2000, "returned promptly");
  assert.equal(adapter.seen.length, 1);
  assert.ok(adapter.seen[0].signal instanceof AbortSignal, "the adapter was handed an AbortSignal");
  assert.equal(adapter.aborted(), true, "and the signal was aborted when the deadline passed");
});

test("the timeout holds even for an adapter that ignores the signal", async () => {
  await rejectsProvider(() => withModelGuard(deaf, { timeoutMs: 30 }).complete(request()), "timeout", "deaf adapter");
});

test("a fast answer is not delayed or aborted by the timeout, and no timer is left behind", async () => {
  const adapter = { seen: [] as ModelCallOptions[], complete: async (_r: ModelRequest, o?: ModelCallOptions) => { adapter.seen.push(o ?? {}); return okText() as never; } };
  const timers = () => process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;
  const before = timers();
  const response = await withModelGuard(adapter, { timeoutMs: 5_000 }).complete(request());
  assert.equal(timers(), before, "the call's timer was cleared: nothing is left running for the rest of its 5 seconds");
  assert.equal(response.kind, "text");
  assert.equal(adapter.seen[0].signal?.aborted, false, "a call that finished in time is never aborted");
  assert.equal(adapter.seen[0].timeoutMs, 5_000, "the adapter is told its deadline");
});

test("a caller's AbortSignal cancels the call; one that is already aborted never reaches the adapter", async () => {
  const controller = new AbortController();
  const adapter = hangingAdapter();
  const pending = withModelGuard(adapter, { signal: controller.signal, timeoutMs: 5_000 }).complete(request());
  setTimeout(() => controller.abort(), 20);
  await rejectsProvider(() => pending, "aborted", "aborted while running");
  assert.equal(adapter.aborted(), true);

  let called = 0;
  const counting: ModelAdapter = { complete: async () => { called += 1; return okText() as never; } };
  const done = new AbortController();
  done.abort();
  await rejectsProvider(() => withModelGuard(counting, { signal: done.signal }).complete(request()), "aborted", "already aborted");
  assert.equal(called, 0);
});

test("a total run budget bounds the call and is reported as its own code; a shorter per-call timeout still reports timeout", async () => {
  await rejectsProvider(() => withModelGuard(deaf, { deadlineAt: Date.now() + 30, timeoutMs: 5_000 }).complete(request()), "budget_exceeded", "budget is the binding limit");
  await rejectsProvider(() => withModelGuard(deaf, { deadlineAt: Date.now() + 5_000, timeoutMs: 30 }).complete(request()), "timeout", "timeout is the binding limit");
  let called = 0;
  const counting: ModelAdapter = { complete: async () => { called += 1; return okText() as never; } };
  await rejectsProvider(() => withModelGuard(counting, { deadlineAt: Date.now() - 1 }).complete(request()), "budget_exceeded", "budget already spent");
  assert.equal(called, 0, "a spent budget never starts another call");
});

test("the budget spans a whole run: a second model call that would exceed it fails, and the first was allowed", async () => {
  let calls = 0;
  const slow: ModelAdapter = {
    complete: async () => {
      calls += 1;
      await sleep(100);
      return (calls === 1 ? { kind: "tool_calls", calls: [call("c1", "get_financial_summary", {})], meta: META } : okText("done")) as never;
    },
  };
  const { tools } = stubTools();
  await rejectsProvider(() => runAssistant({ userId: USER, messages: ask() }, { model: slow, tools, modelPolicy: { runBudgetMs: 160, timeoutMs: 5_000 } }), "budget_exceeded", "second call over budget");
  assert.equal(calls, 2, "the first call finished inside the budget, the second was cut off");
});

test("the orchestrator's modelPolicy timeout stops a hung model, typed, with no result", async () => {
  await rejectsProvider(() => runAssistant({ userId: USER, messages: ask() }, { model: deaf, tools: stubTools().tools, modelPolicy: { timeoutMs: 30 } }), "timeout", "orchestrator");
});

test("an invalid runBudgetMs is refused before any model call, as a RangeError that names no value", async () => {
  let called = 0;
  const counting: ModelAdapter = { complete: async () => { called += 1; return okText() as never; } };
  for (const runBudgetMs of [0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => runAssistant({ userId: USER, messages: ask() }, { model: counting, tools: stubTools().tools, modelPolicy: { runBudgetMs } }),
      (error: unknown) => error instanceof RangeError && !/\d/.test(error.message),
      String(runBudgetMs),
    );
  }
  assert.equal(called, 0, "a bad run budget never starts a model call");
  await assert.doesNotReject(() => runAssistant({ userId: USER, messages: ask() }, { model: scriptedModel(text("ok")), tools: stubTools().tools, modelPolicy: { runBudgetMs: 5_000 } }), "a whole-number budget is accepted");
});

test("an outside AbortSignal on the orchestrator's modelPolicy cancels a hung run, typed", async () => {
  const controller = new AbortController();
  const pending = runAssistant({ userId: USER, messages: ask() }, { model: deaf, tools: stubTools().tools, modelPolicy: { signal: controller.signal, timeoutMs: 5_000 } });
  setTimeout(() => controller.abort(), 20);
  await rejectsProvider(() => pending, "aborted", "orchestrator signal passthrough");
});

// --- typed, provider-neutral errors ---------------------------------------------------------------------------------------------

test("a ModelProviderError has a closed set of codes, a fixed message, and nothing else: no cause, no detail, no free text", () => {
  assert.deepEqual([...MODEL_ERROR_CODES].sort(), ["aborted", "budget_exceeded", "invalid_response", "output_too_large", "rate_limited", "recipient_not_approved", "refused", "timeout", "unavailable"]);
  const messages = new Set<string>();
  for (const code of MODEL_ERROR_CODES) {
    const error = new ModelProviderError(code);
    assert.equal(error.code, code);
    assert.equal(error.name, "ModelProviderError");
    assert.ok(error instanceof Error);
    assert.equal("cause" in error, false);
    assert.deepEqual(Object.keys(error).sort(), ["code", "name"], "only the code (and the class name) are own fields");
    assert.match(error.message, /^[A-Z][^\n]{5,80}\.$/, "one short sentence");
    messages.add(error.message);
  }
  assert.equal(messages.size, MODEL_ERROR_CODES.length, "each code has its own message");
});

test("an adapter's own typed provider error passes through the guard unchanged; any other failure still propagates as it is", async () => {
  const limited = new ModelProviderError("rate_limited");
  await assert.rejects(() => withModelGuard({ complete: async () => { throw limited; } }).complete(request()), (e: unknown) => e === limited);
  const plain = new Error("provider unavailable");
  await assert.rejects(() => withModelGuard({ complete: async () => { throw plain; } }).complete(request()), (e: unknown) => e === plain);
});

test("a typed provider error reaches askAssistant unchanged, while an untyped one is reduced to an AssistantFailure", async () => {
  const typed = new ModelProviderError("unavailable");
  await assert.rejects(() => askAssistant({ userId: USER, userMessages: ["hi"] }, { model: { complete: async () => { throw typed; } }, tools: stubTools().tools }), (e: unknown) => e === typed);
  await assert.rejects(
    () => askAssistant({ userId: USER, userMessages: ["hi"] }, { model: { complete: async () => { throw new Error("secret detail"); } }, tools: stubTools().tools }),
    (e: unknown) => e instanceof AssistantFailure && !everythingOn(e).includes("secret detail"),
  );
});

// --- output size ---------------------------------------------------------------------------------------------------------------------

test("an answer longer than maxOutputChars is refused as output_too_large, including one over the generic limit", async () => {
  await rejectsProvider(() => withModelGuard(answering(okText("x".repeat(101))), { maxOutputChars: 100 }).complete(request()), "output_too_large", "101 > 100");
  await rejectsProvider(() => withModelGuard(answering(okText("x".repeat(MAX_MESSAGE_CHARS + 1))), { maxOutputChars: 100 }).complete(request()), "output_too_large", "over the generic limit too");
  const exact = await withModelGuard(answering(okText("x".repeat(100))), { maxOutputChars: 100 }).complete(request());
  assert.equal(exact.kind === "text" && exact.text.length, 100, "exactly the limit is accepted");
  const calls = { kind: "tool_calls", meta: META, calls: [{ id: "c1", name: "search_thing", arguments: { kind: "json", value: { q: "y".repeat(200) } } }] };
  await rejectsProvider(() => withModelGuard(answering(calls), { maxOutputChars: 100 }).complete(request()), "output_too_large", "tool-call arguments count too");
  assert.equal((await withModelGuard(answering(calls), { maxOutputChars: 1_000 }).complete(request())).kind, "tool_calls");
});

test("the adapter is told the output limit so it can stop early", async () => {
  const seen: ModelCallOptions[] = [];
  await withModelGuard({ complete: async (_r, o) => { seen.push(o ?? {}); return okText() as never; } }, { maxOutputChars: 500 }).complete(request());
  assert.equal(seen[0].maxOutputChars, 500);
});

// --- recipient allow-list ---------------------------------------------------------------------------------------------------------

test("a response from a recipient that is not approved fails closed, as does one that names no recipient", async () => {
  const policy = { approvedRecipients: ["synthetic-local", "second-approved"] };
  const ok = await withModelGuard(answering(okText()), policy).complete(request());
  assert.deepEqual(ok.meta, META, "an approved recipient's metadata is kept on the response");
  await rejectsProvider(() => withModelGuard(answering(okText("fine", { ...META, recipient: "other-place" })), policy).complete(request()), "recipient_not_approved", "unlisted");
  await rejectsProvider(() => withModelGuard(answering(okText("fine", NO_META)), policy).complete(request()), "recipient_not_approved", "no metadata");
  await rejectsProvider(() => withModelGuard(answering(okText()), { approvedRecipients: [] }).complete(request()), "recipient_not_approved", "an empty list approves nothing");
  // The rule applies to tool calls too: a tool call from an unapproved recipient is never handed on.
  const fromElsewhere = { kind: "tool_calls", meta: { ...META, recipient: "other-place" }, calls: [{ id: "c", name: "search_thing", arguments: { kind: "json", value: {} } }] };
  await rejectsProvider(() => withModelGuard(answering(fromElsewhere), policy).complete(request()), "recipient_not_approved", "tool calls");
});

test("with no allow-list the metadata is optional, so existing adapters are unaffected", async () => {
  const plain = await withModelGuard(answering({ kind: "text", text: "fine" })).complete(request());
  assert.deepEqual(plain, { kind: "text", text: "fine" }, "no metadata added, no field invented");
});

test("response metadata is validated: plain identifiers and non-negative whole token counts only, and nothing extra", () => {
  assert.deepEqual(assertModelResponse(okText()).meta, META);
  const bad: Array<[string, unknown]> = [
    ["recipient with a space", { ...META, recipient: "my provider" }],
    ["recipient with a newline", { ...META, recipient: "a\nb" }],
    ["recipient too long", { ...META, recipient: "r".repeat(65) }],
    ["recipient not text", { ...META, recipient: 5 }],
    ["model missing", { recipient: "synthetic-local" }],
    ["negative tokens", { ...META, inputTokens: -1 }],
    ["fractional tokens", { ...META, outputTokens: 1.5 }],
    ["an extra field", { ...META, apiKey: "nope" }],
    ["not an object", "synthetic-local"],
  ];
  for (const [label, meta] of bad) assert.throws(() => assertModelResponse(okText("x", meta)), ModelResponseError, label);
});

// --- metadata for the audit, never content ---------------------------------------------------------------------------------

test("onCall receives metadata only, for successes and for typed failures: recipient, model, token counts, duration and outcome", async () => {
  const infos: ModelCallInfo[] = [];
  const policy = { approvedRecipients: ["synthetic-local"], maxOutputChars: 50, onCall: (i: ModelCallInfo) => { infos.push(i); } };
  await withModelGuard(answering(okText("SECRET-CONTENT-A")), policy).complete({ messages: [{ role: "user", content: "SECRET-PROMPT" }] });
  await rejectsProvider(() => withModelGuard(answering(okText("fine", { ...META, recipient: "other-place" })), policy).complete(request()), "recipient_not_approved", "unlisted");
  await rejectsProvider(() => withModelGuard(answering(okText("x".repeat(60))), policy).complete(request()), "output_too_large", "too long");
  await rejectsProvider(() => withModelGuard(deaf, { ...policy, timeoutMs: 20 }).complete(request()), "timeout", "timeout");
  assert.deepEqual(infos.map((i) => i.outcome), ["ok", "recipient_not_approved", "output_too_large", "timeout"]);
  assert.deepEqual([infos[0].recipient, infos[0].model, infos[0].inputTokens, infos[0].outputTokens], ["synthetic-local", "fixture-v1", 12, 3]);
  assert.equal(infos[1].recipient, "other-place", "the refused recipient is recorded, so the audit can see who answered");
  assert.equal(infos[3].recipient, null, "no answer, no recipient");
  for (const info of infos) {
    assert.deepEqual(Object.keys(info).sort(), ["durationMs", "inputTokens", "model", "outcome", "outputTokens", "recipient"]);
    assert.ok(Number.isInteger(info.durationMs) && info.durationMs >= 0);
  }
  assert.equal(JSON.stringify(infos).includes("SECRET"), false, "no prompt and no answer text in the metadata");
});

// --- policy sanity ------------------------------------------------------------------------------------------------------------------

test("an invalid policy is refused when the guard is built, naming the field and never a value", () => {
  for (const policy of [{ timeoutMs: 0 }, { timeoutMs: -5 }, { timeoutMs: 1.5 }, { timeoutMs: MAX_MODEL_TIMEOUT_MS + 1 }, { timeoutMs: Number.NaN }, { maxOutputChars: 0 }, { maxOutputChars: MAX_MESSAGE_CHARS + 1 }, { deadlineAt: Number.NaN }, { approvedRecipients: ["bad recipient"] }]) {
    assert.throws(() => withModelGuard(scriptedModel(), policy as never), (e: unknown) => e instanceof RangeError && !/\d{5,}/.test(e.message.replace(/120000|50000/g, "")), JSON.stringify(policy));
  }
  assert.doesNotThrow(() => withModelGuard(scriptedModel(), { timeoutMs: 1, maxOutputChars: 1, approvedRecipients: ["a"] }));
});

test("the existing behaviour is untouched: an adapter written for the old one-argument interface still works through the guard", async () => {
  const model = scriptedModel(text("hi"));
  const response = await withModelGuard(model).complete(request());
  assert.deepEqual(response, { kind: "text", text: "hi" });
  const round = await runAssistant({ userId: USER, messages: ask() }, { model: scriptedModel(toolCalls(call("c", "get_financial_summary", {})), text("done")), tools: stubTools().tools });
  assert.equal(round.text, "done");
});
