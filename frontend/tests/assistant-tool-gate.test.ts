// The tool gate (OrchestratorOptions.allowedTools, AskDeps.allowedTools): code can narrow a run to some of the six tools. With no
// gate, a run is exactly what it was: all six declared, all six callable. With one, the model is told about the allowed tools
// only, and a call to any other is refused before anything in its batch runs. A bad gate is the caller's bug, not the model's.
// Stub tools and the scripted model only: no database, no DATABASE_URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_TOOL_DEFINITIONS, runAssistant } from "../services/assistant/orchestrator";
import { askAssistant } from "../services/assistant/ask";
import type { ToolName } from "../lib/assistant/tool-contract";
import { USER, ask, call, rejectsWith, scriptedModel, stubTools, text, toolCalls } from "./helpers-orchestrator";

test("no gate: all six tools are declared, as before", async () => {
  const model = scriptedModel(text("Hi."));
  const { tools } = stubTools();
  await runAssistant({ userId: USER, messages: ask() }, { model, tools });
  assert.deepEqual(model.requests[0].tools, ASSISTANT_TOOL_DEFINITIONS);
});

test("a gate declares only the allowed tools, in the canonical order, whatever order it lists them in", async () => {
  const model = scriptedModel(text("Hi."));
  const { tools } = stubTools();
  await runAssistant({ userId: USER, messages: ask() }, { model, tools, allowedTools: ["simulate_tax", "search_tax_law"] });
  assert.deepEqual(model.requests[0].tools?.map((t) => t.name), ["search_tax_law", "simulate_tax"]);
  assert.deepEqual(model.requests[0].tools, ASSISTANT_TOOL_DEFINITIONS.filter((t) => t.name === "search_tax_law" || t.name === "simulate_tax"));
});

test("an allowed tool runs as usual", async () => {
  const model = scriptedModel(toolCalls(call("a", "get_financial_summary", {})), text("Done."));
  const { tools, calls } = stubTools();
  const result = await runAssistant({ userId: USER, messages: ask() }, { model, tools, allowedTools: ["get_financial_summary"] });
  assert.equal(result.text, "Done.");
  assert.deepEqual(calls, [{ tool: "get_financial_summary", userId: USER, args: {} }]);
});

test("a call to a real but gated tool is unknown_tool, and nothing in its batch runs, not even an allowed call before it", async () => {
  const model = scriptedModel(toolCalls(call("a", "get_financial_summary", {}), call("b", "query_transactions", { limit: 3 })));
  const { tools, calls } = stubTools();
  const error = await rejectsWith("unknown_tool", () =>
    runAssistant({ userId: USER, messages: ask() }, { model, tools, allowedTools: ["get_financial_summary"] }),
  );
  assert.match(error.message, /not available in this run: "query_transactions"/);
  assert.equal(calls.length, 0);
  assert.deepEqual(error.toolActivity, []);
});

test("a gate with all six behaves exactly like no gate", async () => {
  const model = scriptedModel(text("Hi."));
  const { tools } = stubTools();
  const all = ASSISTANT_TOOL_DEFINITIONS.map((t) => t.name as ToolName);
  await runAssistant({ userId: USER, messages: ask() }, { model, tools, allowedTools: all });
  assert.deepEqual(model.requests[0].tools, ASSISTANT_TOOL_DEFINITIONS);
});

test("a bad gate is a RangeError before the model is called: empty, not a list, an unknown name, a repeated name", async () => {
  const bad: unknown[] = [[], "search_tax_law", ["search_tax_law", "delete_everything"], ["calculate_tax", "calculate_tax"], [42]];
  for (const allowedTools of bad) {
    const model = scriptedModel(text("never"));
    const { tools, calls } = stubTools();
    await assert.rejects(
      runAssistant({ userId: USER, messages: ask() }, { model, tools, allowedTools: allowedTools as ToolName[] }),
      RangeError,
      JSON.stringify(allowedTools),
    );
    assert.equal(model.requests.length, 0);
    assert.equal(calls.length, 0);
  }
});

test("askAssistant passes the gate through, and leaves it off when not given", async () => {
  const gated = scriptedModel(text("Hi."));
  await askAssistant({ userId: USER, userMessages: ["Hello"] }, { model: gated, tools: stubTools().tools, allowedTools: ["search_tax_law"] });
  assert.deepEqual(gated.requests[0].tools?.map((t) => t.name), ["search_tax_law"]);

  const open = scriptedModel(text("Hi."));
  await askAssistant({ userId: USER, userMessages: ["Hello"] }, { model: open, tools: stubTools().tools });
  assert.deepEqual(open.requests[0].tools, ASSISTANT_TOOL_DEFINITIONS);
});
