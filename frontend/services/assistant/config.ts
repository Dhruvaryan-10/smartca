// The assistant's SERVER-ONLY configuration. Read from environment variables, validated, and failing closed. Nothing under app/
// imports it (a test pins that), no variable is NEXT_PUBLIC_, and it prints nothing.
//
//   ASSISTANT_ENABLED=false          off unless exactly "true"
//   ASSISTANT_ENV=synthetic          the only valid value today; ANY other, a real-data mode included, fails closed
//   MODEL_ENDPOINT=                  an https address, with no credentials in it
//   MODEL_API_KEY=                   the secret; held in a wrapper that cannot be printed or serialised by accident
//   MODEL_ID=                        the model identifier
//   MODEL_APPROVED_RECIPIENTS=       comma-separated recipient ids allowed to answer; anything else fails closed
//   MODEL_TIMEOUT_MS=                per-call timeout, at most MAX_MODEL_TIMEOUT_MS
//   MODEL_MAX_OUTPUT_CHARS=          the longest answer accepted, at most MAX_MESSAGE_CHARS
//
// An EXTERNAL configuration (validateExternalEnv) additionally requires, and validates against hard ceilings:
//   MODEL_MAX_OUTPUT_TOKENS=         the most output tokens the provider may generate per model call, at most MAX_MODEL_OUTPUT_TOKENS
//   MODEL_WIRE_FORMAT=               which wire format the configured endpoint speaks, one of MODEL_WIRE_FORMATS (a NAME only: what each
//                                    format sends is decided by the driver registry, services/assistant/provider-registry.ts)
//   ASSISTANT_RATE_WINDOW_SECONDS=   the window the per-user limits are counted over
//   ASSISTANT_MAX_RUNS_PER_WINDOW=   assistant runs one person may start in that window
//   ASSISTANT_MAX_CONCURRENT_RUNS=   runs one person may have in progress at once
//   ASSISTANT_MAX_TOKENS_PER_WINDOW= model tokens (as the provider reports them) one person may use in that window
//   ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS= runs in progress across everyone at once
//   ASSISTANT_RUN_RETENTION_DAYS=    how long run audit metadata is kept (services/assistant/run-retention.ts deletes older rows)
// and exactly one approved recipient. readAssistantConfig still REFUSES external mode (ADR 0002: until a provider is assessed and
// the consent mechanics are decided), so validateExternalEnv is reachable only from tests; enabling external mode is a reviewed
// change to readAssistantConfig, not a new code path.
//
// When enabled, EVERY one of them is required and validated, so the path a real deployment will use is exercised even by the
// synthetic transport. The synthetic transport never contacts the endpoint and never uses the key for anything: put a
// placeholder there, never a real key. A configuration error names the VARIABLES that are wrong and never a value, so a
// mistyped key or an endpoint with a password in it cannot reach a log through it.
import { MAX_ROUNDS } from "./orchestrator";
import type { ModelRunPolicy } from "./orchestrator";
import { MAX_MESSAGE_CHARS, MAX_MODEL_TIMEOUT_MS, isRecipientId } from "./model";

export const ASSISTANT_ENV_NAMES = [
  "ASSISTANT_ENABLED",
  "ASSISTANT_ENV",
  "MODEL_ENDPOINT",
  "MODEL_API_KEY",
  "MODEL_ID",
  "MODEL_APPROVED_RECIPIENTS",
  "MODEL_TIMEOUT_MS",
  "MODEL_MAX_OUTPUT_CHARS",
] as const;
/** Required only for an external configuration: the provider's per-call generation bound (services/assistant/provider.ts) and its wire format. */
export const ASSISTANT_PROVIDER_ENV_NAMES = ["MODEL_MAX_OUTPUT_TOKENS", "MODEL_WIRE_FORMAT"] as const;
/**
 * The wire formats an external endpoint may speak, by name. Both are the OpenAI-compatible Chat Completions format (docs/decisions/0004);
 * they differ only in the request field that carries MODEL_MAX_OUTPUT_TOKENS, which the driver alone names: OpenAI's current field
 * for "openai-chat-completions", and the older field many compatible servers and gateways still require for
 * "openai-chat-completions-max-tokens". No default: an external configuration must say which one its endpoint speaks.
 */
export const MODEL_WIRE_FORMATS = ["openai-chat-completions", "openai-chat-completions-max-tokens"] as const;
export type ModelWireFormat = (typeof MODEL_WIRE_FORMATS)[number];
export const isModelWireFormat = (value: unknown): value is ModelWireFormat => typeof value === "string" && (MODEL_WIRE_FORMATS as readonly string[]).includes(value);
/** Required only for an external configuration: the per-user limits (services/assistant/run-store.ts). */
export const ASSISTANT_LIMIT_ENV_NAMES = [
  "ASSISTANT_RATE_WINDOW_SECONDS",
  "ASSISTANT_MAX_RUNS_PER_WINDOW",
  "ASSISTANT_MAX_CONCURRENT_RUNS",
  "ASSISTANT_MAX_TOKENS_PER_WINDOW",
  "ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS",
] as const;
/** Required only for an external configuration, and by the retention job on its own (readRunRetentionDays). */
export const ASSISTANT_RETENTION_ENV_NAMES = ["ASSISTANT_RUN_RETENTION_DAYS"] as const;
export type AssistantEnvName =
  | (typeof ASSISTANT_ENV_NAMES)[number]
  | (typeof ASSISTANT_PROVIDER_ENV_NAMES)[number]
  | (typeof ASSISTANT_LIMIT_ENV_NAMES)[number]
  | (typeof ASSISTANT_RETENTION_ENV_NAMES)[number];
const ALL_ENV_NAMES: readonly string[] = [...ASSISTANT_ENV_NAMES, ...ASSISTANT_PROVIDER_ENV_NAMES, ...ASSISTANT_LIMIT_ENV_NAMES, ...ASSISTANT_RETENTION_ENV_NAMES];

/** Hard ceilings on the limit values: validation bounds against mistyped configuration, not product limits (those are configured). */
export const RUN_LIMIT_CEILINGS = { windowSeconds: 86_400, maxRunsPerWindow: 10_000, maxConcurrentRuns: 20, maxTokensPerWindow: 100_000_000, maxGlobalConcurrentRuns: 10_000 } as const;
/**
 * The hard ceiling on MODEL_MAX_OUTPUT_TOKENS: a validation bound against mistyped configuration, like RUN_LIMIT_CEILINGS, not a product
 * limit and not any provider's own maximum. It is the in-code output invariant MODEL_MAX_OUTPUT_CHARS is bounded by (MAX_MESSAGE_CHARS),
 * so the provider is never allowed to generate more tokens than the longest answer the model contract accepts has characters.
 */
export const MAX_MODEL_OUTPUT_TOKENS = MAX_MESSAGE_CHARS;
/**
 * Bounds on ASSISTANT_RUN_RETENTION_DAYS. The floor is one day, which is also the longest a limit window can be (RUN_LIMIT_CEILINGS), so
 * the retention job can never delete a row that a limit still counts; a test pins that relation.
 */
export const RUN_RETENTION_DAYS_BOUNDS = { min: 1, max: 3_650 } as const;

/** The limits of an external configuration, all enforced server-side (lib/assistant/run-limits.ts). */
export type AssistantRunLimits = Readonly<{ windowSeconds: number; maxRunsPerWindow: number; maxConcurrentRuns: number; maxTokensPerWindow: number; maxGlobalConcurrentRuns: number }>;

export const ASSISTANT_CONFIG_ERROR_CODES = ["invalid_configuration", "missing_configuration", "real_data_mode_not_permitted", "assistant_disabled"] as const;
export type AssistantConfigErrorCode = (typeof ASSISTANT_CONFIG_ERROR_CODES)[number];

/** The configuration is unusable. It carries a code and the NAMES of the variables involved, never a value. */
export class AssistantConfigError extends Error {
  readonly code: AssistantConfigErrorCode;
  readonly variables: readonly AssistantEnvName[];
  constructor(code: AssistantConfigErrorCode, variables: readonly AssistantEnvName[] = []) {
    const names = variables.filter((name) => ALL_ENV_NAMES.includes(name));
    super(`The assistant is not configured (${code})${names.length > 0 ? `: ${names.join(", ")}` : ""}.`);
    this.name = "AssistantConfigError";
    this.code = code;
    this.variables = names;
  }
}

/** A secret string. It renders as "[redacted]" everywhere (String, JSON, console, inspect); only reveal() returns it. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

/**
 * The configuration. `env: "external"` exists as a TYPE only, for services/assistant/external.ts: readAssistantConfig never produces it
 * (any ASSISTANT_ENV but "synthetic" still fails closed), so no environment can reach an external model through this reader.
 */
type ModelSettings = {
  enabled: true;
  endpoint: string;
  apiKey: Secret;
  modelId: string;
  approvedRecipients: readonly string[];
  timeoutMs: number;
  maxOutputChars: number;
};
export type SyntheticAssistantConfig = ModelSettings & { env: "synthetic" };
export type ExternalAssistantConfig = ModelSettings & { env: "external"; maxOutputTokens: number; wireFormat: ModelWireFormat; limits: AssistantRunLimits; runRetentionDays: number };
export type AssistantConfig = { enabled: false } | SyntheticAssistantConfig | ExternalAssistantConfig;

const KEY_SHAPE = /^[\x21-\x7e]{1,512}$/;
const MODEL_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const WHOLE_NUMBER = /^[0-9]{1,7}$/;
const MAX_RECIPIENTS = 20;

function endpointOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

function recipientsOf(value: string): string[] | null {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length < 1 || parts.length > MAX_RECIPIENTS || !parts.every(isRecipientId)) return null;
  return [...new Set(parts)];
}

/**
 * A limit value: plain decimal digits only (no sign, decimal point, exponent, whitespace, "NaN" or "Infinity"), from 1 to `max`. It
 * allows as many digits as the largest ceiling needs, which the shared 7-digit pattern above does not (a token budget of 10,000,000 or
 * more would otherwise be refused).
 */
function limitValue(value: string, max: number): number | null {
  if (!/^[0-9]{1,9}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

function boundedInteger(value: string, max: number): number | null {
  if (!WHOLE_NUMBER.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= max ? n : null;
}

/**
 * Reads the configuration from `env` (process.env by default). Off unless ASSISTANT_ENABLED is exactly "true". When on, the mode
 * must be "synthetic" (checked first, so a real-data request is refused whatever else is missing), every other variable must be
 * present, and every value must be valid; otherwise this throws an AssistantConfigError and returns nothing.
 */
export function readAssistantConfig(env: Readonly<Record<string, string | undefined>> = process.env): AssistantConfig {
  const enabled = env.ASSISTANT_ENABLED;
  if (enabled === undefined || enabled === "" || enabled === "false") return Object.freeze({ enabled: false as const });
  if (enabled !== "true") throw new AssistantConfigError("invalid_configuration", ["ASSISTANT_ENABLED"]);

  const mode = env.ASSISTANT_ENV;
  if (mode !== undefined && mode !== "" && mode !== "synthetic") throw new AssistantConfigError("real_data_mode_not_permitted", ["ASSISTANT_ENV"]);

  return Object.freeze({ env: "synthetic" as const, ...readModelSettings(env) });
}

const valueIn = (env: Readonly<Record<string, string | undefined>>) => (name: AssistantEnvName): string | undefined => {
  const raw = env[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
};

/** The model settings every enabled mode needs, all required and validated. Errors name variables, never values. */
function readModelSettings(env: Readonly<Record<string, string | undefined>>): ModelSettings {
  const value = valueIn(env);
  const missing = ASSISTANT_ENV_NAMES.filter((name) => name !== "ASSISTANT_ENABLED" && value(name) === undefined);
  if (missing.length > 0) throw new AssistantConfigError("missing_configuration", missing);

  const endpoint = endpointOf(value("MODEL_ENDPOINT") as string);
  const apiKey = KEY_SHAPE.test(value("MODEL_API_KEY") as string) ? (value("MODEL_API_KEY") as string) : null;
  const modelId = MODEL_ID_SHAPE.test(value("MODEL_ID") as string) ? (value("MODEL_ID") as string) : null;
  const approvedRecipients = recipientsOf(value("MODEL_APPROVED_RECIPIENTS") as string);
  const timeoutMs = boundedInteger(value("MODEL_TIMEOUT_MS") as string, MAX_MODEL_TIMEOUT_MS);
  const maxOutputChars = boundedInteger(value("MODEL_MAX_OUTPUT_CHARS") as string, MAX_MESSAGE_CHARS);

  const invalid: AssistantEnvName[] = [];
  if (endpoint === null) invalid.push("MODEL_ENDPOINT");
  if (apiKey === null) invalid.push("MODEL_API_KEY");
  if (modelId === null) invalid.push("MODEL_ID");
  if (approvedRecipients === null) invalid.push("MODEL_APPROVED_RECIPIENTS");
  if (timeoutMs === null) invalid.push("MODEL_TIMEOUT_MS");
  if (maxOutputChars === null) invalid.push("MODEL_MAX_OUTPUT_CHARS");
  if (invalid.length > 0) throw new AssistantConfigError("invalid_configuration", ASSISTANT_ENV_NAMES.filter((name) => invalid.includes(name)));

  return {
    enabled: true as const,
    endpoint: endpoint as string,
    apiKey: new Secret(apiKey as string),
    modelId: modelId as string,
    approvedRecipients: Object.freeze(approvedRecipients as string[]),
    timeoutMs: timeoutMs as number,
    maxOutputChars: maxOutputChars as number,
  };
}

/**
 * ASSISTANT_RUN_RETENTION_DAYS alone, for the retention job, which needs nothing else. Required, plain digits, within
 * RUN_RETENTION_DAYS_BOUNDS; fails closed naming the variable, never its value.
 */
export function readRunRetentionDays(env: Readonly<Record<string, string | undefined>>): number {
  const raw = valueIn(env)("ASSISTANT_RUN_RETENTION_DAYS");
  if (raw === undefined) throw new AssistantConfigError("missing_configuration", ["ASSISTANT_RUN_RETENTION_DAYS"]);
  const days = limitValue(raw, RUN_RETENTION_DAYS_BOUNDS.max);
  if (days === null || days < RUN_RETENTION_DAYS_BOUNDS.min) throw new AssistantConfigError("invalid_configuration", ["ASSISTANT_RUN_RETENTION_DAYS"]);
  return days;
}

/**
 * Validates an EXTERNAL configuration: enabled, ASSISTANT_ENV=external, every model variable, exactly one approved recipient (fallback
 * recipients are undecided), the provider's output-token cap and wire format, every limit (per user and global) and the run retention. Fails closed, naming variables and never values. NOT used by
 * readAssistantConfig, which still refuses external mode: nothing but tests reaches this until that is deliberately changed.
 */
export function validateExternalEnv(env: Readonly<Record<string, string | undefined>>): ExternalAssistantConfig {
  if (env.ASSISTANT_ENABLED !== "true") throw new AssistantConfigError("assistant_disabled");
  if (env.ASSISTANT_ENV !== "external") throw new AssistantConfigError("invalid_configuration", ["ASSISTANT_ENV"]);
  const value = valueIn(env);
  const missingLimits = [...ASSISTANT_PROVIDER_ENV_NAMES, ...ASSISTANT_LIMIT_ENV_NAMES, ...ASSISTANT_RETENTION_ENV_NAMES].filter((name) => value(name) === undefined);
  const settings = readModelSettings(env);
  if (missingLimits.length > 0) throw new AssistantConfigError("missing_configuration", missingLimits);
  if (settings.approvedRecipients.length !== 1) throw new AssistantConfigError("invalid_configuration", ["MODEL_APPROVED_RECIPIENTS"]);
  const limits = {
    windowSeconds: limitValue(value("ASSISTANT_RATE_WINDOW_SECONDS") as string, RUN_LIMIT_CEILINGS.windowSeconds),
    maxRunsPerWindow: limitValue(value("ASSISTANT_MAX_RUNS_PER_WINDOW") as string, RUN_LIMIT_CEILINGS.maxRunsPerWindow),
    maxConcurrentRuns: limitValue(value("ASSISTANT_MAX_CONCURRENT_RUNS") as string, RUN_LIMIT_CEILINGS.maxConcurrentRuns),
    maxTokensPerWindow: limitValue(value("ASSISTANT_MAX_TOKENS_PER_WINDOW") as string, RUN_LIMIT_CEILINGS.maxTokensPerWindow),
    maxGlobalConcurrentRuns: limitValue(value("ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS") as string, RUN_LIMIT_CEILINGS.maxGlobalConcurrentRuns),
  };
  const maxOutputTokens = limitValue(value("MODEL_MAX_OUTPUT_TOKENS") as string, MAX_MODEL_OUTPUT_TOKENS);
  const wireFormat = value("MODEL_WIRE_FORMAT");
  const invalid: AssistantEnvName[] = [];
  if (maxOutputTokens === null) invalid.push("MODEL_MAX_OUTPUT_TOKENS");
  if (!isModelWireFormat(wireFormat)) invalid.push("MODEL_WIRE_FORMAT");
  if (limits.windowSeconds === null) invalid.push("ASSISTANT_RATE_WINDOW_SECONDS");
  if (limits.maxRunsPerWindow === null) invalid.push("ASSISTANT_MAX_RUNS_PER_WINDOW");
  if (limits.maxConcurrentRuns === null) invalid.push("ASSISTANT_MAX_CONCURRENT_RUNS");
  if (limits.maxTokensPerWindow === null) invalid.push("ASSISTANT_MAX_TOKENS_PER_WINDOW");
  if (limits.maxGlobalConcurrentRuns === null) invalid.push("ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS");
  // A person's own concurrency can never exceed everyone's: such a pair is a mistake, not a limit.
  if (limits.maxConcurrentRuns !== null && limits.maxGlobalConcurrentRuns !== null && limits.maxConcurrentRuns > limits.maxGlobalConcurrentRuns) {
    invalid.push("ASSISTANT_MAX_CONCURRENT_RUNS", "ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS");
  }
  let runRetentionDays: number | null = null;
  try {
    runRetentionDays = readRunRetentionDays(env);
  } catch {
    invalid.push("ASSISTANT_RUN_RETENTION_DAYS");
  }
  if (invalid.length > 0) throw new AssistantConfigError("invalid_configuration", invalid);
  return Object.freeze({
    ...settings,
    env: "external" as const,
    maxOutputTokens: maxOutputTokens as number,
    wireFormat: wireFormat as ModelWireFormat,
    limits: Object.freeze(limits as { [K in keyof AssistantRunLimits]: number }),
    runRetentionDays: runRetentionDays as number,
  });
}

/** The model limits a configuration implies: the per-call timeout, a total run budget of that times the model rounds, the output size and the recipients. */
export function policyFromConfig(config: AssistantConfig): ModelRunPolicy {
  if (!config.enabled) throw new AssistantConfigError("assistant_disabled");
  return {
    timeoutMs: config.timeoutMs,
    runBudgetMs: config.timeoutMs * MAX_ROUNDS,
    maxOutputChars: config.maxOutputChars,
    approvedRecipients: [...config.approvedRecipients],
  };
}
