// Phase 6 hardening (B5), the tool layer. DATABASE-BACKED file (note the .db in its name): importing the real tools imports the
// database client, so it needs DATABASE_URL (loaded from .env.local below). It runs NO query: the failing database and the
// failing retrieval are injected, so nothing is read or written.
//
// What is pinned: an unexpected failure inside a real tool leaves as an AssistantFailure (a code, the class name, the database
// code) and carries neither the userId nor the statement nor the question; and the failures that MEAN "no" are still typed
// refusals, unchanged. The pure side of the error boundary is in assistant-errors.test.ts and assistant-ask.test.ts.
import "../db/load-env";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantFailure } from "../lib/assistant/failure";
import { createAssistantTools } from "../services/assistant/tools";
import { askAssistant } from "../services/assistant/ask";
import { runAssistant } from "../services/assistant/orchestrator";
import { NotAuthenticatedError } from "../services/errors";
import { USER, ask, call, scriptedModel, taxBody, text, toolCalls } from "./helpers-orchestrator";
import { everythingOn, leakyDatabaseError } from "./helpers-errors";

const QUESTION = "What is the 87A rebate for my colleague Priya Sharma";
const failingLedger = () => createAssistantTools({ listTransactions: async () => { throw leakyDatabaseError(); } });

const assertSanitised = (error: unknown, tool: string) => {
  assert.ok(error instanceof AssistantFailure, `expected an AssistantFailure, got ${String(error)}`);
  assert.equal(error.code, "tool_failed");
  assert.equal(error.errorName, "DrizzleQueryError");
  assert.equal(error.databaseCode, "57P01");
  assert.match(error.message, new RegExp(tool));
  const dump = `${everythingOn(error)}\n${inspect(error, { depth: 8, showHidden: true })}`;
  for (const forbidden of [USER, "params", "select", "Failed query", "user_id", "amount_paise", "connection to"]) assert.equal(dump.includes(forbidden), false, `"${forbidden}" is not reachable on the failure`);
  return true;
};

test("B5: a database failure inside query_transactions and get_financial_summary leaves as an AssistantFailure with no userId and no statement", async () => {
  const tools = failingLedger();
  await assert.rejects(() => tools.query_transactions(USER, {}), (error) => assertSanitised(error, "query_transactions"));
  await assert.rejects(() => tools.get_financial_summary(USER, {}), (error) => assertSanitised(error, "get_financial_summary"));
});

test("B5: a failure inside retrieval leaves as an AssistantFailure that does not carry the question", async () => {
  const tools = createAssistantTools({ retrieve: async () => { throw new Error(`Failed query: select ... params: ${QUESTION}`); } });
  await assert.rejects(
    () => tools.search_tax_law(USER, { question: "What is the 87A rebate?", assessmentYear: "2026-27" }),
    (error) => {
      assert.ok(error instanceof AssistantFailure);
      assert.equal(error.code, "tool_failed");
      assert.equal(everythingOn(error).includes("Priya"), false);
      assert.equal(everythingOn(error).includes("Failed query"), false);
      return true;
    },
  );
});

test("B5: the failures that MEAN 'no' are still typed refusals, unchanged, and NotAuthenticatedError is still NotAuthenticatedError", async () => {
  const tools = failingLedger();
  const cases: Array<[string, Promise<{ status: string; reason?: string }>]> = [
    ["a userId argument", tools.query_transactions(USER, { userId: "someone-else" })],
    ["an over-limit", tools.query_transactions(USER, { limit: 9999 })],
    ["a bad date", tools.get_financial_summary(USER, { from: "2026-13-45", to: "2026-14-01" })],
    ["the new regime with an 80C deduction", tools.calculate_tax(USER, { regime: "new", ...taxBody })],
    ["an unsupported year", tools.calculate_tax(USER, { regime: "old", ...taxBody, assessmentYear: "2019-20" })],
  ];
  const results = await Promise.all(cases.map(([, work]) => work));
  assert.deepEqual(results.map((r) => [r.status, r.reason]), [
    ["refused", "invalid_arguments"], ["refused", "invalid_arguments"], ["refused", "invalid_arguments"], ["refused", "unsupported_tax_rule"], ["refused", "unsupported_assessment_year"],
  ]);
  await assert.rejects(() => tools.query_transactions("  ", {}), NotAuthenticatedError);
  // And one raised INSIDE a tool's work (an injected dependency) keeps its type instead of being flattened into a failure.
  const inner = createAssistantTools({ listTransactions: async () => { throw new NotAuthenticatedError(); } });
  await assert.rejects(() => inner.query_transactions(USER, {}), NotAuthenticatedError);
});

test("B5: through the orchestrator and the composed function, the sanitised failure arrives as it is: not wrapped again, and not raw", async () => {
  const model = () => scriptedModel(toolCalls(call("c", "query_transactions", {})), text("never reached"));
  await assert.rejects(() => runAssistant({ userId: USER, messages: ask("List my transactions") }, { model: model(), tools: failingLedger() }), (error) => assertSanitised(error, "query_transactions"));
  await assert.rejects(() => askAssistant({ userId: USER, userMessages: ["List my transactions"] }, { model: model(), tools: failingLedger() }), (error) => assertSanitised(error, "query_transactions"));
});
