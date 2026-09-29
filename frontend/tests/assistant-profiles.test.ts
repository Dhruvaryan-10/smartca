// Named assistant access profiles (lib/assistant/profiles.ts). PURE: no database, no DATABASE_URL. Profiles are not wired into any
// run yet; these pin what they say and that resolveProfile fails closed.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantProfileError, EGRESS_FIELD_CLASSES, FULL_PROFILE, SYNTHETIC_PROFILE, classesReturnedBy, resolveProfile } from "../lib/assistant/profiles";
import type { AssistantProfile } from "../lib/assistant/profiles";
import { ASSISTANT_EGRESS_INVENTORY, ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import { SYNTHETIC_TOOL_NAMES } from "../services/assistant/synthetic-tools";

const FRONTEND = path.resolve(__dirname, "..");
const ALL = { user_free_text: true, user_financial_data: true, tax_corpus_text: true, system_value: true };
const rejects = (profile: unknown, code: string) =>
  assert.throws(() => resolveProfile(profile), (e: unknown) => e instanceof AssistantProfileError && e.code === code, `expected ${code}`);

test("the synthetic profile is exactly the five-tool boundary synthetic mode enforces", () => {
  assert.deepEqual([...SYNTHETIC_PROFILE.tools], [...SYNTHETIC_TOOL_NAMES]);
  assert.equal(SYNTHETIC_PROFILE.tools.includes("query_transactions"), false);
  assert.deepEqual(resolveProfile(SYNTHETIC_PROFILE).allowedTools, [...SYNTHETIC_TOOL_NAMES]);
});

test("the full profile is all six tools and all four egress classes", () => {
  assert.deepEqual([...FULL_PROFILE.tools], [...ASSISTANT_TOOL_NAMES]);
  assert.deepEqual({ ...FULL_PROFILE.classes }, ALL);
  assert.deepEqual([...EGRESS_FIELD_CLASSES].sort(), Object.keys(ALL).sort());
  const resolved = resolveProfile(FULL_PROFILE);
  assert.deepEqual(resolved, { id: "full", allowedTools: [...ASSISTANT_TOOL_NAMES], classes: ALL });
  assert.ok(Object.isFrozen(resolved) && Object.isFrozen(resolved.allowedTools) && Object.isFrozen(resolved.classes));
  assert.ok(Object.isFrozen(FULL_PROFILE) && Object.isFrozen(SYNTHETIC_PROFILE));
});

test("valid broad profiles resolve, with their tools in the canonical order", () => {
  const resolved = resolveProfile({ id: "some", tools: ["simulate_tax", "search_tax_law", "query_transactions"], classes: ALL });
  assert.deepEqual(resolved.allowedTools, ["search_tax_law", "query_transactions", "simulate_tax"]);
  // Forbidding a class none of the chosen tools returns is honourable today.
  const noCorpus = resolveProfile({ id: "ledger", tools: ["get_financial_summary"], classes: { ...ALL, tax_corpus_text: false } });
  assert.deepEqual(noCorpus.allowedTools, ["get_financial_summary"]);
  assert.equal(noCorpus.classes.tax_corpus_text, false);
});

test("an empty, unknown or repeated tool list fails closed", () => {
  rejects({ id: "x", tools: [], classes: ALL }, "empty_tools");
  rejects({ id: "x", tools: "search_tax_law", classes: ALL }, "empty_tools");
  rejects({ id: "x", tools: ["search_tax_law", "delete_ledger"], classes: ALL }, "unknown_tool");
  rejects({ id: "x", tools: [42], classes: ALL }, "unknown_tool");
  rejects({ id: "x", tools: ["calculate_tax", "calculate_tax"], classes: ALL }, "duplicate_tool");
});

test("a malformed profile or class statement fails closed", () => {
  for (const profile of [null, [], "full", { tools: ["calculate_tax"], classes: ALL }, { id: " ", tools: ["calculate_tax"], classes: ALL }]) rejects(profile, "invalid_profile");
  const partial: Record<string, boolean> = { ...ALL };
  delete partial.system_value;
  rejects({ id: "x", tools: ["calculate_tax"], classes: partial }, "invalid_classes");
  rejects({ id: "x", tools: ["calculate_tax"], classes: { ...ALL, write_access: true } }, "invalid_classes");
  rejects({ id: "x", tools: ["calculate_tax"], classes: { ...ALL, system_value: "yes" } }, "invalid_classes");
  rejects({ id: "x", tools: ["calculate_tax"] }, "invalid_classes");
});

test("a profile may allow a tool while forbidding some of what it returns: field filtering enforces its classes", () => {
  // Every tool can repeat a model-sent argument name in a refusal message, so every tool returns user_free_text.
  for (const tool of ASSISTANT_TOOL_NAMES) assert.ok(classesReturnedBy(tool).includes("user_free_text"), tool);
  const financialOnly: AssistantProfile = { id: "financial", tools: [...ASSISTANT_TOOL_NAMES], classes: { ...ALL, user_free_text: false } };
  const resolved = resolveProfile(financialOnly);
  assert.deepEqual(resolved.allowedTools, [...ASSISTANT_TOOL_NAMES]);
  assert.deepEqual({ ...resolved.classes }, { ...ALL, user_free_text: false }, "the classes are carried through, to be passed as visibleClasses");
  assert.deepEqual({ ...resolveProfile({ id: "x", tools: ["search_tax_law"], classes: { ...ALL, tax_corpus_text: false } }).classes }, { ...ALL, tax_corpus_text: false });
});

test("classesReturnedBy reads the egress inventory", () => {
  for (const tool of ASSISTANT_TOOL_NAMES) {
    assert.deepEqual(new Set(classesReturnedBy(tool)), new Set(Object.values(ASSISTANT_EGRESS_INVENTORY[tool])), tool);
  }
});

test("profiles.ts imports only the pure tool contract", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "lib/assistant/profiles.ts"), "utf8");
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)], ["./tool-contract"]);
  assert.doesNotMatch(source, /require\(|import\(|process\.env|fetch\(/);
});
