// The consent API's PURE parts: the server's consent terms (lib/assistant/consent-terms.ts) and the request/error contract
// (services/assistant/consent-contract.ts). No database: the HTTP and store behaviour is in assistant-consent-http.db.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSENT_VALIDITY_DAYS, CONSENT_VALIDITY_MS, assessConsent, consentTermsFor } from "../lib/assistant/consent-terms";
import { planModelAccess } from "../lib/assistant/access-plan";
import { AUTHORIZATION_VERSION, AssistantAuthorizationError, resolveAuthorization } from "../lib/assistant/authorization";
import { describeEgress, fingerprintInventory } from "../lib/assistant/egress-disclosure";
import { EGRESS_FIELD_CLASSES, FULL_PROFILE, SYNTHETIC_PROFILE } from "../lib/assistant/profiles";
import { EXTERNAL_PROFILE } from "../services/assistant/external";
import { ConsentRequestError, parseConsentGrantRequest, toConsentApiError } from "../services/assistant/consent-contract";
import { NotAuthenticatedError } from "../services/errors";

const USER = "user-a";
const RECIPIENT = "recipient-a";
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0, 456);
const ctx = (over: Record<string, unknown> = {}) => ({ userId: USER, recipient: RECIPIENT, now: NOW, ...over });
const VERSION = fingerprintInventory();

// --- the terms --------------------------------------------------------------------------------------------------------------------

test("the terms are the server's: the external profile, the configured recipient, the profile's classes and a fixed window", () => {
  const terms = consentTermsFor(EXTERNAL_PROFILE, ctx(), [RECIPIENT]);
  assert.equal(terms.profileId, EXTERNAL_PROFILE.id);
  assert.equal(terms.recipient, RECIPIENT);
  assert.deepEqual([...terms.dataClasses], EGRESS_FIELD_CLASSES.filter((c) => FULL_PROFILE.classes[c]));
  assert.equal(terms.issuedAt, "2026-09-29T12:00:00Z", "whole seconds, the precision the store keeps");
  assert.equal(Date.parse(terms.expiresAt) - Date.parse(terms.issuedAt), CONSENT_VALIDITY_MS);
  assert.equal(CONSENT_VALIDITY_MS, CONSENT_VALIDITY_DAYS * 86_400_000);
});

test("the disclosure is the access plan's own, derived from the inventory, with the current inventory fingerprint", () => {
  const terms = consentTermsFor(EXTERNAL_PROFILE, ctx(), [RECIPIENT]);
  assert.equal(terms.disclosure.inventoryVersion, VERSION);
  const authorization = { version: AUTHORIZATION_VERSION, authorizationId: "stored-1", userId: USER, profileId: terms.profileId, recipient: terms.recipient, consent: "granted", dataClasses: [...terms.dataClasses], issuedAt: terms.issuedAt, expiresAt: terms.expiresAt, inventoryVersion: terms.disclosure.inventoryVersion };
  // What a run under the stored grant would plan is exactly what was disclosed.
  const plan = planModelAccess(EXTERNAL_PROFILE, authorization, ctx(), [RECIPIENT]);
  assert.deepEqual(terms.disclosure, plan.disclosure);
  assert.deepEqual(terms.disclosure, describeEgress(plan.allowedTools, plan.visibleClasses));
  assert.deepEqual(resolveAuthorization(EXTERNAL_PROFILE, authorization, ctx()).dataClasses, terms.dataClasses);
});

test("terms the run path would refuse are never offered", () => {
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
      return "no error";
    } catch (e) {
      return e instanceof AssistantAuthorizationError ? e.code : String(e);
    }
  };
  assert.equal(codeOf(() => consentTermsFor(EXTERNAL_PROFILE, ctx(), ["recipient-b"])), "recipient_not_approved");
  assert.equal(codeOf(() => consentTermsFor(EXTERNAL_PROFILE, ctx(), [])), "recipient_not_approved");
  assert.equal(codeOf(() => consentTermsFor(EXTERNAL_PROFILE, ctx({ userId: "" }), [RECIPIENT])), "authorization_invalid");
  assert.equal(codeOf(() => consentTermsFor(EXTERNAL_PROFILE, ctx({ now: -1 }), [RECIPIENT])), "authorization_invalid");
  assert.throws(() => consentTermsFor({ id: "x" }, ctx(), [RECIPIENT]), { name: "AssistantProfileError" });
  // Another profile gives other terms; the service always passes EXTERNAL_PROFILE.
  assert.equal(consentTermsFor(SYNTHETIC_PROFILE, ctx(), [RECIPIENT]).profileId, "synthetic");
});

test("assessConsent judges a stored grant with the run's own check", () => {
  const terms = consentTermsFor(EXTERNAL_PROFILE, ctx(), [RECIPIENT]);
  const stored = { version: AUTHORIZATION_VERSION, authorizationId: "stored-1", userId: USER, profileId: "full", recipient: RECIPIENT, consent: "granted", dataClasses: [...terms.dataClasses], issuedAt: terms.issuedAt, expiresAt: terms.expiresAt, inventoryVersion: terms.disclosure.inventoryVersion };
  assert.deepEqual(assessConsent(EXTERNAL_PROFILE, stored, ctx(), [RECIPIENT]), { state: "active", expiresAt: terms.expiresAt });
  assert.equal(assessConsent(EXTERNAL_PROFILE, stored, ctx({ now: Date.parse(terms.expiresAt) }), [RECIPIENT]).state, "expired");
  assert.equal(assessConsent(EXTERNAL_PROFILE, stored, ctx({ userId: "user-b" }), [RECIPIENT]).state, "invalid");
  assert.equal(assessConsent(EXTERNAL_PROFILE, stored, ctx(), ["recipient-b"]).state, "invalid");
  assert.equal(assessConsent(EXTERNAL_PROFILE, { ...stored, profileId: "synthetic" }, ctx(), [RECIPIENT]).state, "invalid");
  // Granted for another inventory: outdated, not merely invalid, so the person is sent back to the current disclosure.
  assert.deepEqual(assessConsent(EXTERNAL_PROFILE, { ...stored, inventoryVersion: "inv1-00000000" }, ctx(), [RECIPIENT]), { state: "outdated", expiresAt: terms.expiresAt });
  // An expired grant for an old inventory is reported as expired: the inventory is compared only once everything else holds.
  assert.equal(assessConsent(EXTERNAL_PROFILE, { ...stored, inventoryVersion: "inv1-00000000" }, ctx({ now: Date.parse(terms.expiresAt) }), [RECIPIENT]).state, "expired");
  assert.throws(() => assessConsent({ id: "x" }, stored, ctx(), [RECIPIENT]), { name: "AssistantProfileError" });
});

// --- the request contract ---------------------------------------------------------------------------------------------------------

test("a grant body is exactly { consent: \"granted\", inventoryVersion }", () => {
  assert.deepEqual(parseConsentGrantRequest({ consent: "granted", inventoryVersion: VERSION }), { consent: "granted", inventoryVersion: VERSION });
});

test("every other grant body is refused: no user, profile, class, recipient, version or window can be sent", () => {
  const ok = { consent: "granted", inventoryVersion: VERSION };
  const bodies: unknown[] = [
    undefined, null, "granted", 1, true, [], [ok], {},
    { consent: "granted" }, { inventoryVersion: VERSION },
    { ...ok, consent: true }, { ...ok, consent: "not_granted" }, { ...ok, consent: "GRANTED" },
    { ...ok, inventoryVersion: 1 }, { ...ok, inventoryVersion: "" }, { ...ok, inventoryVersion: "x".repeat(65) }, { ...ok, inventoryVersion: "inv1/../x" },
    { ...ok, userId: USER }, { ...ok, user: USER },
    { ...ok, profileId: "full" }, { ...ok, profile: FULL_PROFILE },
    { ...ok, dataClasses: [...EGRESS_FIELD_CLASSES] }, { ...ok, classes: ["user_financial_data"] },
    { ...ok, recipient: RECIPIENT }, { ...ok, recipients: [RECIPIENT] },
    { ...ok, version: AUTHORIZATION_VERSION }, { ...ok, authorizationVersion: 2 }, { ...ok, formatVersion: 1 },
    { ...ok, expiresAt: "2999-01-01T00:00:00Z" }, { ...ok, issuedAt: "2000-01-01T00:00:00Z" }, { ...ok, validForDays: 36500 },
    { ...ok, authorizationId: "x" }, { ...ok, __proto__: { userId: USER } }, Object.assign(Object.create(null), ok),
  ];
  for (const body of bodies) {
    assert.throws(() => parseConsentGrantRequest(body), (e: unknown) => e instanceof ConsentRequestError && e.code === "invalid_request", JSON.stringify(body));
  }
});

test("consent errors are stable codes with fixed messages, never the error's own text", () => {
  const invalid = toConsentApiError(new ConsentRequestError("invalid_request"));
  assert.deepEqual({ ...invalid }, { code: "invalid_request", category: "validation", retryable: false, message: "The request could not be accepted." });
  const outdated = toConsentApiError(new ConsentRequestError("disclosure_outdated"));
  assert.deepEqual([outdated.code, outdated.category, outdated.retryable], ["disclosure_outdated", "validation", false]);
  assert.equal(toConsentApiError(new NotAuthenticatedError()).code, "not_authenticated");
  assert.equal(toConsentApiError(new AssistantAuthorizationError("recipient_not_approved")).code, "provider_not_approved");
  const secret = "postgres://admin:hunter2@db/x at /srv/app/services/assistant/consent-service.ts:12";
  for (const error of [new Error(secret), new TypeError(secret), { message: secret }, secret]) {
    const out = toConsentApiError(error);
    assert.equal(out.code, "internal_error");
    assert.equal(JSON.stringify(out).includes("hunter2"), false);
    assert.equal(JSON.stringify(out).includes("/srv/"), false);
  }
});
