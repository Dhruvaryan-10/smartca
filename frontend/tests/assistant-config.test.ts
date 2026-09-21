// Phase 6K: the assistant's server-only configuration (services/assistant/config.ts). PURE: it reads a plain object, so no test
// touches the real environment except the one that checks the default reads process.env (and restores it).
//
//   ASSISTANT_ENABLED=false   ASSISTANT_ENV=synthetic   MODEL_ENDPOINT=   MODEL_API_KEY=   MODEL_ID=
//   MODEL_APPROVED_RECIPIENTS=   MODEL_TIMEOUT_MS=   MODEL_MAX_OUTPUT_CHARS=
//
// What is pinned: it is off unless explicitly "true"; only ASSISTANT_ENV=synthetic is valid, and anything else (a real-data mode
// included) fails closed; every other variable is required and validated, with hard ceilings; an error names the VARIABLES that
// are wrong and never a value; and the key is held in a wrapper that cannot be printed, serialised or inspected by accident.
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_ENV_NAMES, AssistantConfigError, Secret, policyFromConfig, readAssistantConfig } from "../services/assistant/config";
import { MAX_MESSAGE_CHARS, MAX_MODEL_TIMEOUT_MS } from "../services/assistant/model";
import { MAX_ROUNDS } from "../services/assistant/orchestrator";

const FRONTEND = path.resolve(__dirname, "..");
const KEY = "test-key-NOT-A-REAL-SECRET-0001";
const GOOD: Record<string, string> = {
  ASSISTANT_ENABLED: "true",
  ASSISTANT_ENV: "synthetic",
  MODEL_ENDPOINT: "https://synthetic.invalid/v1",
  MODEL_API_KEY: KEY,
  MODEL_ID: "fixture-v1",
  MODEL_APPROVED_RECIPIENTS: "synthetic-local",
  MODEL_TIMEOUT_MS: "2000",
  MODEL_MAX_OUTPUT_CHARS: "5000",
};
const without = (...names: string[]) => Object.fromEntries(Object.entries(GOOD).filter(([k]) => !names.includes(k)));
const rejection = (env: Record<string, string | undefined>): AssistantConfigError => {
  try {
    readAssistantConfig(env);
  } catch (error) {
    assert.ok(error instanceof AssistantConfigError, `expected an AssistantConfigError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the configuration to be refused" });
};

// --- off by default -----------------------------------------------------------------------------------------------------------

test("the assistant is off unless ASSISTANT_ENABLED is exactly true, and a disabled configuration reads nothing else", () => {
  for (const env of [{}, { ASSISTANT_ENABLED: "" }, { ASSISTANT_ENABLED: "false" }, { ASSISTANT_ENABLED: "false", ASSISTANT_ENV: "real", MODEL_TIMEOUT_MS: "garbage" }]) {
    const config = readAssistantConfig(env);
    assert.deepEqual(config, { enabled: false });
    assert.ok(Object.isFrozen(config));
  }
});

test("an ambiguous ASSISTANT_ENABLED is refused loudly, not read as off or on", () => {
  for (const value of ["1", "yes", "TRUE", "True", " true", "true ", "on", "enabled"]) {
    const error = rejection({ ...GOOD, ASSISTANT_ENABLED: value });
    assert.equal(error.code, "invalid_configuration", value);
    assert.deepEqual(error.variables, ["ASSISTANT_ENABLED"]);
  }
});

test("a complete synthetic configuration is read: typed, normalised and frozen", () => {
  const config = readAssistantConfig({ ...GOOD, MODEL_APPROVED_RECIPIENTS: "synthetic-local, second-approved ,synthetic-local" });
  assert.equal(config.enabled, true);
  if (!config.enabled) return;
  assert.equal(config.env, "synthetic");
  assert.equal(config.endpoint, "https://synthetic.invalid/v1");
  assert.equal(config.modelId, "fixture-v1");
  assert.deepEqual(config.approvedRecipients, ["synthetic-local", "second-approved"], "trimmed and de-duplicated, in order");
  assert.equal(config.timeoutMs, 2000);
  assert.equal(config.maxOutputChars, 5000);
  assert.ok(config.apiKey instanceof Secret);
  assert.equal(config.apiKey.reveal(), KEY);
  assert.ok(Object.isFrozen(config));
});

// --- only synthetic mode is valid --------------------------------------------------------------------------------------------

test("only ASSISTANT_ENV=synthetic is valid: a real-data mode, or any other value, fails closed, before anything else is checked", () => {
  for (const value of ["real", "production", "prod", "live", "development", "Synthetic", "SYNTHETIC", "synthetic ", " synthetic", "synthetic,real", "true", "1"]) {
    const error = rejection({ ...GOOD, ASSISTANT_ENV: value });
    assert.equal(error.code, "real_data_mode_not_permitted", value);
    assert.deepEqual(error.variables, ["ASSISTANT_ENV"]);
  }
  // Even with everything else missing, a real-data request is the answer given: the mode is checked first.
  assert.equal(rejection({ ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "real" }).code, "real_data_mode_not_permitted");
  // Unset is a missing variable, not a default: there is no implicit mode.
  assert.equal(rejection(without("ASSISTANT_ENV")).code, "missing_configuration");
  assert.equal(rejection({ ...GOOD, ASSISTANT_ENV: "" }).code, "missing_configuration");
});

// --- missing configuration fails closed -----------------------------------------------------------------------------------

test("every other variable is required: each one missing (or blank) fails closed, naming that variable and nothing else", () => {
  for (const name of ASSISTANT_ENV_NAMES.filter((n) => n !== "ASSISTANT_ENABLED" && n !== "ASSISTANT_ENV")) {
    for (const env of [without(name), { ...GOOD, [name]: "" }, { ...GOOD, [name]: "   " }]) {
      const error = rejection(env);
      assert.equal(error.code, "missing_configuration", name);
      assert.deepEqual(error.variables, [name]);
      assert.match(error.message, new RegExp(name));
    }
  }
  const several = rejection({ ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "synthetic" });
  assert.equal(several.code, "missing_configuration");
  assert.deepEqual([...several.variables], ["MODEL_ENDPOINT", "MODEL_API_KEY", "MODEL_ID", "MODEL_APPROVED_RECIPIENTS", "MODEL_TIMEOUT_MS", "MODEL_MAX_OUTPUT_CHARS"], "all of them are named, in a fixed order");
});

test("invalid values are refused with hard ceilings, and the error names the variable, never its value", () => {
  const cases: Array<[string, string]> = [
    ["MODEL_ENDPOINT", "http://synthetic.invalid/v1"], ["MODEL_ENDPOINT", "ftp://synthetic.invalid"], ["MODEL_ENDPOINT", "not a url"], ["MODEL_ENDPOINT", "https://"],
    ["MODEL_ENDPOINT", "https://user:hunter2-PASSWORD@synthetic.invalid/v1"],
    ["MODEL_API_KEY", "a key with spaces and a SECRET-TAIL"], ["MODEL_API_KEY", "line\nbreak-SECRET-TAIL"], ["MODEL_API_KEY", "k".repeat(513)],
    ["MODEL_ID", "has space"], ["MODEL_ID", "-leading"], ["MODEL_ID", "m".repeat(129)],
    ["MODEL_APPROVED_RECIPIENTS", "a b"], ["MODEL_APPROVED_RECIPIENTS", ","], ["MODEL_APPROVED_RECIPIENTS", "ok,,ok2"], ["MODEL_APPROVED_RECIPIENTS", Array.from({ length: 21 }, (_, i) => `r${i}`).join(",")],
    ["MODEL_TIMEOUT_MS", "0"], ["MODEL_TIMEOUT_MS", "-1"], ["MODEL_TIMEOUT_MS", "1.5"], ["MODEL_TIMEOUT_MS", "abc"], ["MODEL_TIMEOUT_MS", "1e3"], ["MODEL_TIMEOUT_MS", " 20"], ["MODEL_TIMEOUT_MS", String(MAX_MODEL_TIMEOUT_MS + 1)],
    ["MODEL_MAX_OUTPUT_CHARS", "0"], ["MODEL_MAX_OUTPUT_CHARS", "12.5"], ["MODEL_MAX_OUTPUT_CHARS", String(MAX_MESSAGE_CHARS + 1)], ["MODEL_MAX_OUTPUT_CHARS", "lots"],
  ];
  for (const [name, value] of cases) {
    const error = rejection({ ...GOOD, [name]: value });
    assert.equal(error.code, "invalid_configuration", `${name}=${value.slice(0, 20)}`);
    assert.deepEqual(error.variables, [name]);
    for (const secret of ["hunter2", "SECRET-TAIL", KEY]) assert.equal(`${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${inspect(error, { depth: 6 })}`.includes(secret), false, `${name}: the value must not appear`);
  }
  // The largest values that ARE allowed.
  assert.doesNotThrow(() => readAssistantConfig({ ...GOOD, MODEL_TIMEOUT_MS: String(MAX_MODEL_TIMEOUT_MS), MODEL_MAX_OUTPUT_CHARS: String(MAX_MESSAGE_CHARS) }));
});

test("several invalid values are all named, and a bad value next to a good key still never reveals the key", () => {
  const error = rejection({ ...GOOD, MODEL_TIMEOUT_MS: "0", MODEL_ID: "bad id" });
  assert.deepEqual([...error.variables], ["MODEL_ID", "MODEL_TIMEOUT_MS"]);
  assert.equal(`${error.message}${error.stack}`.includes(KEY), false);
});

// --- the key is never printable ---------------------------------------------------------------------------------------------------

test("the API key cannot be printed, serialised, inspected or enumerated by accident; only reveal() returns it", () => {
  const config = readAssistantConfig(GOOD);
  assert.equal(config.enabled, true);
  if (!config.enabled) return;
  const key = config.apiKey;
  for (const rendered of [String(key), `${key}`, JSON.stringify(key), JSON.stringify(config), JSON.stringify({ key }), inspect(key), inspect(config, { depth: 6 }), inspect({ nested: { config } }, { depth: 9 }), `${JSON.stringify(Object.keys(key))}${JSON.stringify(Object.getOwnPropertyNames(key))}`]) {
    assert.equal(rendered.includes(KEY), false, "the key must not be in any rendering");
  }
  assert.match(String(key), /redacted/i);
  assert.equal(key.reveal(), KEY);
  assert.equal(JSON.stringify(structuredClone({ ...config, apiKey: undefined })).includes(KEY), false);
});

// --- turning a configuration into limits ------------------------------------------------------------------------------------

test("policyFromConfig turns the configuration into the model limits: per-call timeout, a total budget of that times the rounds, output size, recipients", () => {
  const config = readAssistantConfig({ ...GOOD, MODEL_APPROVED_RECIPIENTS: "synthetic-local,other-approved" });
  assert.deepEqual(policyFromConfig(config), { timeoutMs: 2000, runBudgetMs: 2000 * MAX_ROUNDS, maxOutputChars: 5000, approvedRecipients: ["synthetic-local", "other-approved"] });
  assert.throws(() => policyFromConfig(readAssistantConfig({})), (e: unknown) => e instanceof AssistantConfigError && e.code === "assistant_disabled");
});

test("the default reads process.env (and only when asked), and a real-data mode there fails closed too", () => {
  const before = { ...process.env };
  try {
    delete process.env.ASSISTANT_ENABLED;
    assert.deepEqual(readAssistantConfig(), { enabled: false });
    process.env.ASSISTANT_ENABLED = "true";
    process.env.ASSISTANT_ENV = "real";
    assert.throws(() => readAssistantConfig(), (e: unknown) => e instanceof AssistantConfigError && e.code === "real_data_mode_not_permitted");
  } finally {
    for (const name of ASSISTANT_ENV_NAMES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});

// --- the documented names ---------------------------------------------------------------------------------------------------------

test(".env.example documents exactly these variables, off and synthetic by default, with no value that could be a secret", () => {
  const lines = fs.readFileSync(path.join(FRONTEND, ".env.example"), "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
  const values = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  for (const name of ASSISTANT_ENV_NAMES) assert.ok(name in values, `${name} is documented`);
  assert.equal(values.ASSISTANT_ENABLED, "false");
  assert.equal(values.ASSISTANT_ENV, "synthetic");
  for (const name of ["MODEL_ENDPOINT", "MODEL_API_KEY", "MODEL_ID", "MODEL_APPROVED_RECIPIENTS", "MODEL_TIMEOUT_MS", "MODEL_MAX_OUTPUT_CHARS"]) assert.equal(values[name], "", `${name} has no value in the example`);
  assert.doesNotMatch(fs.readFileSync(path.join(FRONTEND, ".env.example"), "utf8"), /NEXT_PUBLIC_/, "nothing here is exposed to the browser");
});

test("the configuration module is server-side only: it reads exactly these variables, prints and fetches nothing, and nothing under app/ imports it", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const source = strip(fs.readFileSync(path.join(FRONTEND, "services/assistant/config.ts"), "utf8"));
  const read = [...source.matchAll(/(?:\benv\.|["'])((?:ASSISTANT|MODEL)_[A-Z_]+)\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(read)].sort(), [...ASSISTANT_ENV_NAMES].sort(), "the variables it reads are exactly the documented ones");
  assert.doesNotMatch(source, /\bconsole\s*\.|fetch\(|https?:\/\/|NEXT_PUBLIC|from\s+["'](?:@\/db|\.\.\/db|next|next-auth)/, "no logging, no network, no public variable, no database");
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(FRONTEND, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(tsx?|jsx?)$/.test(entry.name) && /assistant\/(config|synthetic|ask|model|orchestrator)/.test(fs.readFileSync(path.join(FRONTEND, rel), "utf8"))) importers.push(rel);
    }
  };
  for (const dir of ["app", "components", "hooks", "contexts"]) if (fs.existsSync(path.join(FRONTEND, dir))) walk(dir);
  assert.deepEqual(importers, [], "no page, route or component imports the assistant");
});
