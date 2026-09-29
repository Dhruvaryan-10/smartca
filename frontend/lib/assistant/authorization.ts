// ASSISTANT SESSION AUTHORIZATION: what one person has explicitly authorized, for one external recipient, for a period of time. PURE:
// it imports only the pure assistant contract and profiles, so it reaches no database, session, network, provider or environment,
// and a test pins that. Nothing uses it yet: it is the boundary a future real-provider entry point will call, and it persists nothing.
//
// Three things are kept apart:
//   AssistantProfile (profiles.ts)  what a MODE is configured to allow: its tools and the classes of data it may show a model
//   authorization (this file)       what THIS person has authorized for THIS recipient: explicit consent and a set of data classes
//   provider configuration          how the server connects to a recipient (config.ts). Only the opaque recipient id crosses over
//
// The invariant: EFFECTIVE ACCESS = profile ∩ authorization. Never a union:
//   - an authorization cannot add a tool; it has no tool field, and the tools come from the profile only
//   - an authorization that names a data class the profile forbids is refused, not honoured and not silently trimmed
//   - a tool is offered only when EVERY class it returns (ASSISTANT_EGRESS_INVENTORY) is authorized. Field-level egress filtering
//     (egress-filter.ts) also exists and is applied with the authorized classes as `visibleClasses` (access-plan.ts builds both
//     together), so the filter is a second line of defence here; offering a tool whose result would be partly hidden is a later,
//     deliberate choice
//   - nothing is defaulted: consent, the classes and the validity window must each be stated; an unknown field, value or version is
//     refused; an intention or a preference ("share everything", `consent: true`) is not consent
//
// What the egress inventory implies: every tool can return user_free_text (a refusal message repeats an argument name the model sent)
// and system_value, and the conversation itself is user free text. So an authorization without user_free_text can send nothing, and one
// without system_value can use no tool; both are refused rather than resolved to an empty grant.
import { ASSISTANT_TOOL_NAMES } from "./tool-contract";
import type { EgressFieldClass, ToolName } from "./tool-contract";
import { EGRESS_FIELD_CLASSES, classesReturnedBy, resolveProfile } from "./profiles";

/** The authorization format this code understands. Any other version is refused. */
export const AUTHORIZATION_VERSION = 1;

/** An authorization as it is handed over: plain data (so it can later be stored and audited), and untrusted until resolved. */
export type AssistantAuthorization = {
  version: typeof AUTHORIZATION_VERSION;
  /** An opaque id for this grant, for audit. */
  authorizationId: string;
  /** Whose authorization it is. It must equal the userId the server took from the session. */
  userId: string;
  /** The profile it was granted for. It must equal the profile in use: consent to one mode does not carry to another. */
  profileId: string;
  /** The opaque id of the external recipient it applies to (the same shape as a model response's recipient). */
  recipient: string;
  /** The person's explicit decision. Only "granted" authorizes anything. */
  consent: "granted" | "not_granted";
  /** The classes of data the person authorized. Stated explicitly; never defaulted. */
  dataClasses: readonly EgressFieldClass[];
  /** When it was given and when it stops applying: ISO 8601 UTC, e.g. "2026-09-29T10:00:00Z". */
  issuedAt: string;
  expiresAt: string;
};

/** What the server knows at the moment of use, from its own trusted sources. */
export type AuthorizationContext = {
  /** From the server's session. */
  userId: string;
  /** The recipient the server is about to send to. */
  recipient: string;
  /** Milliseconds since the epoch. Passed in, so the check has no clock of its own. */
  now: number;
};

/** The resolved, frozen result: the only thing a caller should act on. */
export type EffectiveAuthorization = {
  version: typeof AUTHORIZATION_VERSION;
  authorizationId: string;
  userId: string;
  profileId: string;
  recipient: string;
  /** profile ∩ authorization, in the canonical order. */
  dataClasses: readonly EgressFieldClass[];
  /** The profile's tools whose every returned class is authorized, in the canonical order. Ready to pass as `allowedTools`. */
  allowedTools: readonly ToolName[];
  issuedAt: string;
  expiresAt: string;
};

export type AssistantAuthorizationErrorCode =
  /** No authorization, or one whose consent is absent or "not_granted". */
  | "consent_not_given"
  /** Malformed: not an object, an unknown field or version, a missing or badly shaped value, an unusable context. */
  | "authorization_invalid"
  /** Outside its validity window: expired, or not valid yet. */
  | "authorization_expired"
  /** Granted to someone else, or for another recipient. */
  | "binding_mismatch"
  /** Granted for another profile. */
  | "profile_mismatch"
  /** Names a class the profile forbids, or leaves no class set that anything can be sent under. */
  | "data_class_mismatch"
  /** The authorized recipient is not on the server's configured list of approved recipients. */
  | "recipient_not_approved";

const MESSAGES: Record<AssistantAuthorizationErrorCode, string> = {
  consent_not_given: "The person has not given explicit consent to external model processing.",
  authorization_invalid: "The authorization is malformed and authorizes nothing.",
  authorization_expired: "The authorization is outside its validity window.",
  binding_mismatch: "The authorization was not given by this user for this recipient.",
  profile_mismatch: "The authorization was not given for this assistant profile.",
  data_class_mismatch: "The authorized data classes do not fit the assistant profile.",
  recipient_not_approved: "The authorized recipient is not an approved recipient in the server's configuration.",
};

/** An authorization that authorizes nothing here. A code and a fixed message; it never repeats a user id, recipient or other value. */
export class AssistantAuthorizationError extends Error {
  readonly code: AssistantAuthorizationErrorCode;
  constructor(code: AssistantAuthorizationErrorCode) {
    super(MESSAGES[code]);
    this.name = "AssistantAuthorizationError";
    this.code = code;
  }
}

const FIELDS = ["version", "authorizationId", "userId", "profileId", "recipient", "consent", "dataClasses", "issuedAt", "expiresAt"] as const;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * The recipient id shape the model guard compares against: an exact copy of META_ID in services/assistant/model.ts, which is the
 * canonical rule. It cannot be imported from there (this module may import only pure lib/assistant modules), so a test pins that the
 * two patterns are identical.
 */
export const RECIPIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_USER_ID_CHARS = 256;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isUserId = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= MAX_USER_ID_CHARS;

/** A strict UTC timestamp, as milliseconds; null for anything else, including an impossible date such as February 30. */
function timestampOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = TIMESTAMP.exec(value);
  if (m === null) return null;
  const [year, month, day, hour, minute, second, ms] = m.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  const t = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const d = new Date(t);
  const same = d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day && d.getUTCHours() === hour && d.getUTCMinutes() === minute && d.getUTCSeconds() === second;
  return same ? t : null;
}

/**
 * Resolve what may actually be used: profile ∩ authorization, for this user, this recipient, at this moment. Throws an
 * AssistantAuthorizationError (or, for a profile that is itself unusable, resolveProfile's AssistantProfileError) and never returns a
 * partial or widened grant.
 */
export function resolveAuthorization(profile: unknown, authorization: unknown, context: unknown): EffectiveAuthorization {
  const fail = (code: AssistantAuthorizationErrorCode) => new AssistantAuthorizationError(code);
  const resolvedProfile = resolveProfile(profile);

  // Consent first: its absence is its own answer, whatever else is wrong.
  if (authorization === undefined || authorization === null) throw fail("consent_not_given");
  if (!isPlainObject(authorization)) throw fail("authorization_invalid");
  if (authorization.consent === undefined || authorization.consent === "not_granted") throw fail("consent_not_given");
  if (authorization.consent !== "granted") throw fail("authorization_invalid");

  // The shape: exactly the known fields, each well formed. Nothing is defaulted.
  const keys = Object.keys(authorization);
  if (keys.length !== FIELDS.length || !FIELDS.every((f) => keys.includes(f))) throw fail("authorization_invalid");
  const { version, authorizationId, userId, profileId, recipient, dataClasses, issuedAt, expiresAt } = authorization;
  if (version !== AUTHORIZATION_VERSION) throw fail("authorization_invalid");
  if (typeof authorizationId !== "string" || !OPAQUE_ID.test(authorizationId)) throw fail("authorization_invalid");
  if (!isUserId(userId)) throw fail("authorization_invalid");
  if (typeof profileId !== "string" || profileId.trim() === "") throw fail("authorization_invalid");
  if (typeof recipient !== "string" || !RECIPIENT_ID_PATTERN.test(recipient)) throw fail("authorization_invalid");
  if (!Array.isArray(dataClasses) || dataClasses.length === 0) throw fail("authorization_invalid");
  const known: readonly string[] = EGRESS_FIELD_CLASSES;
  const stated = new Set<string>();
  for (const c of dataClasses) {
    if (typeof c !== "string" || !known.includes(c) || stated.has(c)) throw fail("authorization_invalid");
    stated.add(c);
  }
  const issued = timestampOf(issuedAt);
  const expires = timestampOf(expiresAt);
  if (issued === null || expires === null || expires <= issued) throw fail("authorization_invalid");

  // The context comes from the server, but a broken one still authorizes nothing.
  if (!isPlainObject(context)) throw fail("authorization_invalid");
  const { userId: sessionUser, recipient: target, now } = context;
  if (!isUserId(sessionUser) || typeof target !== "string" || !RECIPIENT_ID_PATTERN.test(target)) throw fail("authorization_invalid");
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) throw fail("authorization_invalid");

  if (now < issued || now >= expires) throw fail("authorization_expired");
  if (userId !== sessionUser || recipient !== target) throw fail("binding_mismatch");
  if (profileId !== resolvedProfile.id) throw fail("profile_mismatch");

  // profile ∩ authorization. A class the profile forbids is a mismatch, never quietly granted or dropped.
  if ([...stated].some((c) => resolvedProfile.classes[c as EgressFieldClass] !== true)) throw fail("data_class_mismatch");
  // The conversation is user free text: without it nothing can be sent at all.
  if (!stated.has("user_free_text")) throw fail("data_class_mismatch");
  const effectiveClasses = EGRESS_FIELD_CLASSES.filter((c) => stated.has(c));
  const allowedTools = ASSISTANT_TOOL_NAMES.filter(
    (tool) => resolvedProfile.allowedTools.includes(tool) && classesReturnedBy(tool).every((c) => stated.has(c)),
  );
  // The orchestrator needs at least one tool; an authorization under which no tool's result may be sent is not usable.
  if (allowedTools.length === 0) throw fail("data_class_mismatch");

  return Object.freeze({
    version: AUTHORIZATION_VERSION,
    authorizationId,
    userId,
    profileId,
    recipient,
    dataClasses: Object.freeze(effectiveClasses),
    allowedTools: Object.freeze(allowedTools),
    issuedAt: issuedAt as string,
    expiresAt: expiresAt as string,
  });
}
