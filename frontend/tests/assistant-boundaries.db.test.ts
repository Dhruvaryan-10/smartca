// Phase 6G: the assistant's DATA BOUNDARIES. Nothing here is a new feature; each test pins one way the assistant now
// sends, or returns, less personal data than it could have:
//   1. what the caller sees of tool activity is metadata, never ledger rows, and errors carry none either;
//   2. transaction free text is off by default, and capped when asked for;
//   3. a summary is always bounded, by a default period and a hard maximum range;
//   4. a tax-law question cannot trivially carry a person's details;
//   5. the model still gets whole tool results when it needs them.
// DB-backed where a real ledger matters (throwaway users, deleted afterwards); scripted model and stub tools elsewhere.
import "../db/load-env";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/client";
import { transactions } from "../db/schema";
import {
  MAX_CATEGORY_CHARS,
  MAX_LEDGER_DESCRIPTION_CHARS,
  MAX_LEDGER_SOURCE_CHARS,
  MAX_QUESTION_CHARS,
  MAX_QUESTION_FIGURES,
  MAX_SUMMARY_RANGE_DAYS,
} from "../lib/assistant/args";
import { parseToolArguments } from "../services/assistant/model";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../services/assistant/model";
import { OrchestratorError, runAssistant } from "../services/assistant/orchestrator";
import type { OrchestratorErrorCode } from "../services/assistant/orchestrator";
import { ASSISTANT_TOOL_NAMES, assistantTools, createAssistantTools } from "../services/assistant/tools";
import type { ToolName, ToolResult } from "../services/assistant/tools";
import type { TaxEvidence, TaxRetrievalResult } from "../services/tax-retrieval";
import { deleteTestUser, makeTestUser } from "./helpers";

type AssistantTools = ReturnType<typeof createAssistantTools>;
const USER = "8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f";

// --- fakes and helpers ---------------------------------------------------------------

function scriptedModel(...responses: unknown[]): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(structuredClone(request));
      if (responses.length === 0) throw new Error("the script ran out");
      return responses.shift() as ModelResponse;
    },
  };
}
const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: parseToolArguments(JSON.stringify(args)) });
const toolCalls = (...calls: unknown[]) => ({ kind: "tool_calls", calls });
const text = (t: string) => ({ kind: "text", text: t });
const ask = (content = "Help me.") => [{ role: "user" as const, content }];

function stubTools(results: Partial<Record<ToolName, ToolResult<unknown>>> = {}): { tools: AssistantTools; calls: Array<{ tool: ToolName; args: unknown }> } {
  const calls: Array<{ tool: ToolName; args: unknown }> = [];
  const tools = Object.fromEntries(
    ASSISTANT_TOOL_NAMES.map((name) => [name, async (_userId: unknown, args: unknown) => { calls.push({ tool: name, args }); return results[name] ?? { status: "ok", tool: name, result: { stub: name } }; }]),
  ) as unknown as AssistantTools;
  return { tools, calls };
}

function refused(result: ToolResult<unknown>) {
  assert.equal(result.status, "refused", JSON.stringify(result).slice(0, 300));
  if (result.status !== "refused") throw new Error("unreachable");
  return result;
}
function ok<T>(result: ToolResult<T>): T {
  assert.equal(result.status, "ok", JSON.stringify(result).slice(0, 300));
  if (result.status !== "ok") throw new Error("unreachable");
  return result.result;
}

async function withUser(work: (userId: string) => Promise<void>) {
  const user = await makeTestUser("assist-boundary");
  try {
    await work(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}
const row = (userId: string, over: Partial<typeof transactions.$inferInsert> = {}): typeof transactions.$inferInsert => ({
  userId, type: "expense", amountPaise: 100, category: "Food", description: null, source: "manual", occurredOn: "2026-03-01", ...over,
});
const codePoints = (value: string) => [...value].length;

// --- 2. transaction text: off by default, capped when asked for ------------------------

test("descriptions are not returned by default: the row carries the deterministic fields only, and says so", async () => {
  await withUser(async (a) => {
    await db.insert(transactions).values([
      row(a, { type: "income", amountPaise: 90_000, category: "Salary", description: "ACME PVT LTD payroll ref 77-DESC-MARKER", occurredOn: "2026-03-05" }),
      row(a, { amountPaise: 2_500, category: "Rent", description: "Flat 4B, Green Park - DESC-MARKER-2", occurredOn: "2026-03-02" }),
    ]);
    const result = ok(await assistantTools.query_transactions(a, {})) as { descriptionsIncluded: boolean; totals: unknown; transactions: Array<Record<string, unknown>> };

    assert.equal(result.descriptionsIncluded, false);
    assert.deepEqual(result.transactions.map((t) => Object.keys(t).sort()), [["amountPaise", "category", "occurredOn", "source", "type"], ["amountPaise", "category", "occurredOn", "source", "type"]]);
    assert.equal(JSON.stringify(result).includes("DESC-MARKER"), false, "no description text anywhere in the result");
    assert.deepEqual(result.totals, { incomePaise: 90_000, expensePaise: 2_500 }, "the financial fields are untouched");
    assert.deepEqual(result.transactions.map((t) => [t.occurredOn, t.type, t.amountPaise, t.category]), [["2026-03-05", "income", 90_000, "Salary"], ["2026-03-02", "expense", 2_500, "Rent"]]);
  });
});

test("asking for descriptions is explicit, narrowly validated, and still bounded per field", async () => {
  await withUser(async (a) => {
    const long = `START-${"d".repeat(1_000)}`;
    await db.insert(transactions).values([row(a, { description: long, occurredOn: "2026-03-05" }), row(a, { description: "short note", occurredOn: "2026-03-02" })]);
    const result = ok(await assistantTools.query_transactions(a, { includeDescription: true })) as { descriptionsIncluded: boolean; fieldsTruncated: boolean; transactions: Array<{ description: string }> };

    assert.equal(result.descriptionsIncluded, true);
    assert.equal(result.fieldsTruncated, true);
    const [capped, short] = result.transactions.map((t) => t.description);
    assert.ok(codePoints(capped) <= MAX_LEDGER_DESCRIPTION_CHARS, `${codePoints(capped)} characters`);
    assert.ok(capped.startsWith("START-") && capped.endsWith("…"), "cut with a visible ellipsis, not silently");
    assert.equal(short, "short note", "a short description is returned exactly");

    const onlyShort = ok(await assistantTools.query_transactions(a, { includeDescription: true, from: "2026-03-01", to: "2026-03-03" })) as { fieldsTruncated: boolean };
    assert.equal(onlyShort.fieldsTruncated, false);
  });
});

test("oversized free text is capped in every ledger tool, whether or not descriptions are asked for", async () => {
  await withUser(async (a) => {
    await db.insert(transactions).values(row(a, { category: `CAT-${"c".repeat(400)}`, source: `SRC-${"s".repeat(400)}`, description: "x" }));
    const query = ok(await assistantTools.query_transactions(a, {})) as { fieldsTruncated: boolean; transactions: Array<{ category: string; source: string }> };
    assert.ok(codePoints(query.transactions[0].category) <= MAX_CATEGORY_CHARS);
    assert.ok(codePoints(query.transactions[0].source) <= MAX_LEDGER_SOURCE_CHARS);
    assert.equal(query.fieldsTruncated, true);

    const summary = ok(await assistantTools.get_financial_summary(a, {})) as { categories: Array<{ category: string }> };
    assert.ok(summary.categories.every((c) => codePoints(c.category) <= MAX_CATEGORY_CHARS), "category names in a summary are capped too");
  });
});

// --- 3. the summary is always bounded --------------------------------------------------

test("a summary with no period is bounded: the 12 calendar months ending at the latest transaction, the same every time", async () => {
  await withUser(async (a) => {
    await db.insert(transactions).values([
      row(a, { type: "income", amountPaise: 1_000, occurredOn: "2023-06-15" }),
      row(a, { type: "income", amountPaise: 2_000, occurredOn: "2024-06-15" }),
      row(a, { type: "income", amountPaise: 300, occurredOn: "2025-05-15" }),
      row(a, { type: "income", amountPaise: 40, occurredOn: "2026-03-20" }),
    ]);
    const first = ok(await assistantTools.get_financial_summary(a, {})) as { period: unknown; periodIsDefault: boolean; transactionCount: number; incomePaise: number; months: unknown[] };
    assert.deepEqual(first.period, { from: "2025-04-01", to: "2026-03-20" });
    assert.equal(first.periodIsDefault, true);
    assert.equal(first.transactionCount, 2, "the 2023 and 2024 rows are outside the default window");
    assert.equal(first.incomePaise, 340);
    assert.ok(first.months.length <= 12);
    assert.deepEqual(ok(await assistantTools.get_financial_summary(a, {})), first, "deterministic: no clock is involved");

    // Asking for the older data is possible, but only explicitly and within the maximum range.
    const older = ok(await assistantTools.get_financial_summary(a, { from: "2024-01-01", to: "2024-12-31" })) as { periodIsDefault: boolean; incomePaise: number };
    assert.equal(older.periodIsDefault, false);
    assert.equal(older.incomePaise, 2_000);
  });
  await withUser(async (a) => {
    const empty = ok(await assistantTools.get_financial_summary(a, {})) as { period: unknown; transactionCount: number; periodIsDefault: boolean };
    assert.deepEqual(empty.period, { from: null, to: null });
    assert.equal(empty.transactionCount, 0);
    assert.equal(empty.periodIsDefault, true);
  });
});

test("an explicit summary period must be a whole from-and-to within the maximum range", async () => {
  assert.equal(MAX_SUMMARY_RANGE_DAYS, 366);
  const summary = (args: unknown) => assistantTools.get_financial_summary(USER, args);
  for (const bad of [
    { from: "2026-01-01", to: "2027-01-02" }, // 367 days
    { from: "2024-01-01", to: "2025-01-01" }, // 367 days: 2024 is a leap year
    { from: "2020-01-01", to: "2026-01-01" },
    { from: "2026-03-01" }, // half a period
    { to: "2026-03-31" },
  ]) {
    const result = refused(await summary(bad));
    assert.equal(result.reason, "invalid_arguments", JSON.stringify(bad));
    assert.match(result.message, /from and to|366/i);
  }
  // The largest allowed ranges pass validation (a real user is needed only to run them, so use one that owns nothing).
  await withUser(async (a) => {
    for (const good of [{ from: "2026-01-01", to: "2027-01-01" }, { from: "2024-01-01", to: "2024-12-31" }, { from: "2026-03-01", to: "2026-03-01" }]) {
      ok(await assistantTools.get_financial_summary(a, good));
    }
  });
});

// --- 4. a tax-law question cannot trivially carry a person's details ---------------------

const OK_RETRIEVAL: TaxRetrievalResult = { status: "ok", assessmentYear: "2026-27", corpusVersion: "v1", evidence: [], unmatchedSectionRefs: [], sectionResolutions: [] };

test("a search_tax_law question with obvious personal details is refused, without echoing them", async () => {
  const retrieved: unknown[] = [];
  const tools = createAssistantTools({ retrieve: async (input) => { retrieved.push(input); return OK_RETRIEVAL; } });
  const stuffed: Array<[string, string]> = [
    ["an email address", "My email is asha.rao@example.com, is the 87A rebate available to me?"],
    ["a long account number", "For account 123456789012 what is the 87A rebate?"],
    ["a phone number", "Call 9876543210 about the section 80C limit"],
    ["a PAN-shaped code", "PAN ABCDE1234F: does 87A apply?"],
    ["a pile of figures", "My salary is 1500000 rent 240000 80C 150000 80D 25000 HRA 120000 bonus 200000 PPF 50000 NPS 50000 what is my tax?"],
    ["a long story", `${"I earn a salary and pay rent. ".repeat(12)}What is the 87A rebate?`],
  ];
  assert.equal(MAX_QUESTION_CHARS, 300);
  assert.equal(MAX_QUESTION_FIGURES, 8);
  for (const [why, question] of stuffed) {
    const result = refused(await tools.search_tax_law(USER, { question, assessmentYear: "2026-27" }));
    assert.equal(result.reason, "invalid_arguments", why);
    assert.doesNotMatch(result.message, /asha\.rao|123456789012|9876543210|ABCDE1234F|1500000|earn a salary/, `${why}: the refusal must not echo the question`);
  }
  assert.equal(retrieved.length, 0, "retrieval was never reached");
});

test("ordinary tax-law questions, with the few figures a law question needs, are still accepted", async () => {
  const tools = createAssistantTools({ retrieve: async () => OK_RETRIEVAL });
  for (const question of [
    "What is the Section 87A rebate limit for AY 2026-27?",
    "What percentage is charged on the portion of income from ₹8 lakh to ₹12 lakh in the new system?",
    "Is income of exactly ₹1 crore in the 10% or the 15% surcharge bracket?",
    "Does the ₹60,000 new-regime rebate also apply to tax on capital gains?",
    "What is the combined deduction limit of ₹1,50,000 under Section 80C, and is 80CCD(1B) separate?",
    "Is the standard deduction the same in the old and new regimes?",
  ]) {
    ok(await tools.search_tax_law(USER, { question, assessmentYear: "2026-27" }));
  }
});

test("through the orchestrator, a stuffed question is refused before any tool runs, as a typed error that does not echo it", async () => {
  const { tools, calls } = stubTools();
  const question = "PAN ABCDE1234F and account 123456789012: does 87A apply?";
  const model = scriptedModel(toolCalls(call("c", "search_tax_law", { question, assessmentYear: "2026-27" })));
  try {
    await runAssistant({ userId: USER, messages: ask() }, { model, tools });
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof OrchestratorError);
    assert.equal(error.code, "invalid_tool_arguments");
    assert.doesNotMatch(error.message, /ABCDE1234F|123456789012/);
  }
  assert.equal(calls.length, 0);
});

// --- 1 and 5. caller-facing activity and errors carry no ledger data; the model still does ----

const LEDGER = { status: "ok", tool: "query_transactions", result: { transactions: [{ occurredOn: "2026-03-01", amountPaise: 123_456, category: "LEDGER-MARKER-CATEGORY", description: "LEDGER-MARKER-DESCRIPTION" }] } } as const;

test("what the caller gets back is metadata only: tool, call id, round, outcome, reason and evidence ids", async () => {
  await withUser(async (a) => {
    await db.insert(transactions).values(row(a, { amountPaise: 424_242, category: "Groceries", description: "A-desc-marker-9", occurredOn: "2026-03-01" }));
    const model = scriptedModel(toolCalls(call("c1", "query_transactions", { includeDescription: true })), text("You have one transaction."));
    const result = await runAssistant({ userId: a, messages: ask("What did I spend?") }, { model, tools: assistantTools });

    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(Object.keys(result.toolCalls[0]).sort(), ["callId", "evidenceIds", "outcome", "reason", "round", "tool"]);
    assert.deepEqual(result.toolCalls[0], { round: 1, callId: "c1", tool: "query_transactions", outcome: "ok", reason: null, evidenceIds: [] });
    const returned = JSON.stringify(result);
    for (const leaked of ["A-desc-marker-9", "424242", "Groceries", "amountPaise", "description"]) assert.equal(returned.includes(leaked), false, `the caller's result contains ${leaked}`);

    // But the MODEL was given the whole tool result, because it needs it to answer.
    const toolMessage = model.requests[1].messages.find((m) => m.role === "tool");
    assert.match(toolMessage?.content ?? "", /A-desc-marker-9/);
    assert.match(toolMessage?.content ?? "", /424242/);
  });
});

test("every orchestrator error carries the same metadata-only activity, and no ledger row, in its message, fields or printout", async () => {
  const rounds = (n: number) => Array.from({ length: n }, (_, i) => toolCalls(call(`r${i}`, "query_transactions", {})));
  const scenarios: Array<[OrchestratorErrorCode, () => { model: ModelAdapter; tools: AssistantTools }]> = [
    ["round_limit_exceeded", () => ({ model: scriptedModel(...rounds(4)), tools: stubTools({ query_transactions: LEDGER }).tools })],
    ["tool_call_limit_exceeded", () => ({ model: scriptedModel(toolCalls(...[1, 2, 3].map((i) => call(`a${i}`, "query_transactions", {}))), toolCalls(...[1, 2, 3].map((i) => call(`b${i}`, "query_transactions", {}))), toolCalls(...[1, 2, 3].map((i) => call(`c${i}`, "query_transactions", {})))), tools: stubTools({ query_transactions: LEDGER }).tools })],
    ["unknown_tool", () => ({ model: scriptedModel(rounds(1)[0], toolCalls(call("x", "run_sql", {}))), tools: stubTools({ query_transactions: LEDGER }).tools })],
    ["invalid_tool_arguments", () => ({ model: scriptedModel(rounds(1)[0], toolCalls(call("x", "query_transactions", { userId: "victim" }))), tools: stubTools({ query_transactions: LEDGER }).tools })],
    ["tool_result_too_large", () => ({ model: scriptedModel(rounds(1)[0]), tools: stubTools({ query_transactions: { status: "ok", tool: "query_transactions", result: { blob: `LEDGER-MARKER-${"x".repeat(60_000)}` } } }).tools })],
  ];
  for (const [code, build] of scenarios) {
    const { model, tools } = build();
    let caught: OrchestratorError | undefined;
    try {
      await runAssistant({ userId: USER, messages: ask() }, { model, tools });
    } catch (error) {
      assert.ok(error instanceof OrchestratorError, code);
      caught = error;
    }
    assert.ok(caught, `${code} should reject`);
    assert.equal(caught.code, code);
    for (const entry of caught.toolActivity) assert.deepEqual(Object.keys(entry).sort(), ["callId", "evidenceIds", "outcome", "reason", "round", "tool"], code);
    const everything = [caught.message, JSON.stringify(caught.toolActivity), JSON.stringify(caught), inspect(caught, { depth: 10 }), caught.stack ?? ""].join("\n");
    assert.equal(everything.includes("LEDGER-MARKER"), false, `${code}: ledger text reached the error`);
    assert.equal(everything.includes("123456"), false, `${code}: an amount reached the error`);
  }
});

test("tax evidence ids are kept in the caller's activity, per call, and in the result", async () => {
  const item = (n: number): TaxEvidence => ({
    evidenceId: `ev_${String(n).padStart(16, "0")}`, chunkId: `chunk-${n}`, sourceKey: "s", title: "t", publisher: "p", url: "https://x.gov.in/", authorityTier: "official_guidance",
    sectionRef: "87A", quote: `quote ${n}`, assessmentYear: "2026-27", effectiveFrom: null, retrievedAt: "2026-09-19T00:00:00.000Z", corpusVersion: "v1", verificationStatus: "primary_verified", score: 1,
  });
  const tools = createAssistantTools({ retrieve: async () => ({ ...OK_RETRIEVAL, evidence: [item(1), item(2)] }) });
  const model = scriptedModel(toolCalls(call("s1", "search_tax_law", { question: "What is the 87A rebate?", assessmentYear: "2026-27" })), text("See [ev_0000000000000001]."));
  const result = await runAssistant({ userId: USER, messages: ask() }, { model, tools });

  assert.deepEqual(result.toolCalls, [{ round: 1, callId: "s1", tool: "search_tax_law", outcome: "ok", reason: null, evidenceIds: ["ev_0000000000000001", "ev_0000000000000002"] }]);
  assert.deepEqual(result.evidenceIds, ["ev_0000000000000001", "ev_0000000000000002"]);
  assert.match(model.requests[1].messages.find((m) => m.role === "tool")?.content ?? "", /quote 1/, "the model still receives the quotes");
});
