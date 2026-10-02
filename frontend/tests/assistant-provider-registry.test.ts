// The provider wire format by configuration (docs/decisions/0004): MODEL_WIRE_FORMAT, the driver registry (provider-registry.ts) and the
// Chat Completions driver's token field. PURE: no database, no network. Pinned: the format is required by an external configuration, one
// of a closed list, refused by name and never by value, and ignored by synthetic mode; each format sends the configured cap in exactly one
// field, chosen by the driver layer alone; nothing a caller, request or model supplies can change the field or the value; the wire field
// names appear nowhere above the driver layer; and the activation gate still refuses external mode.
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AssistantConfigError, MODEL_WIRE_FORMATS, readAssistantConfig, validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { providerDriverFor } from "../services/assistant/provider-registry";
import { CHAT_COMPLETIONS_TOKEN_FIELDS, chatCompletionsDriver, encodeChatCompletion } from "../services/assistant/provider-chat-completions";
import { createProviderAdapter } from "../services/assistant/provider";
import { ModelRequestError, withModelGuard } from "../services/assistant/model";
import type { ModelRequest } from "../services/assistant/model";

const FRONTEND = path.resolve(__dirname, "..");
const KEY = "test-key-NOT-A-REAL-SECRET-0013";
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: "https://provider.invalid/v1/chat/completions", MODEL_API_KEY: KEY,
  MODEL_ID: "fixture-model-1", MODEL_APPROVED_RECIPIENTS: "recipient-a", MODEL_TIMEOUT_MS: "3000", MODEL_MAX_OUTPUT_CHARS: "20000",
  MODEL_MAX_OUTPUT_TOKENS: "700", MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "10",
  ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "100000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "10", ASSISTANT_RUN_RETENTION_DAYS: "30",
};
const REQUEST: ModelRequest = { messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }], tools: [] };
const COMPLETION = JSON.stringify({ model: "fixture-model-1", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } });

function rejection(env: Record<string, string | undefined>): AssistantConfigError {
  try {
    validateExternalEnv(env);
  } catch (error) {
    assert.ok(error instanceof AssistantConfigError);
    return error;
  }
  throw new assert.AssertionError({ message: "expected a configuration error" });
}

test("MODEL_WIRE_FORMAT is required by an external configuration, one of a closed list, and refused by name, never by value", () => {
  assert.deepEqual([...MODEL_WIRE_FORMATS], ["openai-chat-completions", "openai-chat-completions-max-tokens"]);
  for (const format of MODEL_WIRE_FORMATS) assert.equal(validateExternalEnv({ ...ENV, MODEL_WIRE_FORMAT: format }).wireFormat, format);
  for (const missing of [undefined, "", "  "]) {
    const e = rejection({ ...ENV, MODEL_WIRE_FORMAT: missing });
    assert.deepEqual([e.code, e.variables], ["missing_configuration", ["MODEL_WIRE_FORMAT"]], JSON.stringify(missing));
  }
  for (const bad of ["anthropic-messages", "OPENAI-CHAT-COMPLETIONS", " openai-chat-completions", "openai-chat-completions;max_tokens=999999", "max_completion_tokens", KEY]) {
    const e = rejection({ ...ENV, MODEL_WIRE_FORMAT: bad });
    assert.deepEqual([e.code, e.variables], ["invalid_configuration", ["MODEL_WIRE_FORMAT"]], bad);
    assert.equal([String(e), JSON.stringify(e), inspect(e)].join("\n").includes(bad.trim()), false, "the value is never in the error");
  }
});

test("synthetic mode is unaffected: MODEL_WIRE_FORMAT is not required, not read and never part of its configuration", () => {
  const synthetic = { ...ENV, ASSISTANT_ENV: "synthetic", MODEL_WIRE_FORMAT: "not-a-format" };
  const config = readAssistantConfig(synthetic) as Record<string, unknown>;
  assert.equal(config.env, "synthetic");
  assert.equal("wireFormat" in config, false);
  const { MODEL_WIRE_FORMAT: _ignored, ...withoutFormat } = synthetic;
  void _ignored;
  assert.equal((readAssistantConfig(withoutFormat) as Record<string, unknown>).env, "synthetic");
});

test("the activation gate still holds: a complete, valid external environment is refused by readAssistantConfig", () => {
  assert.throws(() => readAssistantConfig(ENV), (e: unknown) => e instanceof AssistantConfigError && e.code === "real_data_mode_not_permitted");
});

test("each wire format sends the configured cap in exactly one field, chosen by the registry, whatever the caller or request supplies", async () => {
  const expected = { "openai-chat-completions": ["max_completion_tokens", "max_tokens"], "openai-chat-completions-max-tokens": ["max_tokens", "max_completion_tokens"] } as const;
  for (const format of MODEL_WIRE_FORMATS) {
    const config = validateExternalEnv({ ...ENV, MODEL_WIRE_FORMAT: format });
    const bodies: string[] = [];
    const driver = providerDriverFor(config, { fetch: async (_url, init) => { bodies.push(String(init.body)); return new Response(COMPLETION, { status: 200 }); } });
    const smuggled = { ...REQUEST, max_tokens: 999_999, max_completion_tokens: 999_999, maxOutputTokens: 999_999 } as unknown as ModelRequest;
    await createProviderAdapter(config, driver).complete(smuggled, { maxOutputTokens: 999_999, max_tokens: 999_999 } as never);
    const sent = JSON.parse(bodies[0]) as Record<string, unknown>;
    const [field, other] = expected[format];
    assert.equal(sent[field], 700, format);
    assert.equal(other in sent, false, `${format} never sends ${other}`);
    assert.equal(bodies[0].includes("999999"), false, "nothing the caller supplied reached the wire");
    // Under the guard a request that names a cap is refused outright, and nothing is sent.
    const guardedBodies: string[] = [];
    const guarded = providerDriverFor(config, { fetch: async (_url, init) => { guardedBodies.push(String(init.body)); return new Response(COMPLETION, { status: 200 }); } });
    await assert.rejects(withModelGuard(createProviderAdapter(config, guarded)).complete(smuggled), (e: unknown) => e instanceof ModelRequestError);
    assert.equal(guardedBodies.length, 0);
  }
});

test("a hand-built configuration with an unknown format cannot get a driver: it fails closed, naming the variable only", () => {
  const good = validateExternalEnv(ENV);
  for (const format of ["anthropic-messages", "", undefined, null, 1, "max_tokens"]) {
    assert.throws(
      () => providerDriverFor({ ...good, wireFormat: format } as AssistantConfig as never),
      (e: unknown) => e instanceof AssistantConfigError && e.code === "invalid_configuration" && e.variables.join() === "MODEL_WIRE_FORMAT",
      String(format),
    );
  }
  assert.throws(() => chatCompletionsDriver({ tokenField: "max_output_tokens" as never }), /not a known one/);
  assert.throws(() => encodeChatCompletion(REQUEST, { modelId: "m", maxOutputTokens: 5 }, "max_output_tokens" as never), /not a known one/);
  assert.deepEqual([...CHAT_COMPLETIONS_TOKEN_FIELDS], ["max_completion_tokens", "max_tokens"]);
});

test("the wire field names appear only in the driver layer: the configuration, provider boundary, service and HTTP boundary never name them", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const file of ["config.ts", "provider.ts", "service.ts", "http.ts", "external.ts", "model.ts", "orchestrator.ts", "api-contract.ts", "preflight.ts"]) {
    const code = strip(fs.readFileSync(path.join(FRONTEND, "services/assistant", file), "utf8"));
    assert.doesNotMatch(code, /max_completion_tokens|max_tokens/, file);
  }
});
