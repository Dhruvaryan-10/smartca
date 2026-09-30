// The LAYERING of the assistant backend, pinned statically. PURE: it reads source files and imports nothing it inspects.
//
//   route (app/api/assistant/route.ts) -> http.ts -> service.ts -> authorization-store / access-plan / run-store (limits, audit)
//     -> external.ts -> ask.ts -> orchestrator (tools, egress filter) -> model guard (model.ts) -> provider.ts -> the driver -> network
//
// What is pinned: each entry point has exactly one caller above it, so no code can reach the provider, the tools or the consent check by
// a path that skips a layer; the lower layers import nothing above them (the provider never calls authorization, plans, the database,
// the service, the session or a route); and the provider key is revealed only where the authentication header is built.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const FRONTEND = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (rel: string) => strip(fs.readFileSync(path.join(FRONTEND, rel), "utf8"));

/** Every non-test source file under the application's source directories. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(FRONTEND, dir), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of ["app", "components", "hooks", "contexts", "services", "lib", "db", "scripts", "tax-engine"]) if (fs.existsSync(path.join(FRONTEND, dir))) walk(dir);
  return out;
}
const users = (symbol: RegExp, defined: string) => sources().filter((f) => f !== defined && symbol.test(code(f))).sort();
const imports = (rel: string) => [...code(rel).matchAll(/^\s*(?:import|export)\s[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]);

test("each layer has exactly one caller above it: nothing can skip the service, consent, the plan or the limits", () => {
  assert.deepEqual(users(/\bhandleAssistantHttp\b/, "services/assistant/http.ts"), ["app/api/assistant/route.ts"]);
  assert.deepEqual(users(/\bhandleAssistantRequest\b/, "services/assistant/service.ts"), ["services/assistant/http.ts"]);
  assert.deepEqual(users(/\baskExternal\b/, "services/assistant/external.ts"), ["services/assistant/service.ts"]);
  assert.deepEqual(users(/\bcreateProviderAdapter\b/, "services/assistant/provider.ts"), ["services/assistant/external.ts"]);
  assert.deepEqual(users(/\bfindAssistantAuthorization\b/, "services/assistant/authorization-store.ts"), ["services/assistant/consent-service.ts", "services/assistant/service.ts"]);
  assert.deepEqual(users(/\bcreatePostgresRunLimiter\b/, "services/assistant/run-store.ts"), ["services/assistant/service.ts"]);
  assert.deepEqual(users(/\bpurgeExpiredAssistantRuns\b/, "services/assistant/run-retention.ts"), ["scripts/assistant-purge-runs.ts"]);
  assert.deepEqual(users(/\bchatCompletionsDriver\b/, "services/assistant/provider-chat-completions.ts"), ["services/assistant/http.ts"]);
  // Below the external entry point: the run, the tools and the egress filter are reached only through the orchestrator. askAssistant
  // without `visibleClasses` sends tool results unfiltered, so its only callers are the external path (which always passes the plan's
  // classes) and the synthetic path (fixture tools, no real data); a new caller must be a deliberate, reviewed change.
  assert.deepEqual(users(/\baskAssistant\b/, "services/assistant/ask.ts"), ["services/assistant/external.ts", "services/assistant/synthetic.ts"]);
  assert.deepEqual(users(/\brunAssistant\b/, "services/assistant/orchestrator.ts"), ["services/assistant/ask.ts"]);
  // The synthetic tool set borrows only the TYPE (erased at runtime; the hermetic test pins that it cannot load the real tools).
  assert.deepEqual(users(/\b(assistantTools|createAssistantTools)\b/, "services/assistant/tools.ts"), ["services/assistant/orchestrator.ts", "services/assistant/synthetic-tools.ts"]);
  assert.deepEqual(imports("services/assistant/synthetic-tools.ts").filter((s) => s === "./tools"), ["./tools"]);
  assert.match(code("services/assistant/synthetic-tools.ts"), /^import type \{ createAssistantTools, ToolResult \} from "\.\/tools";$/m);
  assert.deepEqual(users(/\bfilterToolResult\b/, "lib/assistant/egress-filter.ts"), ["services/assistant/orchestrator.ts"]);
  assert.deepEqual(users(/\bwithModelGuard\b/, "services/assistant/model.ts"), ["services/assistant/orchestrator.ts"]);
});

test("the external path always applies the access plan's egress classes and tools: askExternal passes them from one plan", () => {
  const external = code("services/assistant/external.ts");
  assert.match(external, /allowedTools: plan\.allowedTools,\s*visibleClasses: plan\.visibleClasses,/);
  assert.match(external, /approvedRecipients: \[\.\.\.plan\.approvedRecipients\]/);
});

test("the lower layers import nothing above them", () => {
  const upper = /(^|\/)(http|service|external|authorization-store|run-store|run-retention|session|access-plan|authorization)$|@\/db|\.\.\/db|\/db\/|next-auth|^next(\/|$)|^@\/app|\/app\//;
  // The model and provider layer: no authorization, plan, consent, limits, audit, service, session, database, framework or route.
  for (const lower of ["services/assistant/model.ts", "services/assistant/provider.ts", "services/assistant/provider-chat-completions.ts"]) {
    const offending = imports(lower).filter((specifier) => upper.test(specifier));
    assert.deepEqual(offending, [], `${lower} imports ${offending.join(", ")}`);
  }
  // The shared contracts (configuration, public errors, events) reach no database, service, session, framework or route either.
  for (const shared of ["services/assistant/config.ts", "services/assistant/api-contract.ts", "services/assistant/events.ts"]) {
    assert.deepEqual(imports(shared).filter((s) => /(^|\/)(http|service|external|authorization-store|run-store|run-retention|session)$|@\/db|\.\.\/db|next/.test(s)), [], shared);
  }
  // The pure policy layer (profiles, authorization, access plan, egress, limits) never imports a service.
  for (const file of fs.readdirSync(path.join(FRONTEND, "lib/assistant")).filter((f) => f.endsWith(".ts")).map((f) => `lib/assistant/${f}`)) {
    assert.deepEqual(imports(file).filter((s) => /services\/|@\/db|\.\.\/db|next/.test(s)), [], file);
  }
});

test("the provider key is revealed only where the authentication header is built (and by the synthetic leak fixture)", () => {
  assert.deepEqual(users(/\.reveal\(\)/, "services/assistant/config.ts"), ["services/assistant/provider-chat-completions.ts", "services/assistant/synthetic-model.ts"]);
  const driver = code("services/assistant/provider-chat-completions.ts");
  assert.deepEqual([...driver.matchAll(/^.*\.reveal\(\).*$/gm)].map((m) => m[0].trim()), ["authHeaders: (apiKey: Secret) => ({ authorization: `Bearer ${apiKey.reveal()}` }),"]);
});

test("the HTTP boundary takes the user from the session reader only, and no request field can set a dependency", () => {
  const http = code("services/assistant/http.ts");
  assert.match(http, /getSessionUserId: \(\) => Promise<string \| null>/);
  // The service is given the session user and the body; the dependencies come from `deps` (server code) or the server defaults.
  assert.match(http, /handleAssistantRequest\(userId === null \? null : \{ userId \}, body, \{/);
  assert.doesNotMatch(http, /body\.(config|driver|limiter|userId|profile|recipient|model|provider)|searchParams|headers\.get\("(x-user|authorization)/i);
  assert.deepEqual([...new Set(imports("services/assistant/http.ts"))].sort(), ["./api-contract", "./ask", "./config", "./events", "./model", "./provider", "./provider-chat-completions", "./service", "@/lib/assistant/run-limits"].sort());
});

test("the consent API: route -> consent-http -> consent-service -> consent terms (access plan) and the authorization store, nothing skipped", () => {
  assert.deepEqual(users(/\bhandleConsentHttp\b/, "services/assistant/consent-http.ts"), ["app/api/assistant/consent/route.ts"]);
  assert.deepEqual(users(/\bhandleConsentDisclosureHttp\b/, "services/assistant/consent-http.ts"), ["app/api/assistant/consent/disclosure/route.ts"]);
  for (const op of ["getConsentDisclosure", "getConsentStatus", "grantConsent", "revokeConsent"]) {
    assert.deepEqual(users(new RegExp(`\\b${op}\\b`), "services/assistant/consent-service.ts"), ["services/assistant/consent-http.ts"], op);
  }
  // Grants and revocations are written only by the consent service; the run path only reads.
  assert.deepEqual(users(/\bgrantAssistantAuthorization\b/, "services/assistant/authorization-store.ts"), ["services/assistant/consent-service.ts"]);
  assert.deepEqual(users(/\brevokeAllAssistantAuthorizations\b/, "services/assistant/authorization-store.ts"), ["services/assistant/consent-service.ts"]);
  assert.deepEqual(users(/\brevokeAssistantAuthorization\b/, "services/assistant/authorization-store.ts"), []);
  assert.deepEqual(users(/\b(consentTermsFor|assessConsent)\b/, "lib/assistant/consent-terms.ts"), ["services/assistant/consent-service.ts"]);
  // The HTTP layer, the contract and the service reach the database only through the store; the routes only through the HTTP layer.
  const database = /@\/db|\.\.\/db|\/db\/|drizzle-orm|^pg$/;
  for (const file of ["services/assistant/consent-http.ts", "services/assistant/consent-service.ts", "services/assistant/consent-contract.ts", "app/api/assistant/consent/route.ts", "app/api/assistant/consent/disclosure/route.ts"]) {
    assert.deepEqual(imports(file).filter((s) => database.test(s)), [], file);
  }
  assert.deepEqual([...new Set(imports("services/assistant/consent-http.ts"))].sort(), ["../errors", "./config", "./consent-contract", "./consent-service", "./http"].sort());
  for (const route of ["app/api/assistant/consent/route.ts", "app/api/assistant/consent/disclosure/route.ts"]) {
    assert.deepEqual([...new Set(imports(route))].sort(), ["@/services/assistant/consent-http", "@/services/session"], route);
  }
  // No request field, query or header can name who, what or for how long; the profile is the code's.
  assert.doesNotMatch(code("services/assistant/consent-http.ts"), /body\.|searchParams|headers\.get/);
  assert.match(code("services/assistant/consent-service.ts"), /consentTermsFor\(EXTERNAL_PROFILE, \{ userId, recipient, now:/);
});
