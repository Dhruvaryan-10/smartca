// The transactions loader shared by Summary, Ledger, Reports and Insights. Pure: fetch is replaced per test; no server or DOM.
// Regression: Reports and Insights used to read any JSON body that was not an array as `[]`, so a server error looked like an
// empty account. Every failure must now reject, and only a genuine `[]` may resolve as empty.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchTransactions } from "../app/components/transactions-client";
import { ApiFailure } from "../app/components/request";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const urls: string[] = [];
function respond(body: string, status: number, contentType = "application/json") {
  urls.length = 0;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(status === 204 ? null : body, { status, headers: { "content-type": contentType } });
  }) as typeof fetch;
}

const row = { id: "t1", type: "expense", amountPaise: 12_345, category: "Food", description: null, occurredOn: "2026-09-14" };

test("a successful response resolves to the rows exactly as sent", async () => {
  respond(JSON.stringify([row]), 200);
  assert.deepEqual(await fetchTransactions(), [row]);
  assert.deepEqual(urls, ["/api/transactions"]);
});

test("an empty account resolves to [] (the genuine empty state)", async () => {
  respond("[]", 200);
  assert.deepEqual(await fetchTransactions(), []);
});

for (const [status, body] of [
  [401, { error: "Unauthorized" }],
  [403, { error: "Forbidden" }],
  [500, { error: "Internal server error" }],
] as const) {
  test(`a ${status} JSON error rejects instead of reading as an empty account`, async () => {
    respond(JSON.stringify(body), status);
    await assert.rejects(fetchTransactions(), (err: unknown) => err instanceof ApiFailure && err.status === status);
  });
}

test("a 200 whose body is not an array is malformed and rejects", async () => {
  respond(JSON.stringify({ error: "nope" }), 200);
  await assert.rejects(fetchTransactions(), (err: unknown) => err instanceof ApiFailure && err.code === "malformed_response");
});

test("an HTML body (an expired session redirected to /login) rejects as a session failure", async () => {
  respond("<!doctype html><title>Log in</title>", 200, "text/html");
  await assert.rejects(fetchTransactions(), (err: unknown) => err instanceof ApiFailure && err.code === "session");
});

test("a network failure rejects with a connection message", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(fetchTransactions(), (err: unknown) => err instanceof ApiFailure && /connection/i.test(err.message));
});

test("an abort is passed through untouched so pages can ignore it", async () => {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    assert.ok(init?.signal, "the signal reaches fetch");
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch;
  await assert.rejects(fetchTransactions(new AbortController().signal), (err: unknown) => err instanceof DOMException && err.name === "AbortError");
});
