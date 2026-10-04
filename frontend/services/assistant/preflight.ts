// THE PRODUCTION PREFLIGHT for the assistant's external mode (docs/decisions/0004): checks that a deployment's environment and database
// are ready for external mode WITHOUT enabling it, contacting the provider, or printing any value. Run by an operator through
// `npm run assistant:preflight` (scripts/assistant-preflight.ts, which supplies the database probe); nothing in the request path calls it.
//
//   1. external configuration   validateExternalEnv(env) with ASSISTANT_ENV=external: every variable present and valid, one recipient
//   2. provider target          readProviderTarget: the model id is a plain identifier, the token cap within bounds
//   3. wire format              the driver registry can build the driver for MODEL_WIRE_FORMAT (no call is made)
//   4. not a placeholder        the key and endpoint are not the documentation's placeholders or a reserved test host
//   5. database                 every migration in drizzle/meta/_journal.json is applied, and the assistant tables exist
//   6. consent inventory        the egress inventory fingerprint in force, which every grant must name (ADR 0002)
//   7. activation gate          whether readAssistantConfig produces an external configuration from this environment, i.e. whether a
//                               deployment with it would answer through the provider. Reported, not failed.
//
// Every detail is a code, a count, a variable NAME or the inventory fingerprint (public: it is shown in the consent disclosure). Never a
// key, endpoint, model id, database address or limit value.
import { AssistantConfigError, readAssistantConfig, validateExternalEnv } from "./config";
import type { ExternalAssistantConfig } from "./config";
import { readProviderTarget } from "./provider";
import { providerDriverFor } from "./provider-registry";
import { fingerprintInventory } from "@/lib/assistant/egress-disclosure";

export type PreflightCheck = Readonly<{ name: string; ok: boolean; detail: string }>;
export type PreflightReport = Readonly<{ ready: boolean; externalModeActive: boolean; checks: readonly PreflightCheck[] }>;

/** What the database probe reports: counts and table names only. */
export type PreflightDatabase = Readonly<{ migrationsApplied: number; migrationsExpected: number; missingTables: readonly string[] }>;

/** The tables the external path needs (migrations 0004 and 0005). */
export const ASSISTANT_TABLES = ["assistant_authorizations", "assistant_runs"] as const;

/** Key text that only a placeholder or test value has. Lower-cased comparison; a real provider key contains none of these. */
const PLACEHOLDER_KEY = /placeholder|not-a-real|changeme|change-me|replace|example|dummy|your[-_]?key|^x+$|^test[-_]|^sk-x+$/i;
/** Hosts reserved for documentation and testing (RFC 2606, RFC 6761), and loopback: no production provider lives there. */
const RESERVED_HOST = /(^|\.)(invalid|test|example|localhost)$|(^|\.)example\.(com|net|org)$|^127\.|^\[?::1\]?$/i;

function describe(error: unknown): string {
  if (error instanceof AssistantConfigError) return error.variables.length > 0 ? `${error.code}: ${error.variables.join(", ")}` : error.code;
  return error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "failed";
}

/**
 * Runs every check against `env` (process.env in the script) and the database probe's answer. Pure apart from the probe, which the
 * caller runs; a probe failure is reported as a failed check, never thrown, and its message is not kept.
 */
export async function runAssistantPreflight(env: Readonly<Record<string, string | undefined>>, probeDatabase: () => Promise<PreflightDatabase>): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push(Object.freeze({ name, ok, detail }));

  // 1-4: the configuration, read exactly as an external deployment will be.
  let config: ExternalAssistantConfig | null = null;
  try {
    config = validateExternalEnv(env);
    add("external configuration", true, "every variable present and valid");
  } catch (error) {
    add("external configuration", false, describe(error));
  }
  if (config !== null) {
    try {
      readProviderTarget(config);
      add("provider target", true, "one approved recipient; model id and output-token cap accepted");
    } catch (error) {
      add("provider target", false, describe(error));
    }
    try {
      providerDriverFor(config);
      add("wire format", true, `driver available for ${config.wireFormat}`);
    } catch (error) {
      add("wire format", false, describe(error));
    }
    const placeholders: string[] = [];
    // The raw variable, already validated above: the Secret is never revealed outside the authentication header (a layering test pins it).
    if (PLACEHOLDER_KEY.test(String(env.MODEL_API_KEY ?? "").trim())) placeholders.push("MODEL_API_KEY");
    if (RESERVED_HOST.test(new URL(config.endpoint).hostname)) placeholders.push("MODEL_ENDPOINT");
    add("not a placeholder", placeholders.length === 0, placeholders.length === 0 ? "key and endpoint are not placeholder or test values" : `placeholder or test value: ${placeholders.join(", ")}`);
  }

  // 5: the database.
  try {
    const db = await probeDatabase();
    const migrated = db.migrationsApplied >= db.migrationsExpected;
    add("database migrations", migrated, `${db.migrationsApplied} of ${db.migrationsExpected} applied`);
    add("assistant tables", db.missingTables.length === 0, db.missingTables.length === 0 ? `present: ${ASSISTANT_TABLES.join(", ")}` : `missing: ${db.missingTables.join(", ")}`);
  } catch (error) {
    add("database", false, `the database could not be checked (${describe(error)})`);
  }

  // 6: the inventory every consent grant must name.
  add("consent inventory", true, `egress inventory in force: ${fingerprintInventory()}; grants naming any other are refused as consent_outdated`);

  // 7: the activation gate, reported and never changed here.
  let externalModeActive = false;
  try {
    const live = readAssistantConfig(env);
    externalModeActive = live.enabled && (live as { env?: string }).env === "external";
  } catch {
    externalModeActive = false;
  }
  checks.push(Object.freeze({ name: "activation gate", ok: true, detail: externalModeActive ? "external mode is ACTIVE" : "readAssistantConfig does not produce an external configuration from this environment" }));

  return Object.freeze({ ready: checks.every((c) => c.ok), externalModeActive, checks: Object.freeze(checks) });
}
