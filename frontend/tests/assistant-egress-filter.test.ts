// Field-level egress filtering (lib/assistant/egress-filter.ts) and where it is enforced (the orchestrator's `visibleClasses`). PURE:
// no database, no DATABASE_URL. Realistic results come from the synthetic tools (whose shapes a DB contract test pins to the real
// tools'), plus a hand-built query_transactions result and refusals; the DB-backed check of the REAL tools' results is in
// assistant-egress-inventory.db.test.ts.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EgressFilterError, filterByInventory, filterToolResult, readEgressClasses } from "../lib/assistant/egress-filter";
import type { EgressClasses } from "../lib/assistant/egress-filter";
import { SYNTHETIC_PROFILE } from "../lib/assistant/profiles";
import { ASSISTANT_TOOL_NAMES, LEDGER_DATA_NOTICE } from "../lib/assistant/tool-contract";
import type { EgressFieldClass, ToolName } from "../lib/assistant/tool-contract";
import { runAssistant } from "../services/assistant/orchestrator";
import {
  SYNTHETIC_CALC_ARGS,
  SYNTHETIC_SEARCH_ARGS,
  SYNTHETIC_SIMULATE_ARGS,
  SYNTHETIC_TAX_BODY,
  SYNTHETIC_TOOL_NAMES,
  SYNTHETIC_USER_ID,
  createSyntheticTools,
} from "../services/assistant/synthetic-tools";
import { USER, ask, call, rejectsWith, scriptedModel, stubTools, text, toolCalls } from "./helpers-orchestrator";

const FRONTEND = path.resolve(__dirname, "..");
const FREE = "qzfreeq";
const ALL: EgressClasses = { user_free_text: true, user_financial_data: true, tax_corpus_text: true, system_value: true };
const NONE: EgressClasses = { user_free_text: false, user_financial_data: false, tax_corpus_text: false, system_value: false };
const only = (...allowed: EgressFieldClass[]): EgressClasses => ({ ...NONE, ...Object.fromEntries(allowed.map((c) => [c, true])) });
const without = (...forbidden: EgressFieldClass[]): EgressClasses => ({ ...ALL, ...Object.fromEntries(forbidden.map((c) => [c, false])) });

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

/** A query_transactions result in the real tool's shape, with free text marked. */
const ledgerResult = () => ({
  status: "ok",
  tool: "query_transactions",
  result: {
    filter: { from: null, to: null, category: `Food ${FREE}`, type: null },
    descriptionsIncluded: true,
    matched: 2,
    returned: 2,
    truncated: false,
    fieldsTruncated: false,
    totals: { incomePaise: 0, expensePaise: 75_000 },
    transactions: [
      { occurredOn: "2026-03-05", type: "expense", amountPaise: 50_000, category: `Food ${FREE}`, description: `Lunch ${FREE}`, source: `UPI ${FREE}` },
      { occurredOn: "2026-03-01", type: "expense", amountPaise: 25_000, category: `Food ${FREE}`, description: null, source: null },
    ],
    dataNotice: LEDGER_DATA_NOTICE,
  },
});
const refusal = (tool: ToolName) => ({ status: "refused", tool, reason: "invalid_arguments", message: `search_tax_law does not accept the field "${FREE}".` });

/** Every tool's realistic results: the synthetic tools' own outputs, the ledger result, and a refusal each. */
async function samples(): Promise<Array<{ tool: ToolName; result: Record<string, unknown> }>> {
  const tools = createSyntheticTools();
  const out: Array<{ tool: ToolName; result: Record<string, unknown> }> = [
    { tool: "search_tax_law", result: (await tools.search_tax_law(SYNTHETIC_USER_ID, SYNTHETIC_SEARCH_ARGS)) as never },
    { tool: "search_tax_law", result: (await tools.search_tax_law(SYNTHETIC_USER_ID, { ...SYNTHETIC_SEARCH_ARGS, assessmentYear: "2024-25" })) as never },
    { tool: "get_financial_summary", result: (await tools.get_financial_summary(SYNTHETIC_USER_ID, {})) as never },
    { tool: "calculate_tax", result: (await tools.calculate_tax(SYNTHETIC_USER_ID, SYNTHETIC_CALC_ARGS)) as never },
    { tool: "compare_tax_regimes", result: (await tools.compare_tax_regimes(SYNTHETIC_USER_ID, SYNTHETIC_TAX_BODY)) as never },
    { tool: "simulate_tax", result: (await tools.simulate_tax(SYNTHETIC_USER_ID, SYNTHETIC_SIMULATE_ARGS)) as never },
    { tool: "query_transactions", result: ledgerResult() },
  ];
  for (const tool of ASSISTANT_TOOL_NAMES) out.push({ tool, result: refusal(tool) });
  assert.ok(out.slice(0, 6).every((s) => s.result.status === "ok" || s.tool === "search_tax_law"), "the fixtures really succeeded");
  return out;
}

// --- the semantics ------------------------------------------------------------------------------------------------------------

test("all four classes reproduce every result exactly, and the raw result is never mutated", async () => {
  for (const { tool, result } of await samples()) {
    const before = structuredClone(result);
    deepFreeze(result);
    const shown = filterToolResult(tool, result, ALL);
    assert.deepEqual(shown, before, tool);
    assert.equal(JSON.stringify(shown), JSON.stringify(before), `${tool}: byte for byte`);
    assert.notEqual(shown, result, "a copy, never the raw object");
    for (const classes of [NONE, only("system_value"), without("user_free_text"), without("tax_corpus_text")]) filterToolResult(tool, result, classes);
    assert.deepEqual(result, before, `${tool}: untouched`);
  }
});

test("no classes shown leaves an empty envelope for every result", async () => {
  for (const { tool, result } of await samples()) assert.deepEqual(filterToolResult(tool, result, NONE), {}, tool);
});

test("forbidding user_free_text removes every free-text field, and keeps the figures, dates and system values", () => {
  const shown = filterToolResult("query_transactions", ledgerResult(), without("user_free_text"));
  assert.equal(JSON.stringify(shown).includes(FREE), false, "no free text survives anywhere");
  assert.deepEqual(shown, {
    status: "ok",
    tool: "query_transactions",
    result: {
      filter: { from: null, to: null, type: null },
      descriptionsIncluded: true,
      matched: 2,
      returned: 2,
      truncated: false,
      fieldsTruncated: false,
      totals: { incomePaise: 0, expensePaise: 75_000 },
      transactions: [
        { occurredOn: "2026-03-05", type: "expense", amountPaise: 50_000 },
        { occurredOn: "2026-03-01", type: "expense", amountPaise: 25_000 },
      ],
      dataNotice: LEDGER_DATA_NOTICE,
    },
  });
  for (const tool of ASSISTANT_TOOL_NAMES) assert.deepEqual(filterToolResult(tool, refusal(tool), without("user_free_text")), { status: "refused", tool, reason: "invalid_arguments" }, tool);
});

test("financial data stays available when only free text is forbidden, and goes when it is forbidden", async () => {
  const tools = createSyntheticTools();
  const summary = (await tools.get_financial_summary(SYNTHETIC_USER_ID, {})) as never as { result: Record<string, unknown> };
  const noFree = filterToolResult("get_financial_summary", summary, without("user_free_text")) as { result: Record<string, unknown> };
  for (const field of ["incomePaise", "expensePaise", "savingsPaise", "period", "months", "transactionCount"]) assert.deepEqual(noFree.result[field], summary.result[field], field);
  const noFinancial = filterToolResult("get_financial_summary", summary, without("user_financial_data")) as { result: Record<string, unknown> };
  for (const field of ["incomePaise", "expensePaise", "savingsPaise", "period", "months", "range", "transactionCount"]) assert.equal(field in noFinancial.result, false, field);
  assert.equal(noFinancial.result.periodIsDefault, true, "a system value stays");

  const calc = await tools.calculate_tax(SYNTHETIC_USER_ID, SYNTHETIC_CALC_ARGS);
  assert.deepEqual(filterToolResult("calculate_tax", calc, without("user_financial_data")), { status: "ok", tool: "calculate_tax", result: { regime: "old", assessmentYear: "2026-27" } });
});

test("tax-corpus text can be removed on its own: the quote goes, the evidence id and the model's own section references stay", async () => {
  const found = (await createSyntheticTools().search_tax_law(SYNTHETIC_USER_ID, SYNTHETIC_SEARCH_ARGS)) as never as { result: { evidence: Array<Record<string, unknown>> } };
  const shown = filterToolResult("search_tax_law", found, without("tax_corpus_text")) as { result: { evidence: Array<Record<string, unknown>>; corpusVersion?: unknown } };
  assert.equal("corpusVersion" in shown.result, false);
  for (const item of shown.result.evidence) {
    for (const field of ["title", "quote", "publisher", "url", "sourceKey", "sectionRef", "corpusVersion"]) assert.equal(field in item, false, field);
    assert.equal(item.evidenceId, found.result.evidence[0].evidenceId, "a system value stays");
  }
  const refused = { status: "refused", tool: "search_tax_law", reason: "year_mismatch", message: "m", detail: { assessmentYear: "2026-27", corpusVersion: "v1", sectionRefs: [`87A ${FREE}`] } };
  assert.deepEqual(filterToolResult("search_tax_law", refused, without("tax_corpus_text")), { ...refused, detail: { assessmentYear: "2026-27", sectionRefs: [`87A ${FREE}`] } });
});

test("system values can be removed on their own", () => {
  const shown = filterToolResult("query_transactions", ledgerResult(), without("system_value")) as Record<string, unknown> & { result: Record<string, unknown> };
  for (const field of ["status", "tool"]) assert.equal(field in shown, false, field);
  for (const field of ["matched", "returned", "truncated", "descriptionsIncluded", "dataNotice"]) assert.equal(field in shown.result, false, field);
  assert.deepEqual(shown.result.totals, { incomePaise: 0, expensePaise: 75_000 });
});

test("nested arrays are filtered per element; a container that filtering empties is removed, one that was empty is kept", () => {
  const shown = filterToolResult("query_transactions", ledgerResult(), only("system_value")) as { result: Record<string, unknown> };
  assert.equal("transactions" in shown.result, false, "rows emptied by filtering are removed, so their number is not revealed");
  assert.equal("totals" in shown.result, false);
  assert.deepEqual(shown.result.filter, { from: null, to: null, type: null }, "the filter keeps its system values, not its free-text category");
  const noFilterText = filterToolResult("query_transactions", ledgerResult(), only("user_financial_data")) as { result: Record<string, unknown> };
  assert.equal("filter" in noFilterText.result, false, "a filter with nothing left is removed");
  const empty = { ...ledgerResult(), result: { ...ledgerResult().result, matched: 0, returned: 0, transactions: [] } };
  assert.deepEqual((filterToolResult("query_transactions", empty, ALL) as { result: { transactions: unknown[] } }).result.transactions, [], "an empty list is reproduced");
  assert.deepEqual((filterToolResult("query_transactions", empty, only("user_financial_data")) as { result: { transactions: unknown[] } }).result.transactions, [], "kept: it could hold a shown class");
  assert.equal("transactions" in (filterToolResult("query_transactions", empty, only("system_value")) as { result: Record<string, unknown> }).result, false, "removed: nothing it could hold is shown");
});

test("a field classed on its own is decided by its own class, never copied inside an allowed parent", () => {
  // An inventory in which free text sits inside a structure classed as financial data.
  const inventory = { status: "system_value", "result.result": "user_financial_data", "result.result.note": "user_free_text", "result.result.lines[].memo": "user_free_text" } as const;
  const raw = { status: "ok", result: { result: { totalPaise: 100, note: `secret ${FREE}`, lines: [{ amountPaise: 60, memo: `m ${FREE}` }, { amountPaise: 40, memo: null }] } } };
  const noFree = filterByInventory(raw, inventory, without("user_free_text"));
  assert.deepEqual(noFree, { status: "ok", result: { result: { totalPaise: 100, lines: [{ amountPaise: 60 }, { amountPaise: 40 }] } } });
  assert.equal(JSON.stringify(noFree).includes(FREE), false);
  const freeOnly = filterByInventory(raw, inventory, without("user_financial_data", "system_value"));
  assert.deepEqual(freeOnly, { result: { result: { note: `secret ${FREE}`, lines: [{ memo: `m ${FREE}` }, { memo: null }] } } });
  assert.deepEqual(filterByInventory(raw, inventory, ALL), raw);
});

test("an unclassified field fails closed: it is neither passed through nor silently dropped", () => {
  const cases: Array<[ToolName, unknown, string]> = [
    ["query_transactions", { ...ledgerResult(), extra: "x" }, "extra"],
    ["query_transactions", { ...ledgerResult(), result: { ...ledgerResult().result, latestNote: `n ${FREE}` } }, "result.latestNote"],
    ["query_transactions", { ...ledgerResult(), result: { ...ledgerResult().result, transactions: [{ ...ledgerResult().result.transactions[0], merchant: FREE }] } }, "result.transactions[].merchant"],
    ["calculate_tax", { status: "ok", tool: "calculate_tax", result: { regime: "old", surprise: 1 } }, "result.surprise"],
  ];
  for (const [tool, raw, where] of cases) {
    for (const classes of [ALL, NONE, without("user_free_text")]) {
      assert.throws(() => filterToolResult(tool, raw, classes), (e: unknown) => e instanceof EgressFilterError && e.path === where, `${where} under ${JSON.stringify(classes)}`);
    }
  }
  for (const raw of [null, "text", [1], 7]) assert.throws(() => filterToolResult("calculate_tax", raw, ALL), EgressFilterError);
});

test("the classes must be stated exactly: four booleans, nothing defaulted", () => {
  assert.deepEqual(readEgressClasses(ALL), ALL);
  assert.ok(Object.isFrozen(readEgressClasses(ALL)));
  const partial: Record<string, boolean> = { ...ALL };
  delete partial.system_value;
  for (const bad of [undefined, null, [], "all", partial, { ...ALL, extra: true }, { ...ALL, user_free_text: "yes" }]) {
    assert.throws(() => readEgressClasses(bad), RangeError);
    assert.throws(() => filterToolResult("calculate_tax", { status: "ok" }, bad as EgressClasses), RangeError);
  }
});

test("the synthetic profile's classes show every synthetic result exactly as before", async () => {
  const tools = createSyntheticTools();
  for (const { tool, result } of await samples()) {
    if (!SYNTHETIC_TOOL_NAMES.includes(tool) || result.status !== "ok") continue;
    assert.deepEqual(filterToolResult(tool, result, SYNTHETIC_PROFILE.classes), result, tool);
  }
  // And synthetic mode itself does not filter at all: its entry point passes no visibleClasses (the synthetic tests pin its behaviour).
  const source = fs.readFileSync(path.join(FRONTEND, "services/assistant/synthetic.ts"), "utf8");
  assert.doesNotMatch(source, /visibleClasses/);
  assert.ok(tools);
});

// --- where it is enforced: the orchestrator -----------------------------------------------------------------------------------

test("with visibleClasses, the MODEL is sent the filtered result, while onToolResult still receives the raw one", async () => {
  const model = scriptedModel(toolCalls(call("c1", "query_transactions", { includeDescription: true })), text("Done."));
  const { tools } = stubTools({ query_transactions: ledgerResult() as never });
  const records: unknown[] = [];
  await runAssistant({ userId: USER, messages: ask() }, { model, tools, visibleClasses: without("user_free_text"), onToolResult: (r) => records.push(r.result) });
  const sent = model.requests[1].messages.find((m) => m.role === "tool");
  assert.ok(sent && sent.role === "tool");
  assert.equal(sent.content.includes(FREE), false, "no free text was ever serialized for the model");
  assert.equal(sent.content, JSON.stringify(filterToolResult("query_transactions", ledgerResult(), without("user_free_text"))));
  assert.deepEqual(records, [ledgerResult()], "the server-side record is the raw result");
});

test("without visibleClasses nothing changes: the model is sent the raw result byte for byte", async () => {
  const model = scriptedModel(toolCalls(call("c1", "query_transactions", {})), text("Done."));
  const { tools } = stubTools({ query_transactions: ledgerResult() as never });
  await runAssistant({ userId: USER, messages: ask() }, { model, tools });
  const sent = model.requests[1].messages.find((m) => m.role === "tool");
  assert.equal(sent?.content, JSON.stringify(ledgerResult()));
});

test("an unclassified field stops the run before any of that result is sent, and the call stays on the record", async () => {
  const model = scriptedModel(toolCalls(call("c1", "query_transactions", {})), text("never"));
  const { tools } = stubTools(); // the stub result `{ stub: ... }` is not a classified shape
  const error = await rejectsWith("tool_result_unclassified", () => runAssistant({ userId: USER, messages: ask() }, { model, tools, visibleClasses: ALL }));
  assert.equal(model.requests.length, 1, "the result was never sent back to the model");
  assert.deepEqual(error.toolActivity.map((a) => a.callId), ["c1"]);
});

test("a malformed visibleClasses is a RangeError before the model is called", async () => {
  const model = scriptedModel(text("never"));
  await assert.rejects(runAssistant({ userId: USER, messages: ask() }, { model, tools: stubTools().tools, visibleClasses: { user_free_text: true } as never }), RangeError);
  assert.equal(model.requests.length, 0);
});

test("egress-filter.ts imports only the pure tool contract", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "lib/assistant/egress-filter.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)], ["./tool-contract"]);
  assert.doesNotMatch(code, /require\(|import\(|process\.env|fetch\(/);
});
