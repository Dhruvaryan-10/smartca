// THE AUTHORIZATION CHAIN before any provider request, through the production route as it is deployed: the HTTP boundary, the session
// user, the configuration, consent READ FROM PostgreSQL, the access plan (user, recipient, profile, data classes, format version, validity,
// inventory version), admission and the run row, with the driver the REGISTRY builds from MODEL_WIRE_FORMAT (no driver is injected). The
// platform `fetch` is replaced for the whole file by a recorder, so "no provider request" is counted at the last point a request could
// leave the process.
//
// Pinned: every way a stored grant can fail to cover the request (none, another person's, another recipient's, another profile's,
// expired, revoked, for an earlier egress inventory, or a row altered past the store's validation) is refused server-side with its public
// code, recorded as a rejected attempt, holds no slot, and sends nothing; and renewing consent restores the run.
import "../db/load-env";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { assistantAuthorizations, assistantRuns } from "../db/schema";
import { handleAssistantHttp } from "../services/assistant/http";
import type { AssistantApiResponse } from "../services/assistant/api-contract";
import { validateExternalEnv } from "../services/assistant/config";
import { grantAssistantAuthorization, revokeAllAssistantAuthorizations } from "../services/assistant/authorization-store";
import { EGRESS_FIELD_CLASSES } from "../lib/assistant/profiles";
import { deleteTestUser, makeTestUser } from "./helpers";

const KEY = "test-key-NOT-A-REAL-SECRET-0012";
const ENDPOINT = "https://provider.invalid/v1/chat/completions";
const RECIPIENT = "recipient-a";
const MODEL = "fixture-model-1";
const NOW = Date.UTC(2044, 6, 1, 12, 0, 0);
const CONFIG = validateExternalEnv({
  ASSISTANT_ENABLED: "true", ASSISTANT_ENV: "external", MODEL_ENDPOINT: ENDPOINT, MODEL_API_KEY: KEY, MODEL_ID: MODEL,
  MODEL_APPROVED_RECIPIENTS: RECIPIENT, MODEL_TIMEOUT_MS: "3000", MODEL_MAX_OUTPUT_CHARS: "20000", MODEL_MAX_OUTPUT_TOKENS: "512",
  MODEL_WIRE_FORMAT: "openai-chat-completions", ASSISTANT_RATE_WINDOW_SECONDS: "3600", ASSISTANT_MAX_RUNS_PER_WINDOW: "50",
  ASSISTANT_MAX_CONCURRENT_RUNS: "1", ASSISTANT_MAX_TOKENS_PER_WINDOW: "1000000", ASSISTANT_MAX_GLOBAL_CONCURRENT_RUNS: "100", ASSISTANT_RUN_RETENTION_DAYS: "400",
});

// --- the only network: a recorder in place of the platform fetch -------------------------------------------------------------------

const realFetch = globalThis.fetch;
const sent: string[] = [];
before(() => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent.push(String(init?.body));
    const completion = { id: "c", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
    return new Response(JSON.stringify(completion), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  sent.length = 0;
});

async function send(userId: string) {
  const response = await handleAssistantHttp(
    new Request("http://localhost/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: ["Hello"] }) }),
    { getSessionUserId: async () => userId, config: CONFIG, now: () => NOW },
  );
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as AssistantApiResponse, text };
}
const grant = (userId: string, over: Partial<Parameters<typeof grantAssistantAuthorization>[1]> = {}) =>
  grantAssistantAuthorization(userId, { profileId: "full", recipient: RECIPIENT, dataClasses: [...EGRESS_FIELD_CLASSES], issuedAt: new Date(NOW - 3_600_000), expiresAt: new Date(NOW + 3_600_000), ...over });
const reset = async (userId: string) => {
  await db.delete(assistantRuns).where(eq(assistantRuns.userId, userId));
  await db.delete(assistantAuthorizations).where(eq(assistantAuthorizations.userId, userId));
};
/** Alter the person's stored grant directly, as a tampered or corrupted row would be: past the store's own validation. */
const tamper = (userId: string, set: Partial<typeof assistantAuthorizations.$inferInsert>) =>
  db.update(assistantAuthorizations).set(set).where(and(eq(assistantAuthorizations.userId, userId), eq(assistantAuthorizations.recipient, RECIPIENT)));

async function withUsers(n: number, work: (ids: string[]) => Promise<void>) {
  const users = [];
  try {
    for (let i = 0; i < n; i += 1) users.push(await makeTestUser(`assistant-authorization-chain-${i}`));
    await work(users.map((u) => u.id));
  } finally {
    for (const u of users) await deleteTestUser(u.id);
  }
}

test("every grant that does not cover the request is refused server-side before any provider request, recorded, and holds no slot", async () => {
  await withUsers(2, async ([u, other]) => {
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ["no grant at all", async () => undefined, "consent_required"],
      ["only another person has consented", () => grant(other), "consent_required"],
      ["a grant for another recipient", () => grant(u, { recipient: "recipient-b" }), "consent_required"],
      ["a grant for another profile", () => grant(u, { profileId: "synthetic" }), "consent_required"],
      ["an expired grant", () => grant(u, { issuedAt: new Date(NOW - 7_200_000), expiresAt: new Date(NOW - 1) }), "consent_expired"],
      // Outside its validity window on either side is the one existing code (authorization_expired). The server issues grants at "now",
      // so a not-yet-valid grant means clock skew or a tampered row; either way it is refused before anything runs.
      ["a grant not yet valid", () => grant(u, { issuedAt: new Date(NOW + 60_000), expiresAt: new Date(NOW + 7_200_000) }), "consent_expired"],
      ["a revoked grant", async () => { await grant(u); await revokeAllAssistantAuthorizations(u, new Date(NOW - 1)); }, "consent_revoked"],
      ["a grant for an earlier egress inventory", async () => { await grant(u); await tamper(u, { inventoryVersion: "inv_0000000000000000" }); }, "consent_outdated"],
      ["a stored row of another authorization format", async () => { await grant(u); await tamper(u, { formatVersion: 999 }); }, "consent_invalid"],
      ["a stored row naming a data class that does not exist", async () => { await grant(u); await tamper(u, { dataClasses: ["user_free_text", "everything"] }); }, "consent_invalid"],
      ["a stored row recording consent as not granted", async () => { await grant(u); await tamper(u, { consent: "not_granted" }); }, "consent_required"],
      ["a stored row with no data classes", async () => { await grant(u); await tamper(u, { dataClasses: [] }); }, "consent_invalid"],
    ];
    for (const [name, arrange, code] of cases) {
      await reset(u);
      await reset(other);
      await arrange();
      const r = await send(u);
      assert.deepEqual([r.status, r.body.ok ? "ok" : r.body.error.code], [403, code], name);
      assert.equal(sent.length, 0, `${name}: no provider request`);
      const rows = await db.select().from(assistantRuns).where(eq(assistantRuns.userId, u));
      assert.deepEqual(rows.map((row) => [row.status, row.resultCode]), [["rejected", code]], `${name}: recorded as rejected, no slot held`);
      for (const secret of [KEY, ENDPOINT, other]) assert.equal(r.text.includes(secret), false, `${name}: nothing internal in the response`);
      assert.doesNotMatch(r.text, /authorizationId|inventoryVersion|dataClasses|profileId/, `${name}: no authorization object in the response`);
    }
  });
});

test("renewing consent restores the run: after an outdated, then a revoked grant, a fresh grant reaches the provider exactly once", async () => {
  await withUsers(1, async ([u]) => {
    await grant(u);
    await tamper(u, { inventoryVersion: "inv_0000000000000000" });
    assert.equal((await send(u)).body.ok, false);
    await revokeAllAssistantAuthorizations(u, new Date(NOW - 1_000));
    assert.equal((await send(u)).body.ok, false);
    assert.equal(sent.length, 0);

    await grant(u, { issuedAt: new Date(NOW - 500) });
    const r = await send(u);
    assert.deepEqual([r.status, r.body.ok], [200, true]);
    assert.equal(sent.length, 1, "one provider request, from the registry's driver");
    const body = JSON.parse(sent[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["max_completion_tokens", "messages", "model", "tools"], "the configured wire format's cap field, and nothing else");
    assert.equal(body.max_completion_tokens, 512);
    assert.doesNotMatch(sent[0], new RegExp(`${u}|authorization|inventory|session`, "i"));
  });
});
