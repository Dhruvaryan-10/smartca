// The egress disclosure (lib/assistant/egress-disclosure.ts): what an external run sends and withholds, derived from the egress inventory.
// PURE: no database, no DATABASE_URL. The central invariant: the disclosure and the egress filter agree field by field, so what a person
// is told is exactly what the filter lets through.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DISCLOSURE_FORMAT_VERSION, describeEgress, fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { filterToolResult } from "../lib/assistant/egress-filter";
import type { EgressClasses } from "../lib/assistant/egress-filter";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import { ASSISTANT_EGRESS_INVENTORY, ASSISTANT_TOOL_NAMES, LEDGER_DATA_NOTICE } from "../lib/assistant/tool-contract";
import type { EgressFieldClass, ToolName } from "../lib/assistant/tool-contract";
import { SYNTHETIC_CALC_ARGS, SYNTHETIC_SEARCH_ARGS, SYNTHETIC_SIMULATE_ARGS, SYNTHETIC_TAX_BODY, SYNTHETIC_USER_ID, createSyntheticTools } from "../services/assistant/synthetic-tools";

const FRONTEND = path.resolve(__dirname, "..");
const ALL: EgressClasses = { user_free_text: true, user_financial_data: true, tax_corpus_text: true, system_value: true };
const classesOf = (mask: number): EgressClasses => Object.fromEntries(EGRESS_FIELD_CLASSES.map((c, i) => [c, Boolean(mask & (1 << i))])) as EgressClasses;

const isAtOrUnder = (p: string, entry: string) => p === entry || p.startsWith(`${entry}.`) || p.startsWith(`${entry}[]`);
/** Every leaf path of a value (arrays as `[]`). */
function leaves(value: unknown, at = "", out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => leaves(v, `${at}[]`, out));
  else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) leaves(v, at === "" ? k : `${at}.${k}`, out);
  else out.push(at);
  return out;
}
const nearest = (p: string, entries: readonly string[]) => entries.filter((e) => isAtOrUnder(p, e)).sort((a, b) => b.length - a.length)[0];

async function samples(): Promise<Array<{ tool: ToolName; result: unknown }>> {
  const t = createSyntheticTools();
  const ledger = {
    status: "ok", tool: "query_transactions",
    result: {
      filter: { from: null, to: null, category: "Food", type: null }, descriptionsIncluded: true, matched: 1, returned: 1, truncated: false, fieldsTruncated: false,
      totals: { incomePaise: 0, expensePaise: 500 },
      transactions: [{ occurredOn: "2026-03-05", type: "expense", amountPaise: 500, category: "Food", description: "Lunch", source: "UPI" }],
      dataNotice: LEDGER_DATA_NOTICE,
    },
  };
  return [
    { tool: "search_tax_law", result: await t.search_tax_law(SYNTHETIC_USER_ID, SYNTHETIC_SEARCH_ARGS) },
    { tool: "get_financial_summary", result: await t.get_financial_summary(SYNTHETIC_USER_ID, {}) },
    { tool: "calculate_tax", result: await t.calculate_tax(SYNTHETIC_USER_ID, SYNTHETIC_CALC_ARGS) },
    { tool: "compare_tax_regimes", result: await t.compare_tax_regimes(SYNTHETIC_USER_ID, SYNTHETIC_TAX_BODY) },
    { tool: "simulate_tax", result: await t.simulate_tax(SYNTHETIC_USER_ID, SYNTHETIC_SIMULATE_ARGS) },
    { tool: "query_transactions", result: ledger },
    ...ASSISTANT_TOOL_NAMES.map((tool) => ({ tool, result: { status: "refused", tool, reason: "invalid_arguments", message: 'the field "x" is not accepted.' } })),
  ];
}

test("sent and withheld together are the whole inventory for each tool, split exactly by the visible classes", () => {
  for (let mask = 0; mask < 1 << EGRESS_FIELD_CLASSES.length; mask++) {
    const classes = classesOf(mask);
    const d = describeEgress(ASSISTANT_TOOL_NAMES, classes);
    assert.deepEqual(d.visibleClasses, EGRESS_FIELD_CLASSES.filter((c) => classes[c]));
    for (const { tool, sent, withheld } of d.tools) {
      const all = [...sent, ...withheld].map((f) => `${f.path}=${f.class}`).sort();
      assert.deepEqual(all, Object.entries(ASSISTANT_EGRESS_INVENTORY[tool]).map(([p, c]) => `${p}=${c}`).sort(), tool);
      assert.ok(sent.every((f) => classes[f.class]) && withheld.every((f) => !classes[f.class]), tool);
    }
  }
});

test("the disclosure and the egress filter agree: every field the filter lets through is disclosed as sent, none as withheld", async () => {
  for (let mask = 0; mask < 1 << EGRESS_FIELD_CLASSES.length; mask++) {
    const classes = classesOf(mask);
    const d = describeEgress(ASSISTANT_TOOL_NAMES, classes);
    for (const { tool, result } of await samples()) {
      const entry = d.tools.find((t) => t.tool === tool);
      assert.ok(entry);
      const inventoryPaths = Object.keys(ASSISTANT_EGRESS_INVENTORY[tool]);
      const sentPaths = new Set(entry.sent.map((f) => f.path));
      for (const leaf of leaves(filterToolResult(tool, result, classes))) {
        const covering = nearest(leaf, inventoryPaths);
        assert.ok(covering !== undefined && sentPaths.has(covering), `${tool}: ${leaf} crossed but is not disclosed as sent (mask ${mask})`);
      }
    }
  }
});

test("the conversation is always disclosed as sent: the filter does not touch it", () => {
  const d = describeEgress(["calculate_tax"], { ...ALL, user_free_text: false });
  assert.deepEqual({ ...d.conversation }, { userMessages: "sent", assistantAnswers: "sent", modelToolArguments: "sent", class: "user_free_text" });
});

test("the transaction fields a person would care about are named explicitly, by class", () => {
  const full = describeEgress(["query_transactions", "get_financial_summary"], ALL);
  const classOf = (tool: ToolName, p: string) => full.tools.find((t) => t.tool === tool)?.sent.find((f) => f.path === p)?.class;
  const expected: Array<[ToolName, string, EgressFieldClass]> = [
    ["query_transactions", "result.transactions[].description", "user_free_text"],
    ["query_transactions", "result.transactions[].source", "user_free_text"],
    ["query_transactions", "result.transactions[].category", "user_free_text"],
    ["query_transactions", "result.transactions[].amountPaise", "user_financial_data"],
    ["query_transactions", "result.filter.category", "user_free_text"],
    ["query_transactions", "message", "user_free_text"],
    ["get_financial_summary", "result.categories[].category", "user_free_text"],
    ["get_financial_summary", "result.incomePaise", "user_financial_data"],
  ];
  for (const [tool, p, c] of expected) assert.equal(classOf(tool, p), c, `${tool} ${p}`);
  const noFree = describeEgress(["query_transactions"], { ...ALL, user_free_text: false }).tools[0];
  assert.deepEqual(noFree.withheld.map((f) => f.path), ["message", "result.filter.category", "result.transactions[].category", "result.transactions[].description", "result.transactions[].source"]);
});

test("the inventory fingerprint is stable, and changes when any field or class changes", () => {
  assert.equal(fingerprintInventory(), fingerprintInventory(structuredClone(ASSISTANT_EGRESS_INVENTORY)));
  assert.match(fingerprintInventory(), /^inv1-[0-9a-f]{8}$/);
  const withExtra = structuredClone(ASSISTANT_EGRESS_INVENTORY) as Record<string, Record<string, string>>;
  withExtra.get_financial_summary["result.latestNote"] = "user_free_text";
  assert.notEqual(fingerprintInventory(withExtra), fingerprintInventory());
  const reclassed = structuredClone(ASSISTANT_EGRESS_INVENTORY) as Record<string, Record<string, string>>;
  reclassed.query_transactions["result.transactions[].source"] = "system_value";
  assert.notEqual(fingerprintInventory(reclassed), fingerprintInventory());
  assert.equal(describeEgress(["calculate_tax"], ALL).inventoryVersion, fingerprintInventory());
  assert.equal(describeEgress(["calculate_tax"], ALL).format, DISCLOSURE_FORMAT_VERSION);
});

test("a malformed request is a RangeError, and the result is frozen", () => {
  for (const tools of [[], ["delete_ledger"], ["calculate_tax", "calculate_tax"]]) assert.throws(() => describeEgress(tools as ToolName[], ALL), RangeError);
  assert.throws(() => describeEgress(["calculate_tax"], { user_free_text: true } as never), RangeError);
  const d = describeEgress(["search_tax_law", "calculate_tax"], ALL);
  assert.deepEqual(d.tools.map((t) => t.tool), ["search_tax_law", "calculate_tax"]);
  assert.ok(Object.isFrozen(d) && Object.isFrozen(d.tools) && Object.isFrozen(d.tools[0].sent) && Object.isFrozen(d.tools[0].sent[0]));
});

test("egress-disclosure.ts imports only pure lib/assistant modules", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "lib/assistant/egress-disclosure.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const imports = [...code.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)].sort(), ["./egress-filter", "./tool-contract"]);
  assert.doesNotMatch(code, /require\(|import\(|process\.env|fetch\(|Date\.now\(/);
});
