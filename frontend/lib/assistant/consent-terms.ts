// THE CONSENT TERMS the server offers a person: exactly what a grant will record (profile, recipient, data classes, validity window) and
// the disclosure they are shown before granting it. PURE: it imports only other pure lib/assistant modules, and reaches no database,
// session, provider, network or clock (a test pins that).
//
// Nothing here is chosen by a request. The profile is the caller's code constant, the recipient is the server configuration's, the data
// classes are the profile's own, and the window is CONSENT_VALIDITY_MS from the server's `now`. The terms are then run through
// planModelAccess, the same check every run makes, as if they had already been granted: terms that the run path would refuse are never
// offered, and the disclosure returned is the plan's own, so the one a person reads is the one a run under that consent uses.
import { planModelAccess } from "./access-plan";
import { AUTHORIZATION_VERSION, AssistantAuthorizationError } from "./authorization";
import type { AssistantAuthorization } from "./authorization";
import { fingerprintInventory } from "./egress-disclosure";
import type { EgressDisclosure } from "./egress-disclosure";
import { EGRESS_FIELD_CLASSES, resolveProfile } from "./profiles";
import type { EgressFieldClass } from "./tool-contract";

/** How long a grant applies: a fixed server-side period. A person grants again after it ends. */
export const CONSENT_VALIDITY_DAYS = 30;
export const CONSENT_VALIDITY_MS = CONSENT_VALIDITY_DAYS * 24 * 60 * 60 * 1000;

export type ConsentTerms = Readonly<{
  profileId: string;
  recipient: string;
  dataClasses: readonly EgressFieldClass[];
  /** ISO 8601 UTC, whole seconds (the precision the store keeps). */
  issuedAt: string;
  expiresAt: string;
  /** What a run under these terms sends and withholds; carries the inventory fingerprint the grant is tied to. */
  disclosure: EgressDisclosure;
}>;

export type ConsentContext = { userId: string; recipient: string; now: number };

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * The terms for this person, the configured recipient and this moment. Throws what planModelAccess throws (an AssistantAuthorizationError,
 * for example recipient_not_approved, or an AssistantProfileError) when the terms could not authorize a run.
 */
export function consentTermsFor(profile: unknown, context: ConsentContext, configuredRecipients: readonly string[]): ConsentTerms {
  const resolved = resolveProfile(profile);
  const dataClasses = EGRESS_FIELD_CLASSES.filter((c) => resolved.classes[c]);
  if (typeof context?.now !== "number" || !Number.isSafeInteger(context.now) || context.now < 0) throw new AssistantAuthorizationError("authorization_invalid");
  const issued = Math.floor(context.now / 1000) * 1000;
  const candidate: AssistantAuthorization = {
    version: AUTHORIZATION_VERSION,
    authorizationId: "candidate",
    userId: context.userId,
    profileId: resolved.id,
    recipient: context.recipient,
    consent: "granted",
    dataClasses,
    issuedAt: isoSeconds(issued),
    expiresAt: isoSeconds(issued + CONSENT_VALIDITY_MS),
    inventoryVersion: fingerprintInventory(),
  };
  const plan = planModelAccess(profile, candidate, context, configuredRecipients);
  return Object.freeze({
    profileId: plan.audit.profileId,
    recipient: plan.audit.recipient,
    dataClasses: plan.audit.visibleClasses,
    issuedAt: candidate.issuedAt,
    expiresAt: candidate.expiresAt,
    disclosure: plan.disclosure,
  });
}

export type ConsentAssessment = Readonly<{ state: "active" | "expired" | "outdated" | "invalid"; expiresAt: string | null }>;

/**
 * Whether a stored, unrevoked authorization would authorize a run right now, decided by the run's own check (planModelAccess). Only an
 * AssistantAuthorizationError is an answer; anything else (a broken profile or configuration) is thrown.
 */
export function assessConsent(profile: unknown, authorization: unknown, context: ConsentContext, configuredRecipients: readonly string[]): ConsentAssessment {
  const stated = (authorization as { expiresAt?: unknown } | null)?.expiresAt;
  const expiresAt = typeof stated === "string" ? stated : null;
  try {
    planModelAccess(profile, authorization, context, configuredRecipients);
    return Object.freeze({ state: "active", expiresAt });
  } catch (error) {
    if (!(error instanceof AssistantAuthorizationError)) throw error;
    const state = error.code === "authorization_expired" ? "expired" : error.code === "inventory_changed" ? "outdated" : "invalid";
    return Object.freeze({ state, expiresAt });
  }
}
