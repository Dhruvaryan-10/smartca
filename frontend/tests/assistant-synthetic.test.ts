// Phase 6K: the synthetic model boundary (services/assistant/{synthetic,synthetic-model,synthetic-tools,config}.ts). PURE: no
// database, no network, no provider, no DATABASE_URL, no real key (the key below is a labelled placeholder).
//
// What is pinned, end to end through askSynthetic (the synthetic model + the synthetic tools + the configuration's limits):
//   - the transport is deterministic and fixture-only, and its honest answers pass the answer layer while its misbehaving ones are withheld
//   - a timeout, an oversized answer, an unapproved recipient and a missing configuration each FAIL CLOSED, typed
//   - the API key appears in no error, no log, no result and no metadata, even when an error is built to contain it
//   - synthetic mode never reaches real user data: only the synthetic user and synthetic messages are accepted, only the in-memory
//     tools are used, and the database client is never loaded
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { askSynthetic, SYNTHETIC_MESSAGE_PREFIX, SyntheticModeError } from "../services/assistant/synthetic";
import { SYNTHETIC_MODEL_ID, SYNTHETIC_RECIPIENT, SYNTHETIC_SCENARIOS, createSyntheticModel } from "../services/assistant/synthetic-model";
import type { SyntheticScenario } from "../services/assistant/synthetic-model";
import { SYNTHETIC_CALC_ARGS, SYNTHETIC_USER_ID, createSyntheticTools } from "../services/assistant/synthetic-tools";
import { AssistantConfigError, readAssistantConfig } from "../services/assistant/config";
import { ModelProviderError, assertModelResponse } from "../services/assistant/model";
import type { ModelCallInfo, ModelRequest } from "../services/assistant/model";
import { AssistantFailure } from "../lib/assistant/failure";
import { buildAnswer } from "../lib/assistant/answer";
import type { Answer } from "../lib/assistant/answer";
import { COMPARISON_NOTICE } from "../lib/assistant/tool-contract";
import { NotAuthenticatedError } from "../services/errors";

const FRONTEND = path.resolve(__dirname, "..");
const KEY = "test-key-NOT-A-REAL-SECRET-0001";
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_ENV: "synthetic",
  MODEL_ENDPOINT: "https://synthetic.invalid/v1",
  MODEL_API_KEY: KEY,
  MODEL_ID: "fixture-v1",
  MODEL_APPROVED_RECIPIENTS: SYNTHETIC_RECIPIENT,
  MODEL_TIMEOUT_MS: "250",
  MODEL_MAX_OUTPUT_CHARS: "2000",
};
const config = (over: Record<string, string> = {}) => readAssistantConfig({ ...ENV, ...over });
const INPUT = { userId: SYNTHETIC_USER_ID, userMessages: [`${SYNTHETIC_MESSAGE_PREFIX} Show me the synthetic example.`] };
const run = (scenario: SyntheticScenario, over: Record<string, string> = {}, onModelCall?: (i: ModelCallInfo) => void) =>
  askSynthetic(config(over), INPUT, { scenario, ...(onModelCall ? { onModelCall } : {}) });
const codes = (a: Answer) => [...new Set(a.violations.map((v) => v.code))].sort();
const dump = (value: unknown) => {
  const parts = [inspect(value, { depth: 10, showHidden: true })];
  try { parts.push(JSON.stringify(value)); } catch { /* not serialisable: inspect already covered it */ }
  if (value instanceof Error) parts.push(value.message, value.stack ?? "", JSON.stringify(Object.getOwnPropertyNames(value)));
  return parts.join("\n");
};

const REQUEST: ModelRequest = { messages: [{ role: "system", content: "s" }, { role: "user", content: `${SYNTHETIC_MESSAGE_PREFIX} hello` }] };
const HONEST: SyntheticScenario[] = ["plain", "calc", "law", "compare", "simulate", "summary", "disabled-tool"];

// --- the transport is deterministic and fixture-only ---------------------------------------------------------------------------

test("the synthetic transport is deterministic: the same request gets the same response, every time, valid and carrying its metadata", async () => {
  for (const scenario of HONEST) {
    const model = createSyntheticModel({ scenario });
    const first = await model.complete(REQUEST);
    assert.deepEqual(await model.complete(REQUEST), first, scenario);
    assert.deepEqual(await createSyntheticModel({ scenario }).complete(REQUEST), first, `${scenario}: a new instance agrees`);
    assert.deepEqual(assertModelResponse(first), first, `${scenario}: a valid response`);
    assert.equal(first.meta?.recipient, SYNTHETIC_RECIPIENT);
    assert.equal(first.meta?.model, SYNTHETIC_MODEL_ID);
    assert.ok(Number.isInteger(first.meta?.inputTokens) && Number.isInteger(first.meta?.outputTokens));
  }
  assert.equal((await createSyntheticModel({ scenario: "plain", modelId: "fixture-v1" }).complete(REQUEST)).meta?.model, "fixture-v1", "MODEL_ID is what it reports");
});

test("a scenario with a tool call asks for it once, with fixed arguments, and answers after the result: it never reads the person's words", async () => {
  const model = createSyntheticModel({ scenario: "calc" });
  const asks = await model.complete(REQUEST);
  assert.equal(asks.kind, "tool_calls");
  if (asks.kind !== "tool_calls") return;
  assert.deepEqual([asks.calls[0].id, asks.calls[0].name], ["syn-call-1", "calculate_tax"]);
  assert.deepEqual(asks.calls[0].arguments, { kind: "json", value: SYNTHETIC_CALC_ARGS });
  // The words in the request change nothing about what it asks for.
  const other = await model.complete({ messages: [{ role: "user", content: "[synthetic] something completely different" }] });
  assert.deepEqual(other.kind === "tool_calls" && other.calls, asks.calls);
  const answered = await model.complete({ messages: [...REQUEST.messages, { role: "tool", toolCallId: "syn-call-1", name: "calculate_tax", content: "{}" }] });
  assert.equal(answered.kind, "text");
});

// --- end to end: honest answers pass, misbehaving ones are withheld ---------------------------------------------------------

test("honest scenarios run end to end through the synthetic tools and are answered, carrying the tools' own facts", async () => {
  const tools = createSyntheticTools();
  const plain = await run("plain");
  assert.equal(plain.state, "answered");
  assert.equal(plain.facts.taxValues.length + plain.facts.ledger.length + plain.facts.evidence.length, 0, "no tool was used");

  const calc = await run("calc");
  assert.equal(calc.state, "answered");
  assert.equal(calc.facts.taxValues[0].shape, "single_regime");
  const reference = await tools.calculate_tax(SYNTHETIC_USER_ID, SYNTHETIC_CALC_ARGS);
  assert.deepEqual(calc.facts.taxValues[0].payload, reference.status === "ok" && reference.result, "the engine's own result, verbatim");
  assert.equal((calc.facts.taxValues[0].payload as { result: { totalTaxPaise: number } }).result.totalTaxPaise, 21_060_000, "the real, pure engine computed it");

  const law = await run("law");
  assert.equal(law.state, "answered");
  assert.deepEqual(law.citations.map((c) => c.evidenceId), ["ev_5359e7c0f1a2b3c4"]);
  assert.match(law.facts.evidence[0].title, /SYNTHETIC/, "the passage says it is test data");
  assert.equal(law.authority.guidanceOnly, true);

  const compare = await run("compare");
  assert.equal(compare.state, "answered");
  assert.equal(compare.facts.taxValues[0].shape, "regime_comparison");
  assert.equal(compare.facts.taxValues[0].notice, COMPARISON_NOTICE);

  assert.equal((await run("simulate")).facts.taxValues[0].shape, "scenario");

  const summary = await run("summary");
  assert.equal(summary.state, "answered");
  const ledger = summary.facts.ledger[0];
  assert.equal(ledger.shape, "summary");
  assert.deepEqual([(ledger.payload as { incomePaise: number }).incomePaise, (ledger.payload as { expensePaise: number }).expensePaise], [5_000_000, 1_500_000]);
  assert.deepEqual((ledger.payload as { categories: unknown[] }).categories, [], "category names (ledger free text) are not served");

  const disabled = await run("disabled-tool");
  assert.equal(disabled.state, "answered");
  assert.deepEqual(disabled.facts.refusals.map((r) => r.reason), ["invalid_arguments"]);
  assert.match(disabled.facts.refusals[0].message, /not enabled in synthetic mode/, "row-level ledger data is not served");
});

test("scenarios that model a MISBEHAVING model are withheld by the answer layer, and the tool facts still stand", async () => {
  const wrong = await run("wrong-figure");
  assert.equal(wrong.state, "withheld");
  assert.ok(codes(wrong).includes("ungrounded_figure"));
  assert.equal(wrong.text, null);
  assert.equal(wrong.facts.taxValues.length, 1, "the engine's result is kept");
  assert.ok(codes(await run("invented-citation")).includes("invented_evidence_id"));
  assert.ok(codes(await run("recommend-regime")).includes("regime_recommendation"));
});

test("the synthetic tools' results are accepted by the answer layer exactly as real ones are: no invalid tool result", async () => {
  const tools = createSyntheticTools();
  const calls: Array<[string, unknown]> = [
    ["search_tax_law", { question: "What is the rebate under section 87A?", assessmentYear: "2026-27" }], ["get_financial_summary", {}], ["calculate_tax", SYNTHETIC_CALC_ARGS],
  ];
  for (const [tool, args] of calls) {
    const result = await (tools as unknown as Record<string, (u: string, a: unknown) => Promise<unknown>>)[tool](SYNTHETIC_USER_ID, args);
    const answer = buildAnswer({ text: "Ok.", toolRecords: [{ round: 1, callId: "c", tool, result }] });
    assert.deepEqual(answer.violations, [], tool);
  }
});

// --- fail closed: timeout, size, recipient, configuration ------------------------------------------------------------------

test("a timeout is enforced: a hung transport is cut off by MODEL_TIMEOUT_MS, typed, with no answer", async () => {
  const started = Date.now();
  await assert.rejects(() => run("hang", { MODEL_TIMEOUT_MS: "60" }), (e: unknown) => e instanceof ModelProviderError && e.code === "timeout");
  assert.ok(Date.now() - started < 3000);
});

test("an oversized answer is rejected: longer than MODEL_MAX_OUTPUT_CHARS is refused, not shortened", async () => {
  await assert.rejects(() => run("oversized", { MODEL_MAX_OUTPUT_CHARS: "100" }), (e: unknown) => e instanceof ModelProviderError && e.code === "output_too_large");
  assert.equal((await run("plain", { MODEL_MAX_OUTPUT_CHARS: "100" })).state, "answered", "a short honest answer is fine under the same limit");
});

test("an unapproved recipient fails closed: one that is not listed, one that names none, and the synthetic one when it is not on the list", async () => {
  for (const scenario of ["foreign-recipient", "no-metadata"] as const) {
    await assert.rejects(() => run(scenario), (e: unknown) => e instanceof ModelProviderError && e.code === "recipient_not_approved", scenario);
  }
  await assert.rejects(() => run("plain", { MODEL_APPROVED_RECIPIENTS: "someone-else" }), (e: unknown) => e instanceof ModelProviderError && e.code === "recipient_not_approved");
  assert.equal((await run("plain", { MODEL_APPROVED_RECIPIENTS: `someone-else, ${SYNTHETIC_RECIPIENT}` })).state, "answered");
});

test("missing or disabled configuration fails closed: nothing runs, and a hand-built real-data mode is refused too", async () => {
  const seen: ModelCallInfo[] = [];
  const track = (i: ModelCallInfo) => { seen.push(i); };
  await assert.rejects(() => askSynthetic(readAssistantConfig({}), INPUT, { scenario: "plain", onModelCall: track }), (e: unknown) => e instanceof AssistantConfigError && e.code === "assistant_disabled");
  assert.throws(() => readAssistantConfig({ ...ENV, MODEL_API_KEY: "" }), (e: unknown) => e instanceof AssistantConfigError && e.code === "missing_configuration");
  assert.throws(() => readAssistantConfig({ ...ENV, ASSISTANT_ENV: "real" }), (e: unknown) => e instanceof AssistantConfigError && e.code === "real_data_mode_not_permitted");
  const handBuilt = { ...config(), env: "real" } as never;
  await assert.rejects(() => askSynthetic(handBuilt, INPUT, { scenario: "plain", onModelCall: track }), (e: unknown) => e instanceof AssistantConfigError && e.code === "real_data_mode_not_permitted");
  assert.equal(seen.length, 0, "no model call was made for any of them");
});

test("the transport's own typed and untyped failures are contained: a rate limit stays typed, an unknown error becomes an AssistantFailure", async () => {
  await assert.rejects(() => run("rate-limited"), (e: unknown) => e instanceof ModelProviderError && e.code === "rate_limited");
  await assert.rejects(() => run("leaky-error"), (e: unknown) => e instanceof AssistantFailure && e.code === "unexpected_failure" && e.errorName === "SyntheticProviderError");
});

// --- the key never appears --------------------------------------------------------------------------------------------------------

test("the API key appears in no error, log, result or metadata, in any scenario, including the one built to put it in an error", async () => {
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const printed: string[] = [];
  for (const name of Object.keys(original) as Array<keyof typeof original>) console[name] = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };
  const observed: string[] = [];
  const outcomes: string[] = [];
  try {
    for (const scenario of SYNTHETIC_SCENARIOS) {
      const infos: ModelCallInfo[] = [];
      try {
        const answer = await run(scenario, scenario === "hang" ? { MODEL_TIMEOUT_MS: "40" } : scenario === "oversized" ? { MODEL_MAX_OUTPUT_CHARS: "100" } : {}, (i) => { infos.push(i); });
        observed.push(dump(answer));
        outcomes.push(`${scenario}:${answer.state}`);
      } catch (error) {
        observed.push(dump(error));
        outcomes.push(`${scenario}:${error instanceof Error ? error.name : "?"}`);
      }
      observed.push(dump(infos));
    }
  } finally {
    Object.assign(console, original);
  }
  assert.equal(outcomes.length, SYNTHETIC_SCENARIOS.length);
  assert.ok(outcomes.includes("leaky-error:AssistantFailure"), "the fixture built to leak really did throw, and was contained");
  assert.equal(observed.join("\n").includes(KEY), false, "the key is nowhere in any answer, error or metadata");
  assert.equal(observed.join("\n").includes("synthetic.invalid/v1"), false, "nor the endpoint");
  assert.deepEqual(printed, [], "nothing was logged at all");
});

// --- synthetic mode never reaches real user data -------------------------------------------------------------------------

test("only the synthetic user is accepted: a real account's id is refused before the model or any tool runs, and is never echoed", async () => {
  const seen: ModelCallInfo[] = [];
  for (const userId of ["8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f", "user-123", "", "synthetic-user-0002", ` ${SYNTHETIC_USER_ID}`, "SYNTHETIC-USER-0001"]) {
    await assert.rejects(
      () => askSynthetic(config(), { userId, userMessages: [`${SYNTHETIC_MESSAGE_PREFIX} hi`] }, { scenario: "plain", onModelCall: (i) => { seen.push(i); } }),
      (e: unknown) => e instanceof SyntheticModeError && e.code === "real_user_not_permitted" && !e.message.includes(userId || "\u0000") && !dump(e).includes("5b7d"),
      userId,
    );
  }
  assert.equal(seen.length, 0);
});

test("only synthetic messages are accepted: text without the prefix is refused before anything runs, and is never echoed", async () => {
  for (const message of ["What is my salary tax?", "hello [synthetic]", " [synthetic] leading space", "[SYNTHETIC] wrong case", "My PAN is ABCDE1234F"]) {
    await assert.rejects(
      () => askSynthetic(config(), { userId: SYNTHETIC_USER_ID, userMessages: [`${SYNTHETIC_MESSAGE_PREFIX} ok`, message] }, { scenario: "plain" }),
      (e: unknown) => e instanceof SyntheticModeError && e.code === "message_not_synthetic" && !dump(e).includes("PAN") && !dump(e).includes("salary"),
      message,
    );
  }
});

test("the synthetic tool set serves only its fixtures, only to the synthetic user, and has no ledger rows to give", async () => {
  const tools = createSyntheticTools();
  await assert.rejects(() => tools.calculate_tax("8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f", SYNTHETIC_CALC_ARGS), NotAuthenticatedError);
  await assert.rejects(() => tools.query_transactions("", {}), NotAuthenticatedError);
  const refusals = await Promise.all([
    tools.calculate_tax(SYNTHETIC_USER_ID, { ...SYNTHETIC_CALC_ARGS, regime: "new" }),
    tools.calculate_tax(SYNTHETIC_USER_ID, { ...SYNTHETIC_CALC_ARGS, income: { salaryPaise: 1 } }),
    tools.calculate_tax(SYNTHETIC_USER_ID, { ...SYNTHETIC_CALC_ARGS, userId: "someone" }),
    tools.get_financial_summary(SYNTHETIC_USER_ID, { from: "2026-01-01", to: "2026-02-01" }),
    tools.query_transactions(SYNTHETIC_USER_ID, { limit: 5, includeDescription: true }),
  ]);
  for (const r of refusals) assert.deepEqual([r.status, r.status === "refused" && r.reason], ["refused", "invalid_arguments"]);
  const missing = await tools.search_tax_law(SYNTHETIC_USER_ID, { question: "What is the rebate?", assessmentYear: "2024-25" });
  assert.deepEqual([missing.status, missing.status === "refused" && missing.reason], ["refused", "no_corpus_for_assessment_year"], "a typed retrieval refusal, like the real one");
  assert.deepEqual(await tools.get_financial_summary(SYNTHETIC_USER_ID, {}), await tools.get_financial_summary(SYNTHETIC_USER_ID, {}), "the same every time");
});

test("running the whole synthetic path loads no database client and none of the real, database-backed services", async () => {
  await run("calc");
  await run("summary");
  const loaded = Object.keys(require.cache);
  assert.ok(loaded.some((file) => /synthetic-tools/.test(file)), "the check is meaningful: the synthetic modules are in the module cache");
  const real = loaded.filter((file) => /[\\/](db[\\/](client|schema)|services[\\/](transactions|tax|tax-retrieval|tax-corpus|session|assistant[\\/]tools))\.[jt]s$/.test(file));
  assert.deepEqual(real, [], "none of the real data paths was loaded");
});

// --- the source: fixture-only, no network, no environment, no real tools -------------------------------------------------------

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const SYNTHETIC_SOURCES = ["services/assistant/synthetic.ts", "services/assistant/synthetic-model.ts", "services/assistant/synthetic-tools.ts"];

test("the synthetic modules contain no network, environment, file, logging, provider or database access", () => {
  for (const file of SYNTHETIC_SOURCES) {
    const source = strip(fs.readFileSync(path.join(FRONTEND, file), "utf8"));
    assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|WebSocket|node:(?:http|https|net|tls|dgram|fs|child_process)|\brequire\(|\bimport\(|process\.(?:env|stdout|stderr)|\bconsole\s*\./, `${file}: no network, file, environment or logging`);
    assert.doesNotMatch(source, /https?:\/\/(?!synthetic\.invalid\/)/, `${file}: no address, apart from the reserved .invalid fixture`);
    assert.doesNotMatch(source, /openai|anthropic|claude|gemini|mistral|cohere|omniroute|langchain|@ai-sdk/i, `${file}: no provider name`);
    assert.doesNotMatch(source, /\b(?:db|drizzle|next-auth)\b|@\/db|services\/(?:session|transactions|tax-retrieval|tax-corpus)|from\s+["']\.\.\/(?:tax|transactions|tax-retrieval|session)["']/, `${file}: no database or real service`);
  }
});

test("synthetic mode passes its OWN tools explicitly, so it can never fall back to the real ones", () => {
  const source = strip(fs.readFileSync(path.join(FRONTEND, "services/assistant/synthetic.ts"), "utf8"));
  assert.match(source, /tools:\s*createSyntheticTools\(\)/, "an explicit tool set");
  assert.equal((source.match(/askAssistant\(/g) ?? []).length, 1);
  assert.doesNotMatch(source, /assistantTools|createAssistantTools|from\s+["']\.\/tools["']/, "the real tool set is not referenced");
  assert.doesNotMatch(strip(fs.readFileSync(path.join(FRONTEND, "services/assistant/synthetic-tools.ts"), "utf8")), /^import\s+(?!type\b)[^;]*from\s+["']\.\/tools["']/m, "and synthetic-tools imports the real tools' TYPES only");
});
