// Phase 6C: the provider-neutral model interface (services/assistant/model.ts). There is no provider here. These tests
// use a scripted FAKE model, and pin what makes the interface safe for a future orchestrator to build on:
//   - it carries a conversation in, and either final text or tool calls out;
//   - a model's tool arguments that are not valid JSON are REPRESENTED (as malformed), never trusted or thrown away;
//   - it cannot receive a userId, and knows nothing of SmartCA's tools, the database, the engine or authorization;
//   - it needs no provider package.
// Pure: no database.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGES,
  MAX_MESSAGE_CHARS,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALLS_PER_RESPONSE,
  ModelRequestError,
  ModelResponseError,
  parseToolArguments,
  withModelGuard,
} from "../services/assistant/model";
import type { ModelAdapter, ModelMessage, ModelRequest, ModelResponse } from "../services/assistant/model";

const FRONTEND = path.resolve(__dirname, "..");

/** A fake model: returns scripted responses in order and records every request it was given. */
function scriptedModel(...responses: unknown[]): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(request);
      if (responses.length === 0) throw new Error("the script ran out");
      return responses.shift() as ModelResponse;
    },
  };
}

const user = (content: string): ModelMessage => ({ role: "user", content });
const request = (over: Record<string, unknown> = {}) => ({ messages: [user("hello")], ...over }) as unknown as ModelRequest;

// --- the two kinds of answer ---------------------------------------------------------

test("a model can answer with final text", async () => {
  const model = withModelGuard(scriptedModel({ kind: "text", text: "Section 87A gives a rebate." }));
  const response = await model.complete(request());
  assert.deepEqual(response, { kind: "text", text: "Section 87A gives a rebate." });
});

test("a model can answer with tool calls: a name and JSON arguments, which the adapter neither runs nor recognises", async () => {
  const calls = [
    { id: "call_1", name: "query_transactions", arguments: parseToolArguments('{"limit":5,"category":"Food"}') },
    // A name SmartCA has never heard of is just as valid: the adapter does not know the tools.
    { id: "call_2", name: "some_other_tool", arguments: parseToolArguments("{}") },
  ];
  const model = withModelGuard(scriptedModel({ kind: "tool_calls", calls }));
  const response = await model.complete(request());

  assert.equal(response.kind, "tool_calls");
  if (response.kind !== "tool_calls") throw new Error("unreachable");
  assert.deepEqual(response.calls.map((c) => c.name), ["query_transactions", "some_other_tool"]);
  assert.deepEqual(response.calls[0].arguments, { kind: "json", value: { limit: 5, category: "Food" } });
  assert.deepEqual(response.calls[1].arguments, { kind: "json", value: {} });
});

test("a tool round trip is a plain conversation: the call goes in an assistant message and its result in a tool message", async () => {
  const model = scriptedModel({ kind: "text", text: "You spent ₹350 on food." });
  const conversation: ModelMessage[] = [
    { role: "system", content: "You are a careful assistant." },
    user("How much did I spend on food?"),
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "query_transactions", arguments: parseToolArguments('{"category":"Food"}') }] },
    { role: "tool", toolCallId: "call_1", name: "query_transactions", content: '{"status":"ok"}' },
  ];
  const response = await withModelGuard(model).complete({ messages: conversation, tools: [{ name: "query_transactions", description: "Query the ledger.", parameters: { type: "object" } }] });
  assert.equal(response.kind, "text");
  assert.equal(model.requests.length, 1);
  assert.deepEqual(model.requests[0].messages, conversation, "the inner model sees exactly the conversation it was sent");
});

// --- malformed tool arguments --------------------------------------------------------

test("tool arguments that are not a JSON object are represented as malformed, safely, and never as parsed values", () => {
  for (const raw of ['{"limit": ', "not json", "", "   ", "[1,2,3]", "42", "null", '"a string"', "true", "{'limit': 5}"]) {
    const parsed = parseToolArguments(raw);
    assert.equal(parsed.kind, "malformed", JSON.stringify(raw));
    if (parsed.kind === "malformed") {
      assert.equal(typeof parsed.error, "string");
      assert.ok(parsed.error.length > 0);
      assert.ok(parsed.raw.length <= 500, "only a bounded excerpt of the raw text is kept");
    }
  }
  assert.deepEqual(parseToolArguments('{"a":{"b":[1,2]}}'), { kind: "json", value: { a: { b: [1, 2] } } });
  assert.deepEqual(parseToolArguments('  {"a": 1}  '), { kind: "json", value: { a: 1 } });
});

test("oversized arguments are malformed without being parsed, and only an excerpt is kept", () => {
  const huge = `{"note":"${"x".repeat(MAX_TOOL_ARGUMENT_CHARS)}"}`;
  const parsed = parseToolArguments(huge);
  assert.equal(parsed.kind, "malformed");
  if (parsed.kind === "malformed") {
    assert.match(parsed.error, /too large/i);
    assert.ok(parsed.raw.length <= 500);
  }
});

test("a response whose tool call has malformed arguments passes through as malformed: the orchestrator sees it and must decide", async () => {
  const calls = [{ id: "call_1", name: "query_transactions", arguments: parseToolArguments('{"limit": 5') }];
  const response = await withModelGuard(scriptedModel({ kind: "tool_calls", calls })).complete(request());
  assert.equal(response.kind, "tool_calls");
  if (response.kind === "tool_calls") {
    assert.equal(response.calls[0].arguments.kind, "malformed");
    assert.equal("value" in response.calls[0].arguments, false, "there is no value to mistake for parsed arguments");
  }
});

test("a provider adapter that hands back RAW argument text instead of the safe form is refused", async () => {
  const unsafe = { kind: "tool_calls", calls: [{ id: "call_1", name: "query_transactions", arguments: '{"limit":5}' }] };
  await assert.rejects(() => withModelGuard(scriptedModel(unsafe)).complete(request()), ModelResponseError);
  const lying = { kind: "tool_calls", calls: [{ id: "call_1", name: "t", arguments: { kind: "json", value: "not an object" } }] };
  await assert.rejects(() => withModelGuard(scriptedModel(lying)).complete(request()), ModelResponseError);
  // An object that is neither of the two safe forms: unparsed text dressed up with some other kind, or no kind at all.
  for (const arguments_ of [{ kind: "text", value: '{"limit":5}' }, { kind: "raw", raw: '{"limit":5}' }, {}, { value: { limit: 5 } }]) {
    const call = { kind: "tool_calls", calls: [{ id: "call_1", name: "t", arguments: arguments_ }] };
    await assert.rejects(() => withModelGuard(scriptedModel(call)).complete(request()), ModelResponseError, JSON.stringify(arguments_));
  }
  // The same holds for a tool call replayed inside a request.
  const replay = { messages: [{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: { kind: "raw", raw: "{}" } }] }] };
  await assert.rejects(() => withModelGuard(scriptedModel()).complete(replay as unknown as ModelRequest), ModelRequestError);
});

// --- the model cannot receive a userId -----------------------------------------------

test("the request type has no userId, and a request that carries one is refused before the model sees it", async () => {
  // @ts-expect-error: a request has no userId field, so TypeScript rejects it at compile time too
  const typed: ModelRequest = { messages: [user("hi")], userId: "someone" };
  void typed;

  const inner = scriptedModel({ kind: "text", text: "never reached" });
  const model = withModelGuard(inner);
  for (const bad of [
    request({ userId: "someone" }),
    request({ user_id: "someone" }),
    request({ messages: [{ role: "user", content: "hi", userId: "someone" }] }),
    request({ messages: [{ role: "tool", toolCallId: "c", name: "t", content: "x", userId: "someone" }] }),
    request({ tools: [{ name: "t", description: "d", parameters: {}, userId: "someone" }] }),
    request({ executor: {} }),
    request({ surprise: 1 }),
  ]) {
    await assert.rejects(() => model.complete(bad), (error: unknown) => error instanceof ModelRequestError && /userId|user_id|executor|surprise/.test(error.message));
  }
  assert.equal(inner.requests.length, 0, "the inner model was never called with an invalid request");
});

test("a request is a bounded, well-formed conversation, and anything else is refused", async () => {
  const model = withModelGuard(scriptedModel());
  const bad: Array<[string, unknown]> = [
    ["not an object", null],
    ["no messages", { messages: [] }],
    ["messages not a list", { messages: "hi" }],
    ["too many messages", { messages: Array.from({ length: MAX_MESSAGES + 1 }, () => user("x")) }],
    ["oversized message", { messages: [user("x".repeat(MAX_MESSAGE_CHARS + 1))] }],
    ["unknown role", { messages: [{ role: "developer", content: "x" }] }],
    ["content not text", { messages: [{ role: "user", content: 5 }] }],
    ["a user message may not carry tool calls", { messages: [{ role: "user", content: "x", toolCalls: [] }] }],
    ["a tool message needs its call id", { messages: [{ role: "tool", name: "t", content: "x" }] }],
    ["a bad tool name", { messages: [user("x")], tools: [{ name: "Bad Name!", description: "d", parameters: {} }] }],
    ["a tool needs a description", { messages: [user("x")], tools: [{ name: "t", parameters: {} }] }],
    ["duplicate tool names", { messages: [user("x")], tools: [{ name: "t", description: "d", parameters: {} }, { name: "t", description: "d", parameters: {} }] }],
    ["tools not a list", { messages: [user("x")], tools: {} }],
    ["assistant tool call with raw arguments", { messages: [{ role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] }] }],
  ];
  for (const [label, value] of bad) {
    await assert.rejects(() => model.complete(value as ModelRequest), ModelRequestError, label);
  }
  // And the good ones are accepted, including a request with no tools and an assistant turn that is only tool calls.
  const inner = scriptedModel({ kind: "text", text: "ok" }, { kind: "text", text: "ok" });
  const guarded = withModelGuard(inner);
  await guarded.complete({ messages: [user("x")] });
  await guarded.complete({ messages: [user("x")], tools: [{ name: "search_tax_law", description: "d", parameters: { type: "object", properties: {} } }] });
  assert.equal(inner.requests.length, 2);
});

// --- a provider's answer is checked too ----------------------------------------------

test("a response that is not final text or well-formed tool calls is refused", async () => {
  const bad: Array<[string, unknown]> = [
    ["nothing", undefined],
    ["a string", "hello"],
    ["unknown kind", { kind: "stream", text: "x" }],
    ["text that is not text", { kind: "text", text: 5 }],
    ["oversized text", { kind: "text", text: "x".repeat(MAX_MESSAGE_CHARS + 1) }],
    ["an extra field", { kind: "text", text: "x", userId: "someone" }],
    ["no calls", { kind: "tool_calls", calls: [] }],
    ["too many calls", { kind: "tool_calls", calls: Array.from({ length: MAX_TOOL_CALLS_PER_RESPONSE + 1 }, (_, i) => ({ id: `c${i}`, name: "t", arguments: { kind: "json", value: {} } })) }],
    ["a call with no id", { kind: "tool_calls", calls: [{ name: "t", arguments: { kind: "json", value: {} } }] }],
    ["a call with a bad name", { kind: "tool_calls", calls: [{ id: "c", name: "rm -rf", arguments: { kind: "json", value: {} } }] }],
    ["duplicate call ids", { kind: "tool_calls", calls: [{ id: "c", name: "t", arguments: { kind: "json", value: {} } }, { id: "c", name: "t", arguments: { kind: "json", value: {} } }] }],
    ["a call with an extra field", { kind: "tool_calls", calls: [{ id: "c", name: "t", arguments: { kind: "json", value: {} }, userId: "x" }] }],
  ];
  for (const [label, value] of bad) {
    await assert.rejects(() => withModelGuard(scriptedModel(value)).complete(request()), ModelResponseError, label);
  }
});

test("a provider failure is not swallowed: it propagates to the orchestrator", async () => {
  const failing: ModelAdapter = { complete: async () => { throw new Error("provider unavailable"); } };
  await assert.rejects(() => withModelGuard(failing).complete(request()), /provider unavailable/);
});

// --- the adapter is only an interface ------------------------------------------------

const code = (relative: string) => fs.readFileSync(path.join(FRONTEND, relative), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("the model adapter imports nothing: no database, no tool, no engine, no session, no provider", () => {
  const source = code("services/assistant/model.ts");
  assert.doesNotMatch(source, /^\s*import\b/m, "not one import statement");
  assert.doesNotMatch(source, /\brequire\(|\bimport\(|\bfrom\s+["']/, "and no dynamic or CommonJS import either");
  assert.doesNotMatch(source, /\b(db|executor|session|drizzle|next-auth)\b/i, "no database or authorization");
  assert.doesNotMatch(source, /tax-engine|calculateTax|compareRegimes|retrieveTaxLaw|assistantTools|createAssistantTools/, "no tax calculation, retrieval or tool execution");
  assert.doesNotMatch(source, /\b(search_tax_law|query_transactions|get_financial_summary|calculate_tax|compare_tax_regimes|simulate_tax)\b/, "it does not know SmartCA's tools");
  assert.doesNotMatch(source, /openai|anthropic|claude|gemini|mistral|cohere|omniroute|https?:|fetch\(|process\.env/i, "no provider, no network, no credential");
});

test("no model, provider or routing package is installed or needed", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(FRONTEND, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(names.filter((n) => /openai|anthropic|claude|gemini|mistral|cohere|langchain|llm|omniroute|@ai-sdk|^ai$/i.test(n)), []);
});

test("the tool layer and the model adapter stay separate: neither imports the other", () => {
  assert.doesNotMatch(code("services/assistant/tools.ts"), /\.\/model|assistant\/model/);
  assert.doesNotMatch(code("lib/assistant/args.ts"), /model/);
});
