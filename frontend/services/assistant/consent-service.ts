// THE CONSENT SERVICE: the four operations a signed-in person has on their own assistant consent, called only by the consent HTTP boundary
// (consent-http.ts). It composes existing pieces and adds no policy of its own:
//
//   session  -> user          from the server session only; every operation refuses without one, before anything else
//   config   -> recipient     readProviderTarget: enabled, external, exactly one approved recipient (not needed to revoke)
//   terms                     consentTermsFor(EXTERNAL_PROFILE, ...): profile, classes, window and disclosure, checked by planModelAccess
//   store                     authorization-store.ts: grant, find, revoke; every query filtered by the session user
//
// disclosure  the terms' disclosure: the access plan's own, for the profile and recipient a run uses
// status      the latest authorization for (user, EXTERNAL_PROFILE, configured recipient), judged by the run's own check (assessConsent)
// grant       only if the person acknowledged the CURRENT disclosure (its inventoryVersion); the terms are the server's, never the body's
// revoke      withdraws all of the person's authorizations; idempotent, and works even while the assistant is not configured
import { readProviderTarget } from "./provider";
import type { AssistantConfig } from "./config";
import { EXTERNAL_PROFILE } from "./external";
import { findAssistantAuthorization, grantAssistantAuthorization, revokeAllAssistantAuthorizations } from "./authorization-store";
import { ConsentRequestError } from "./consent-contract";
import type { ConsentDisclosure, ConsentGrantRequest, ConsentStatus } from "./consent-contract";
import { CONSENT_VALIDITY_DAYS, assessConsent, consentTermsFor } from "@/lib/assistant/consent-terms";
import { NotAuthenticatedError } from "../errors";

export type ConsentServiceDeps = {
  /** The server's configuration, or a function that reads it. */
  config: AssistantConfig | (() => AssistantConfig);
  /** Milliseconds since the epoch; defaults to the server clock. */
  now?: () => number;
};

function userOf(session: unknown): string {
  const userId = typeof session === "object" && session !== null ? (session as { userId?: unknown }).userId : undefined;
  if (typeof userId !== "string" || userId.trim() === "") throw new NotAuthenticatedError();
  return userId;
}

function targetOf(deps: ConsentServiceDeps) {
  return readProviderTarget(typeof deps.config === "function" ? deps.config() : deps.config);
}

function termsOf(userId: string, deps: ConsentServiceDeps) {
  const { config, recipient } = targetOf(deps);
  return consentTermsFor(EXTERNAL_PROFILE, { userId, recipient, now: (deps.now ?? Date.now)() }, config.approvedRecipients);
}

export async function getConsentDisclosure(session: unknown, deps: ConsentServiceDeps): Promise<ConsentDisclosure> {
  const terms = termsOf(userOf(session), deps);
  return Object.freeze({ recipient: terms.recipient, validForDays: CONSENT_VALIDITY_DAYS, egress: terms.disclosure });
}

export async function getConsentStatus(session: unknown, deps: ConsentServiceDeps): Promise<ConsentStatus> {
  const userId = userOf(session);
  const { config, recipient } = targetOf(deps);
  const lookup = await findAssistantAuthorization(userId, { profileId: EXTERNAL_PROFILE.id, recipient });
  if (lookup.status !== "active") return Object.freeze({ state: lookup.status, valid: false, recipient, expiresAt: null });
  const { state, expiresAt } = assessConsent(EXTERNAL_PROFILE, lookup.authorization, { userId, recipient, now: (deps.now ?? Date.now)() }, config.approvedRecipients);
  return Object.freeze({ state, valid: state === "active", recipient, expiresAt });
}

export async function grantConsent(session: unknown, request: ConsentGrantRequest, deps: ConsentServiceDeps): Promise<ConsentStatus> {
  const userId = userOf(session);
  const terms = termsOf(userId, deps);
  if (request.inventoryVersion !== terms.disclosure.inventoryVersion) throw new ConsentRequestError("disclosure_outdated");
  await grantAssistantAuthorization(userId, {
    profileId: terms.profileId,
    recipient: terms.recipient,
    dataClasses: terms.dataClasses,
    issuedAt: new Date(terms.issuedAt),
    expiresAt: new Date(terms.expiresAt),
  });
  // Report what the run path will now find, read back through the same lookup and check it uses.
  return getConsentStatus(session, deps);
}

export async function revokeConsent(session: unknown, deps: Pick<ConsentServiceDeps, "now">): Promise<void> {
  await revokeAllAssistantAuthorizations(userOf(session), new Date((deps.now ?? Date.now)()));
}
