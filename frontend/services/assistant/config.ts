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
export type AssistantEnvName = (typeof ASSISTANT_ENV_NAMES)[number];

export const ASSISTANT_CONFIG_ERROR_CODES = ["invalid_configuration", "missing_configuration", "real_data_mode_not_permitted", "assistant_disabled"] as const;
export type AssistantConfigErrorCode = (typeof ASSISTANT_CONFIG_ERROR_CODES)[number];

/** The configuration is unusable. It carries a code and the NAMES of the variables involved, never a value. */
export class AssistantConfigError extends Error {
  readonly code: AssistantConfigErrorCode;
  readonly variables: readonly AssistantEnvName[];
  constructor(code: AssistantConfigErrorCode, variables: readonly AssistantEnvName[] = []) {
    const names = variables.filter((name) => (ASSISTANT_ENV_NAMES as readonly string[]).includes(name));
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

export type AssistantConfig =
  | { enabled: false }
  | {
      enabled: true;
      env: "synthetic";
      endpoint: string;
      apiKey: Secret;
      modelId: string;
      approvedRecipients: readonly string[];
      timeoutMs: number;
      maxOutputChars: number;
    };

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

  const value = (name: AssistantEnvName): string | undefined => {
    const raw = env[name];
    return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
  };
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

  return Object.freeze({
    enabled: true as const,
    env: "synthetic" as const,
    endpoint: endpoint as string,
    apiKey: new Secret(apiKey as string),
    modelId: modelId as string,
    approvedRecipients: Object.freeze(approvedRecipients as string[]),
    timeoutMs: timeoutMs as number,
    maxOutputChars: maxOutputChars as number,
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
