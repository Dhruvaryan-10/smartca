// Phase 6 hardening (B5): the assistant's error boundary. PURE: no database, no model, no network, no DATABASE_URL.
//
// What may leave the assistant when something UNEXPECTED goes wrong is a code, the error's class name and (for the database) the
// database error code. Never a message, a statement, a bound parameter (a Drizzle error embeds them, and one of them is the
// userId), a raw tool result, or a string the model chose. Typed refusals and typed orchestrator errors are unchanged.
//
// The tool layer's own sanitising (createAssistantTools with a failing database) is in assistant-errors.db.test.ts, because
// importing the tools imports the database client.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantFailure } from "../lib/assistant/failure";
import { assertModelRequest, assertModelResponse, ModelRequestError, ModelResponseError } from "../services/assistant/model";
import { runAssistant } from "../services/assistant/orchestrator";
import { USER, ask, call, rejectsWith, scriptedModel, stubTools, toolCalls } from "./helpers-orchestrator";
import { everythingOn as everything, leakyDatabaseError } from "./helpers-errors";

const FRONTEND = path.resolve(__dirname, "..");

test("B5: an AssistantFailure keeps a code, the class name and the database code, and nothing that could carry the userId or the statement", () => {
  const raw = leakyDatabaseError();
  assert.match(raw.message, new RegExp(USER), "the premise: the raw driver error DOES carry the userId in its message");
  const failure = new AssistantFailure("tool_failed", raw, "query_transactions");
  assert.equal(failure.code, "tool_failed");
  assert.equal(failure.errorName, "DrizzleQueryError");
  assert.equal(failure.databaseCode, "57P01");
  assert.match(failure.message, /query_transactions/);
  const dump = everything(failure);
  for (const forbidden of [USER, "params", "select", "amount_paise", "user_id", "Failed query", "connection to"]) assert.equal(dump.includes(forbidden), false, `"${forbidden}" must not be reachable on the failure`);
  assert.equal("cause" in failure, false, "the raw error is not kept as a cause");
  assert.equal(failure instanceof Error, true);
});

test("B5: only plain identifiers survive as the class name and database code; anything else is dropped, not echoed", () => {
  const strange = Object.assign(new Error("secret message"), { name: `Bad ${USER}\nname`, code: `x ${USER}` });
  const failure = new AssistantFailure("unexpected_failure", strange);
  assert.equal(failure.errorName, null);
  assert.equal(failure.databaseCode, null);
  assert.equal(everything(failure).includes(USER), false);
  assert.equal(everything(failure).includes("secret message"), false);
  for (const thrown of ["a string", 42, null, undefined, { message: "x", code: 5 }]) {
    const f = new AssistantFailure("unexpected_failure", thrown);
    assert.equal(f.errorName === null || /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f.errorName), true);
    assert.equal(f.databaseCode, null);
  }
});

test("B5: an unbounded field name a model sends is clipped in every error, not echoed", async () => {
  const huge = "x".repeat(5000);
  // The assistant's own tool-argument validators.
  const { tools } = stubTools();
  const error = await rejectsWith("invalid_tool_arguments", () => runAssistant({ userId: USER, messages: ask() }, { model: scriptedModel(toolCalls(call("c", "query_transactions", { [huge]: 1 }))), tools }));
  assert.ok(error.message.length < 300, `the message is short (was ${error.message.length})`);
  assert.equal(error.message.includes("x".repeat(100)), false);
  // The model boundary: a request, and a provider's response.
  assert.throws(() => assertModelRequest({ messages: [{ role: "user", content: "hi" }], [huge]: 1 }), (e: unknown) => e instanceof ModelRequestError && e.message.length < 300 && !e.message.includes("x".repeat(100)));
  assert.throws(() => assertModelResponse({ kind: "text", text: "hi", [huge]: 1 }), (e: unknown) => e instanceof ModelResponseError && e.message.length < 300 && !e.message.includes("x".repeat(100)));
  assert.throws(() => assertModelRequest({ messages: [{ role: "user", content: "hi", [huge]: 1 }] }), (e: unknown) => e instanceof ModelRequestError && e.message.length < 300);
  // A control character or a newline in a name cannot forge a log line either.
  assert.throws(() => assertModelRequest({ messages: [{ role: "user", content: "hi" }], "a\nFORGED LOG LINE": 1 }), (e: unknown) => e instanceof ModelRequestError && !e.message.includes("\n"));
});

test("B5: the tool call id in a duplicate-id error is clipped too", () => {
  const id = "i".repeat(120);
  const response = { kind: "tool_calls", calls: [{ id, name: "query_transactions", arguments: { kind: "json", value: {} } }, { id, name: "query_transactions", arguments: { kind: "json", value: {} } }] };
  assert.throws(() => assertModelResponse(response), (e: unknown) => e instanceof ModelResponseError && e.message.length < 200 && !e.message.includes("i".repeat(60)));
});

test("B5: nothing in the assistant's source logs: no console, so no raw tool result or error can be printed by it", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const file of ["lib/assistant/answer.ts", "lib/assistant/args.ts", "lib/assistant/failure.ts", "services/assistant/model.ts", "services/assistant/orchestrator.ts", "services/assistant/tools.ts", "services/assistant/ask.ts"]) {
    assert.doesNotMatch(strip(fs.readFileSync(path.join(FRONTEND, file), "utf8")), /\bconsole\s*\.|\bprocess\.std(?:out|err)|\bdebugger\b/, `${file} prints nothing`);
  }
});
