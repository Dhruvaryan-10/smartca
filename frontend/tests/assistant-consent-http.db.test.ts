// The consent API (services/assistant/consent-http.ts, behind the routes under app/api/assistant/consent/), end to end against the local PostgreSQL:
//
//   Request -> session user -> (grant: body, strictly) -> consent service -> configuration -> consent terms (access plan) -> store
//
// and its integration with the assistant's own run path (services/assistant/http.ts): a grant made here is the one a run finds, and a
// revocation made here is the one a run refuses. Throwaway users, deleted after each test; no real provider, no network.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { assistantAuthorizations, assistantRuns } from "../db/schema";
import { MAX_CONSENT_BODY_BYTES, handleConsentDisclosureHttp, handleConsentHttp } from "../services/assistant/consent-http";
import type { ConsentHttpDeps } from "../services/assistant/consent-http";
import { handleAssistantHttp } from "../services/assistant/http";
import { findAssistantAuthorization } from "../services/assistant/authorization-store";
import { EXTERNAL_PROFILE } from "../services/assistant/external";
import { validateExternalEnv } from "../services/assistant/config";
import type { AssistantConfig } from "../services/assistant/config";
import { CONSENT_VALIDITY_DAYS, CONSENT_VALIDITY_MS, consentTermsFor } from "../lib/assistant/consent-terms";
import { fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import { deleteTestUser, makeTestUser } from "./helpers";
import { testProvider } from "./helpers-provider";
import type { WireStep } from "./helpers-provider";

const KEY = "test-key-NOT-A-REAL-SECRET-0009";
const ENDPOINT = "https://provider.invalid/v1/chat/completions";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const ENV: Record<string, string> = {
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: "fixture-model-1",
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "3000", MODEL_MAX_OUTPUT_CHARS: "20000",
  ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "20", ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000",
  ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", ASSISTANT_RUN_RETENTION_DAYS: "400",
};
const CONFIG: AssistantConfig = validateExternalEnv(ENV);
const VERSION = fingerprintInventory();
const GRANT = { consent: "granted", inventoryVersion: VERSION };
const done: WireStep = { reply: { kind: "text", text: "The engine computed the figures above." }, inputTokens: 150, outputTokens: 12 };

async function withUsers(n: number, work: (ids: string[]) => Promise<void>) {
  const users = await Promise.all(Array.from({ length: n }, (_, i) => makeTestUser(`assistant-consent-${i}`)));
  try {
    await work(users.map((u) => u.id));
  } finally {
    for (const u of users) await deleteTestUser(u.id);
  }
}
const rowsOf = (userId: string) => db.select().from(assistantAuthorizations).where(eq(assistantAuthorizations.userId, userId));

function request(method: string, body?: unknown, init: { contentType?: string | null; raw?: BodyInit; path?: string } = {}) {
  const headers: Record<string, string> = init.contentType === null ? {} : { "content-type": init.contentType ?? "application/json" };
  const hasBody = init.raw !== undefined || body !== undefined;
  return new Request(`http://localhost/api/assistant/consent${init.path ?? ""}`, { method, headers, ...(hasBody ? { body: init.raw ?? JSON.stringify(body), duplex: "half" } : {}) } as RequestInit);
}
function countingStream(text: string) {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.enqueue(new TextEncoder().encode(text)); c.close(); } }, { highWaterMark: 0 });
  return { stream, pulls: () => pulls };
}

type Deps = Partial<ConsentHttpDeps> & { userId?: string | null };
async function call(handler: typeof handleConsentHttp, req: Request, deps: Deps = {}) {
  const { userId, ...rest } = deps;
  const response = await handler(req, { getSessionUserId: async () => userId ?? null, config: CONFIG, now: () => NOW, ...rest });
  const text = await response.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, headers: response.headers, body: (text === "" ? null : JSON.parse(text)) as any, text };
}
const disclosure = (deps: Deps = {}) => call(handleConsentDisclosureHttp, request("GET", undefined, { path: "/disclosure" }), deps);
const status = (deps: Deps = {}) => call(handleConsentHttp, request("GET"), deps);
const grant = (body: unknown, deps: Deps = {}, init: Parameters<typeof request>[2] = {}) => call(handleConsentHttp, request("POST", body, init), deps);
const revoke = (deps: Deps = {}) => call(handleConsentHttp, request("DELETE"), deps);
const codeOf = (r: { body: { ok: boolean; error?: { code: string } } }) => (r.body.ok ? "ok" : r.body.error?.code);

/** Nothing internal in a response: no key, endpoint, database URL, auth secret, row id, user id, SQL or stack. */
function noInternalsIn(text: string, ...more: string[]) {
  for (const s of [KEY, ENDPOINT, process.env.DATABASE_URL, process.env.AUTH_SECRET, ...more].filter((v): v is string => typeof v === "string" && v.length > 0)) {
    assert.equal(text.includes(s), false, `leaked ${s.slice(0, 12)}…`);
  }
  assert.doesNotMatch(text, /select |insert |update |assistant_authorizations|revoked_?at|created_?at|format_?version|user_?id|authorization_?id|\bat .*\.ts:\d+/i);
}

// --- authentication ---------------------------------------------------------------------------------------------------------------

test("unauthenticated: every operation is 401 not_authenticated, the grant body is never read, and nothing is stored", async () => {
  for (const reader of [async () => null, async () => "", async () => "   ", async () => { throw new Error(`session store down: ${process.env.DATABASE_URL}`); }]) {
    const deps = { getSessionUserId: reader as () => Promise<string | null> };
    const counted = countingStream(JSON.stringify(GRANT));
    const results = [
      await disclosure(deps),
      await status(deps),
      await call(handleConsentHttp, request("POST", undefined, { raw: counted.stream }), deps),
      await revoke(deps),
    ];
    for (const r of results) {
      assert.deepEqual([r.status, codeOf(r)], [401, "not_authenticated"]);
      assert.equal(r.headers.get("cache-control"), "no-store");
      noInternalsIn(r.text);
    }
    assert.equal(counted.pulls(), 0, "the body is not read without a session");
  }
});

test("only GET, POST and DELETE are served (and only GET for the disclosure)", async () => {
  await withUsers(1, async ([u]) => {
    for (const method of ["PUT", "PATCH"]) assert.equal((await call(handleConsentHttp, request(method, GRANT), { userId: u })).status, 405);
    for (const method of ["POST", "DELETE"]) assert.equal((await call(handleConsentDisclosureHttp, request(method, GRANT, { path: "/disclosure" }), { userId: u })).status, 405);
    assert.deepEqual(await rowsOf(u), []);
  });
});

// --- disclosure -------------------------------------------------------------------------------------------------------------------

test("disclosure: the signed-in person gets the server's disclosure, derived from the inventory through the access plan", async () => {
  await withUsers(1, async ([u]) => {
    const r = await disclosure({ userId: u });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["disclosure", "ok"]);
    assert.deepEqual(Object.keys(r.body.disclosure).sort(), ["egress", "recipient", "validForDays"]);
    assert.equal(r.body.disclosure.recipient, RECIPIENT);
    assert.equal(r.body.disclosure.validForDays, CONSENT_VALIDITY_DAYS);
    const terms = consentTermsFor(EXTERNAL_PROFILE, { userId: u, recipient: RECIPIENT, now: NOW }, [RECIPIENT]);
    assert.deepEqual(r.body.disclosure.egress, JSON.parse(JSON.stringify(terms.disclosure)));
    assert.equal(r.body.disclosure.egress.inventoryVersion, VERSION);
    assert.deepEqual(r.body.disclosure.egress.visibleClasses, [...terms.dataClasses]);
    noInternalsIn(r.text, u);
  });
});

test("disclosure and grant fail closed, with a fixed code, when the assistant is not configured for an external recipient", async () => {
  await withUsers(1, async ([u]) => {
    for (const [config, code, httpStatus] of [
      [{ enabled: false } as AssistantConfig, "assistant_unavailable", 503],
      [() => { throw new Error(`boom ${KEY} ${ENDPOINT}`); }, "internal_error", 500],
    ] as const) {
      for (const r of [await disclosure({ userId: u, config }), await status({ userId: u, config }), await grant(GRANT, { userId: u, config })]) {
        assert.deepEqual([r.status, codeOf(r)], [httpStatus, code]);
        noInternalsIn(r.text, u, "boom");
      }
    }
    assert.deepEqual(await rowsOf(u), []);
  });
});

// --- grant ------------------------------------------------------------------------------------------------------------------------

test("grant: the session user's consent is stored with the server's profile, recipient, classes, version and window", async () => {
  await withUsers(1, async ([u]) => {
    const r = await grant(GRANT, { userId: u });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, consent: { state: "active", valid: true, recipient: RECIPIENT, expiresAt: new Date(NOW + CONSENT_VALIDITY_MS).toISOString().replace(/\.\d{3}Z$/, "Z") } });
    const rows = await rowsOf(u);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.userId, u);
    assert.equal(row.profileId, EXTERNAL_PROFILE.id);
    assert.equal(row.recipient, RECIPIENT);
    assert.equal(row.consent, "granted");
    assert.equal(row.formatVersion, 1);
    assert.deepEqual(row.dataClasses, [...EGRESS_FIELD_CLASSES]);
    assert.equal(row.inventoryVersion, VERSION);
    assert.equal(row.issuedAt.getTime(), NOW);
    assert.equal(row.expiresAt.getTime() - row.issuedAt.getTime(), CONSENT_VALIDITY_MS);
    assert.equal(row.revokedAt, null);
    noInternalsIn(r.text, u, row.id);
  });
});

test("grant: missing, malformed, oversized or wrongly typed bodies are 400 invalid_request and store nothing", async () => {
  await withUsers(1, async ([u]) => {
    const cases = [
      await grant(undefined, { userId: u }),
      await grant(undefined, { userId: u }, { raw: "{not json" }),
      await grant(undefined, { userId: u }, { raw: new Uint8Array([0x7b, 0xff, 0x7d]) }),
      await grant(GRANT, { userId: u }, { contentType: "text/plain" }),
      await grant(GRANT, { userId: u }, { contentType: null }),
      await grant(GRANT, { userId: u }, { contentType: "application/x-www-form-urlencoded" }),
      await grant(undefined, { userId: u }, { raw: JSON.stringify({ ...GRANT, pad: "x".repeat(MAX_CONSENT_BODY_BYTES) }) }),
      await grant(null, { userId: u }),
      await grant([GRANT], { userId: u }),
      await grant({}, { userId: u }),
      await grant({ consent: "granted" }, { userId: u }),
      await grant({ ...GRANT, consent: true }, { userId: u }),
      await grant({ ...GRANT, consent: "not_granted" }, { userId: u }),
      await grant({ ...GRANT, extra: 1 }, { userId: u }),
    ];
    for (const r of cases) {
      assert.deepEqual([r.status, codeOf(r)], [400, "invalid_request"]);
      noInternalsIn(r.text, u);
    }
    assert.deepEqual(await rowsOf(u), []);
  });
});

test("grant: the body cannot set the user, profile, data classes, recipient, version or window; each attempt is refused", async () => {
  await withUsers(2, async ([a, b]) => {
    const injections: Record<string, unknown>[] = [
      { userId: b }, { user: b },
      { profileId: "full" }, { profileId: "synthetic" }, { profile: { id: "full", tools: [], classes: {} } },
      { dataClasses: ["user_financial_data"] }, { dataClasses: [...EGRESS_FIELD_CLASSES] },
      { recipient: RECIPIENT }, { recipient: "recipient-evil" }, { approvedRecipients: ["recipient-evil"] },
      { version: 2 }, { authorizationVersion: 1 }, { formatVersion: 99 },
      { expiresAt: "2999-01-01T00:00:00Z" }, { issuedAt: "2000-01-01T00:00:00Z" }, { validForDays: 36_500 }, { revokedAt: null },
    ];
    for (const injected of injections) {
      const r = await grant({ ...GRANT, ...injected }, { userId: a });
      assert.deepEqual([r.status, codeOf(r)], [400, "invalid_request"], JSON.stringify(injected));
    }
    // A bare replacement of the whole body with a crafted authorization is refused too.
    const crafted = { version: 1, authorizationId: "x", userId: b, profileId: "full", recipient: "recipient-evil", consent: "granted", dataClasses: [...EGRESS_FIELD_CLASSES], issuedAt: "2000-01-01T00:00:00Z", expiresAt: "2999-01-01T00:00:00Z" };
    assert.equal(codeOf(await grant(crafted, { userId: a })), "invalid_request");
    assert.deepEqual(await rowsOf(a), []);
    assert.deepEqual(await rowsOf(b), [], "another user's consent is never created");
  });
});

test("grant: acknowledging any disclosure but the current one is 409 disclosure_outdated and stores nothing", async () => {
  await withUsers(1, async ([u]) => {
    for (const inventoryVersion of ["inv1-00000000", "inv2-deadbeef", VERSION.toUpperCase()]) {
      const r = await grant({ consent: "granted", inventoryVersion }, { userId: u });
      assert.deepEqual([r.status, codeOf(r)], [409, "disclosure_outdated"]);
    }
    assert.deepEqual(await rowsOf(u), []);
  });
});

test("grant: the recipient is always the configuration's approved one, whatever the request", async () => {
  await withUsers(1, async ([u]) => {
    const other = validateExternalEnv({ ...ENV, MODEL_APPROVED_RECIPIENTS: "recipient-b" });
    const r = await grant(GRANT, { userId: u, config: other });
    assert.equal(r.body.consent.recipient, "recipient-b");
    const [row] = await rowsOf(u);
    assert.equal(row.recipient, "recipient-b");
    // A grant for recipient-b does not authorize recipient-a.
    assert.equal((await status({ userId: u })).body.consent.state, "none");
  });
});

// --- status -----------------------------------------------------------------------------------------------------------------------

test("status: a person sees only their own consent, as a minimal typed status, never a row", async () => {
  await withUsers(2, async ([a, b]) => {
    assert.deepEqual((await status({ userId: a })).body, { ok: true, consent: { state: "none", valid: false, recipient: RECIPIENT, expiresAt: null } });
    await grant(GRANT, { userId: a });
    const mine = await status({ userId: a });
    assert.equal(mine.status, 200);
    assert.deepEqual(Object.keys(mine.body.consent).sort(), ["expiresAt", "recipient", "state", "valid"]);
    assert.deepEqual([mine.body.consent.state, mine.body.consent.valid], ["active", true]);
    const [row] = await rowsOf(a);
    noInternalsIn(mine.text, a, row.id);
    // B sees nothing of A's.
    const theirs = await status({ userId: b });
    assert.deepEqual(theirs.body.consent, { state: "none", valid: false, recipient: RECIPIENT, expiresAt: null });
    noInternalsIn(theirs.text, a, b, row.id);
  });
});

test("status: an expired grant is reported as expired and not valid", async () => {
  await withUsers(1, async ([u]) => {
    await grant(GRANT, { userId: u });
    const later = await status({ userId: u, now: () => NOW + CONSENT_VALIDITY_MS });
    assert.deepEqual([later.body.consent.state, later.body.consent.valid], ["expired", false]);
  });
});

test("status: a grant for another egress inventory is outdated; granting the current disclosure restores active", async () => {
  await withUsers(1, async ([u]) => {
    await grant(GRANT, { userId: u });
    // As if the inventory had changed since the grant.
    await db.update(assistantAuthorizations).set({ inventoryVersion: "inv1-00000000" }).where(eq(assistantAuthorizations.userId, u));
    const stale = await status({ userId: u });
    assert.equal(stale.status, 200);
    assert.deepEqual([stale.body.consent.state, stale.body.consent.valid], ["outdated", false]);
    // Renewal is the ordinary flow: fetch the current disclosure, grant it with its inventoryVersion.
    const current = await disclosure({ userId: u });
    const renewed = await grant({ consent: "granted", inventoryVersion: current.body.disclosure.egress.inventoryVersion }, { userId: u });
    assert.deepEqual([renewed.status, renewed.body.consent.state, renewed.body.consent.valid], [200, "active", true]);
    assert.equal((await status({ userId: u })).body.consent.state, "active");
  });
});

// --- revoke -----------------------------------------------------------------------------------------------------------------------

test("revoke: a person withdraws their own consent; repeating it is safe; it is then reported as revoked", async () => {
  await withUsers(1, async ([u]) => {
    await grant(GRANT, { userId: u });
    const first = await revoke({ userId: u });
    assert.deepEqual([first.status, first.body], [200, { ok: true }]);
    const again = await revoke({ userId: u });
    assert.deepEqual([again.status, again.body], [200, { ok: true }]);
    assert.deepEqual((await status({ userId: u })).body.consent, { state: "revoked", valid: false, recipient: RECIPIENT, expiresAt: null });
    const rows = await rowsOf(u);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].revokedAt instanceof Date);
    // Revoking with nothing granted is safe too, and granting again works.
    assert.equal((await grant(GRANT, { userId: u })).body.consent.state, "active");
  });
});

test("revoke: one person cannot revoke another's consent", async () => {
  await withUsers(2, async ([a, b]) => {
    await grant(GRANT, { userId: a });
    assert.deepEqual((await revoke({ userId: b })).body, { ok: true });
    assert.equal((await status({ userId: a })).body.consent.state, "active");
    assert.equal((await rowsOf(a))[0].revokedAt, null);
    // A DELETE body naming someone is not read: it still revokes only the session user's.
    await call(handleConsentHttp, request("DELETE", { userId: a }), { userId: b });
    assert.equal((await status({ userId: a })).body.consent.state, "active");
  });
});

test("revoke works even while the assistant is not configured, so withdrawing never depends on the configuration", async () => {
  await withUsers(1, async ([u]) => {
    await grant(GRANT, { userId: u });
    const r = await revoke({ userId: u, config: { enabled: false } });
    assert.deepEqual([r.status, r.body], [200, { ok: true }]);
    assert.equal((await status({ userId: u })).body.consent.state, "revoked");
  });
});

// --- integration with the run path ------------------------------------------------------------------------------------------------

async function run(userId: string) {
  const provider = testProvider(done);
  const response = await handleAssistantHttp(
    new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: ["What is my tax?"] }) }),
    { getSessionUserId: async () => userId, config: CONFIG, driver: provider.driver, now: () => NOW + 1_000 },
  );
  const body = await response.json();
  return { status: response.status, code: body.ok ? "ok" : body.error.code, calls: provider.calls.length };
}

test("integration: without consent the run path is unchanged (403 consent_required, nothing sent); after a grant it runs; after a revoke it refuses", async () => {
  await withUsers(1, async ([u]) => {
    assert.deepEqual(await run(u), { status: 403, code: "consent_required", calls: 0 });

    await grant(GRANT, { userId: u });
    const lookup = await findAssistantAuthorization(u, { profileId: EXTERNAL_PROFILE.id, recipient: RECIPIENT });
    assert.equal(lookup.status, "active", "the run path's own lookup finds the grant");
    assert.deepEqual(await run(u), { status: 200, code: "ok", calls: 1 });

    await revoke({ userId: u });
    assert.deepEqual(await run(u), { status: 403, code: "consent_revoked", calls: 0 });
  });
});

test("integration: consent for an earlier inventory is 403 consent_outdated with no provider call and no slot held; renewal runs", async () => {
  await withUsers(1, async ([u]) => {
    await grant(GRANT, { userId: u });
    await db.update(assistantAuthorizations).set({ inventoryVersion: "inv1-00000000" }).where(eq(assistantAuthorizations.userId, u));
    assert.deepEqual(await run(u), { status: 403, code: "consent_outdated", calls: 0 });
    const runs = await db.select().from(assistantRuns).where(eq(assistantRuns.userId, u));
    assert.deepEqual(runs.map((r) => [r.status, r.resultCode]), [["rejected", "consent_outdated"]], "refused before admission: no running slot");
    await grant(GRANT, { userId: u });
    assert.deepEqual(await run(u), { status: 200, code: "ok", calls: 1 });
  });
});
