// The LOCAL configuration (services/assistant/config.ts, validateLocalEnv; docs/decisions/0005). PURE: no database, no network.
// What is pinned: local mode is the external configuration with ONE difference, a loopback-only endpoint, so nothing it builds can
// reach another machine; every other external requirement still applies; a local configuration's loopback endpoint is refused under
// external mode, so a production deployment cannot use the local model by mistake; errors name variables, never values.
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_LIMIT_ENV_NAMES, AssistantConfigError, readAssistantConfig, validateExternalEnv, validateLocalEnv,
} from "../services/assistant/config";
import { readProviderTarget } from "../services/assistant/provider";

const KEY = "local-key-NOT-A-REAL-SECRET-0005";
const LOCAL: Record<string, string> = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_ENV: "local",
  MODEL_ENDPOINT: "http://127.0.0.1:11434/v1/chat/completions",
  MODEL_API_KEY: KEY,
  MODEL_ID: "qwen2.5:7b-instruct",
  MODEL_APPROVED_RECIPIENTS: "local-ollama",
  MODEL_TIMEOUT_MS: "60000",
  MODEL_MAX_OUTPUT_CHARS: "8000",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600",
  ASSISTANT_MAX_RUNS_PER_WINDOW: "30",
  ASSISTANT_MAX_CONCURRENT_RUNS: "1",
  ASSISTANT_MAX_TOKENS_PER_WINDOW: "200000",
  ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "4",
  MODEL_MAX_OUTPUT_TOKENS: "1024",
  MODEL_WIRE_FORMAT: "openai-chat-completions-max-tokens",
  ASSISTANT_RUN_RETENTION_DAYS: "30",
};

function refused(env: Record<string, string | undefined>): AssistantConfigError {
  try {
    readAssistantConfig(env);
  } catch (error) {
    assert.ok(error instanceof AssistantConfigError, String(error));
    assert.ok(![String(error), JSON.stringify(error), inspect(error), error.stack ?? ""].join("\n").includes(KEY), "the key is never in an error");
    return error;
  }
  throw new assert.AssertionError({ message: "expected the local configuration to be refused" });
}

test("a complete local configuration is accepted by the reader as env 'local', with every external setting", () => {
  const config = readAssistantConfig(LOCAL);
  assert.ok(config.enabled && config.env === "local");
  assert.equal(config.endpoint, "http://127.0.0.1:11434/v1/chat/completions");
  assert.deepEqual(config.approvedRecipients, ["local-ollama"]);
  assert.equal(config.maxOutputTokens, 1024);
  assert.equal(config.wireFormat, "openai-chat-completions-max-tokens");
  assert.deepEqual({ ...config.limits }, { windowSeconds: 3600, maxRunsPerWindow: 30, maxConcurrentRuns: 1, maxTokensPerWindow: 200000, maxGlobalConcurrentRuns: 4 });
  assert.equal(config.runRetentionDays, 30);
  assert.equal(String(config.apiKey), "[redacted]");
  assert.ok(Object.isFrozen(config));
  assert.deepEqual(validateLocalEnv(LOCAL), config);
});

test("the provider target accepts a local configuration exactly as an external one: one recipient, the model id, the token cap", () => {
  const target = readProviderTarget(readAssistantConfig(LOCAL));
  assert.equal(target.recipient, "local-ollama");
  assert.equal(target.config.env, "local");
});

test("the endpoint must be a loopback IP literal: no other host, name, private address or credentials", () => {
  for (const endpoint of [
    "http://localhost:11434/v1/chat/completions", // a name can be re-pointed
    "http://127.0.0.2:11434/v1/chat/completions",
    "http://0.0.0.0:11434/v1/chat/completions",
    "http://192.168.1.12:11434/v1/chat/completions",
    "http://10.0.0.5/v1/chat/completions",
    "https://api.openai.com/v1/chat/completions",
    "https://openrouter.ai/api/v1/chat/completions",
    "http://127.0.0.1.nip.io/v1/chat/completions",
    "http://user:pass@127.0.0.1:11434/v1/chat/completions",
    "ftp://127.0.0.1/v1",
    "not a url",
  ]) {
    const error = refused({ ...LOCAL, MODEL_ENDPOINT: endpoint });
    assert.equal(error.code, "invalid_configuration", endpoint);
    assert.deepEqual(error.variables, ["MODEL_ENDPOINT"], endpoint);
  }
  for (const endpoint of ["http://[::1]:11434/v1/chat/completions", "https://127.0.0.1:8443/v1/chat/completions"]) {
    const config = readAssistantConfig({ ...LOCAL, MODEL_ENDPOINT: endpoint });
    assert.ok(config.enabled && config.env === "local", endpoint);
  }
});

test("every limit, the token cap, the wire format and the retention are still required in local mode", () => {
  for (const name of [...ASSISTANT_LIMIT_ENV_NAMES, "MODEL_MAX_OUTPUT_TOKENS", "MODEL_WIRE_FORMAT", "ASSISTANT_RUN_RETENTION_DAYS"]) {
    const error = refused({ ...LOCAL, [name]: undefined });
    assert.equal(error.code, "missing_configuration", name);
    assert.ok(error.variables.includes(name as never), name);
  }
  assert.equal(refused({ ...LOCAL, MODEL_APPROVED_RECIPIENTS: "local-ollama,another" }).code, "invalid_configuration", "exactly one recipient");
  assert.equal(refused({ ...LOCAL, ASSISTANT_MAX_CONCURRENT_RUNS: "5", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "4" }).code, "invalid_configuration");
});

test("a local configuration switched to external mode is refused: the external validator demands https and a host off this machine", () => {
  // The local endpoint as-is (http, loopback), and the same host over https: both refused under external, by the reader and the validator.
  for (const endpoint of [LOCAL.MODEL_ENDPOINT, "https://127.0.0.1:11434/v1/chat/completions", "https://[::1]:11434/v1/chat/completions", "https://localhost:11434/v1/chat/completions"]) {
    const error = refused({ ...LOCAL, ASSISTANT_ENV: "external", MODEL_ENDPOINT: endpoint });
    assert.deepEqual([error.code, error.variables], ["invalid_configuration", ["MODEL_ENDPOINT"]], endpoint);
    assert.throws(() => validateExternalEnv({ ...LOCAL, ASSISTANT_ENV: "external", MODEL_ENDPOINT: endpoint }), (e: unknown) => e instanceof AssistantConfigError && e.variables.includes("MODEL_ENDPOINT"), endpoint);
  }
  // With a hosted https endpoint, the same values are a valid external configuration, and no longer a local one.
  assert.equal((readAssistantConfig({ ...LOCAL, ASSISTANT_ENV: "external", MODEL_ENDPOINT: "https://provider.invalid/v1" }) as { env?: string }).env, "external");
  assert.throws(() => validateLocalEnv({ ...LOCAL, ASSISTANT_ENV: "external" }), (e: unknown) => e instanceof AssistantConfigError && e.variables.includes("ASSISTANT_ENV"));
  for (const mode of ["LOCAL", "local ", "production", "real"]) {
    assert.equal(refused({ ...LOCAL, ASSISTANT_ENV: mode }).code, "real_data_mode_not_permitted", mode);
  }
});

test("off stays off: ASSISTANT_ENABLED unset or false ignores a local configuration", () => {
  assert.deepEqual(readAssistantConfig({ ...LOCAL, ASSISTANT_ENABLED: "false" }), { enabled: false });
  assert.deepEqual(readAssistantConfig({ ...LOCAL, ASSISTANT_ENABLED: undefined }), { enabled: false });
});
