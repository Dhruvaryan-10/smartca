// The Ask SmartCA panel's browser client and the financial colour rules. Pure: fetch is replaced per test; no server, session or DOM.
// What matters is that the client sends exactly what the assistant's contracts accept, reads every failure the way the panel promises
// to treat it, and that its wire types still describe what the server returns (checked by the compiler below: the UI may not import
// the assistant's types itself, so this file is where the two meet).
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SENT_MESSAGES,
  deleteConsent,
  fetchConsentStatus,
  postConsentGrant,
  postQuestion,
  safeExternalUrl,
  treatmentFor,
  type AssistantAnswer,
  type ClientError,
  type ConsentDisclosureView,
  type ConsentStatusView,
  type ServerErrorCategory,
} from "../app/components/assistant/assistant-client";
import { MAX_USER_MESSAGES } from "../services/assistant/ask";
import type { Answer } from "../lib/assistant/answer";
import type { AssistantApiErrorCategory } from "../services/assistant/api-contract";
import type { ConsentDisclosure, ConsentStatus } from "../services/assistant/consent-contract";
import { moneyTone, signedPaise, spokenAmount } from "../lib/money-tone";
import { formatRupees } from "../lib/format";

// Compile-time contract checks: every server response type must be assignable to the UI's wire type, and the error categories must
// be the same set. A server change that the panel would misread fails typecheck here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const wireTypesFit = {
  answer: (value: Answer): AssistantAnswer => value,
  consent: (value: ConsentStatus): ConsentStatusView => value,
  disclosure: (value: ConsentDisclosure): ConsentDisclosureView => value,
  categories: true satisfies Same<AssistantApiErrorCategory, ServerErrorCategory>,
};

type Call = { url: string; init: RequestInit };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const error = (over: Partial<ClientError>): ClientError => ({ code: "x", category: "internal", retryable: false, message: "m", ...over });

test("the message cap mirrors the server's", () => {
  assert.equal(MAX_SENT_MESSAGES, MAX_USER_MESSAGES);
});

test("postQuestion posts only { messages }, capped to the most recent allowed", async () => {
  const calls = stubFetch(() => json({ ok: true, answer: { state: "answered" } }));
  const many = Array.from({ length: 25 }, (_, i) => `q${i}`);
  const result = await postQuestion(many);
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, "/api/assistant");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(Object.keys(body), ["messages"]);
  assert.equal(body.messages.length, MAX_USER_MESSAGES);
  assert.equal(body.messages.at(-1), "q24");
  assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json");
});

test("postConsentGrant sends exactly the decision and the disclosure version it was given", async () => {
  const calls = stubFetch(() => json({ ok: true, consent: { state: "active", valid: true, recipient: "r", expiresAt: null } }));
  await postConsentGrant("inv1-0a1b2c3d");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { consent: "granted", inventoryVersion: "inv1-0a1b2c3d" });
});

test("deleteConsent is a bare DELETE", async () => {
  const calls = stubFetch(() => json({ ok: true }));
  assert.deepEqual(await deleteConsent(), { ok: true, value: true });
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.body, undefined);
});

test("a server failure is passed through unchanged", async () => {
  const failure = { code: "assistant_unavailable", category: "configuration", retryable: false, message: "The assistant is not available." };
  stubFetch(() => json({ ok: false, error: failure }, 503));
  assert.deepEqual(await postQuestion(["hi"]), { ok: false, error: failure });
});

test("an HTML response (the proxy's sign-in redirect) reads as an ended session", async () => {
  stubFetch(() => {
    const response = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  });
  const result = await fetchConsentStatus();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.category, "authentication");
});

test("network failures are retryable and aborts are cancellations", async () => {
  stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const offline = await postQuestion(["hi"]);
  assert.ok(!offline.ok && offline.error.category === "network" && offline.error.retryable);

  stubFetch(() => {
    throw new DOMException("aborted", "AbortError");
  });
  const cancelled = await postQuestion(["hi"]);
  assert.ok(!cancelled.ok && treatmentFor(cancelled.error) === "cancelled");
});

test("each error category maps to one treatment", () => {
  assert.equal(treatmentFor(error({ category: "authentication" })), "signin");
  for (const code of ["consent_required", "consent_expired", "consent_revoked", "consent_invalid", "consent_outdated"]) {
    assert.equal(treatmentFor(error({ code, category: "consent" })), "consent");
  }
  assert.equal(treatmentFor(error({ code: "disclosure_outdated", category: "validation" })), "consent");
  assert.equal(treatmentFor(error({ code: "assistant_unavailable", category: "configuration" })), "unavailable");
  assert.equal(treatmentFor(error({ code: "rate_limited", category: "rate_limit", retryable: true })), "retry");
  assert.equal(treatmentFor(error({ code: "provider_timeout", category: "provider", retryable: true })), "retry");
  assert.equal(treatmentFor(error({ code: "provider_rejected", category: "provider" })), "message");
  assert.equal(treatmentFor(error({ code: "internal_error", category: "internal" })), "message");
});

test("only http(s) evidence links become links", () => {
  assert.equal(safeExternalUrl("https://incometaxindia.gov.in/x"), "https://incometaxindia.gov.in/x");
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("data:text/html,hi"), null);
  assert.equal(safeExternalUrl("not a url"), null);
});

test("financial tones: income green, expenses coral, net by its sign", () => {
  assert.equal(moneyTone("income", 500), "income");
  assert.equal(moneyTone("expense", 500), "expense");
  assert.equal(moneyTone("tax", 500), "tax");
  assert.equal(moneyTone("net", 500), "income");
  assert.equal(moneyTone("net", -500), "expense");
  assert.equal(moneyTone("net", 0), "neutral");
  assert.equal(moneyTone("neutral", -500), "neutral");
});

test("signed expenses read as outflows, and screen readers hear the sign", () => {
  assert.equal(signedPaise("expense", 4_500_00), -4_500_00);
  assert.equal(signedPaise("income", 4_500_00), 4_500_00);
  assert.equal(spokenAmount(formatRupees(-4_500_00)), "minus ₹4,500");
  assert.equal(spokenAmount(formatRupees(4_500_00, { showPositiveSign: true })), "plus ₹4,500");
  assert.equal(spokenAmount(formatRupees(4_500_00)), "₹4,500");
});
