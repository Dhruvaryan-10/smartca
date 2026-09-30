// The PERSISTENCE of a person's assistant authorization (consent): the only code that creates, finds or revokes one. Server-side only:
// every function takes the userId from the caller's server session (services/session.ts), and every query is filtered by it, so one
// person can never read, use or revoke another's authorization. A client never supplies an authorization; it is read from here.
//
// What it stores is exactly the typed authorization (lib/assistant/authorization.ts), including the egress inventory fingerprint the
// person was shown (`inventoryVersion`, read back so the access plan can refuse a grant for another inventory), plus a revocation time. Rows are never deleted here: a revoked or expired authorization stays on record, authorizes
// nothing, and remains linked to the audit rows of the runs it permitted (assistant_runs.authorization_id).
//
// Lookup semantics: the most recently issued authorization for this user, recipient and profile decides. If it is revoked, the answer
// is "revoked" even if an older one was never revoked: withdrawing consent must not fall back to an earlier grant.
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { assistantAuthorizations } from "@/db/schema";
import { AUTHORIZATION_VERSION, RECIPIENT_ID_PATTERN } from "@/lib/assistant/authorization";
import type { AssistantAuthorization } from "@/lib/assistant/authorization";
import { fingerprintInventory } from "@/lib/assistant/egress-disclosure";
import { EGRESS_FIELD_CLASSES } from "@/lib/assistant/profiles";
import type { EgressFieldClass } from "@/lib/assistant/tool-contract";
import { NotAuthenticatedError, ValidationError } from "../errors";

export type GrantInput = {
  profileId: string;
  recipient: string;
  dataClasses: readonly EgressFieldClass[];
  issuedAt: Date;
  expiresAt: Date;
};

export type AuthorizationLookup =
  | { status: "active"; authorization: AssistantAuthorization }
  | { status: "revoked"; authorizationId: string }
  | { status: "none" };

type Row = typeof assistantAuthorizations.$inferSelect;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const requireUser = (userId: unknown): string => {
  if (typeof userId !== "string" || userId.trim() === "") throw new NotAuthenticatedError();
  return userId;
};

function toAuthorization(row: Row): AssistantAuthorization {
  return {
    version: row.formatVersion as typeof AUTHORIZATION_VERSION,
    authorizationId: row.id,
    userId: row.userId,
    profileId: row.profileId,
    recipient: row.recipient,
    consent: row.consent as "granted" | "not_granted",
    dataClasses: [...row.dataClasses] as EgressFieldClass[],
    issuedAt: iso(row.issuedAt),
    expiresAt: iso(row.expiresAt),
    inventoryVersion: row.inventoryVersion,
  };
}

/** Record a person's explicit grant. Validates what is recorded; the grant is checked again, in full, every time it is used. */
export async function grantAssistantAuthorization(userId: string, input: GrantInput): Promise<AssistantAuthorization> {
  const owner = requireUser(userId);
  const classes = [...new Set(input.dataClasses)];
  if (typeof input.profileId !== "string" || input.profileId.trim() === "") throw new ValidationError("A profile is required.");
  if (typeof input.recipient !== "string" || !RECIPIENT_ID_PATTERN.test(input.recipient)) throw new ValidationError("The recipient is not a plain identifier.");
  if (classes.length === 0 || classes.length !== input.dataClasses.length || !classes.every((c) => EGRESS_FIELD_CLASSES.includes(c))) {
    throw new ValidationError("The data classes must be a non-empty list of known classes, each once.");
  }
  if (!(input.issuedAt instanceof Date) || !(input.expiresAt instanceof Date) || !(input.expiresAt.getTime() > input.issuedAt.getTime())) {
    throw new ValidationError("The authorization needs a validity window that ends after it starts.");
  }
  const [row] = await db
    .insert(assistantAuthorizations)
    .values({
      userId: owner,
      formatVersion: AUTHORIZATION_VERSION,
      profileId: input.profileId,
      recipient: input.recipient,
      consent: "granted",
      dataClasses: EGRESS_FIELD_CLASSES.filter((c) => classes.includes(c)),
      inventoryVersion: fingerprintInventory(),
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  return toAuthorization(row);
}

/** Withdraw one of the person's own authorizations. True if it was active and is now revoked; false if not theirs or already revoked. */
export async function revokeAssistantAuthorization(userId: string, authorizationId: string, at: Date = new Date()): Promise<boolean> {
  const owner = requireUser(userId);
  if (typeof authorizationId !== "string" || !/^[0-9a-f-]{36}$/i.test(authorizationId)) return false;
  const updated = await db
    .update(assistantAuthorizations)
    .set({ revokedAt: at })
    .where(and(eq(assistantAuthorizations.id, authorizationId), eq(assistantAuthorizations.userId, owner), isNull(assistantAuthorizations.revokedAt)))
    .returning({ id: assistantAuthorizations.id });
  return updated.length === 1;
}

/**
 * Withdraw every one of the person's authorizations that is not already revoked, whatever its recipient or profile, so withdrawing never
 * depends on the server's current configuration. Idempotent: returns how many were revoked by this call (0 when none were active).
 */
export async function revokeAllAssistantAuthorizations(userId: string, at: Date = new Date()): Promise<number> {
  const owner = requireUser(userId);
  const updated = await db
    .update(assistantAuthorizations)
    .set({ revokedAt: at })
    .where(and(eq(assistantAuthorizations.userId, owner), isNull(assistantAuthorizations.revokedAt)))
    .returning({ id: assistantAuthorizations.id });
  return updated.length;
}

/** The authorization that decides for this person, recipient and profile, if any. Expiry is checked by resolveAuthorization at use. */
export async function findAssistantAuthorization(userId: string, target: { profileId: string; recipient: string }): Promise<AuthorizationLookup> {
  const owner = requireUser(userId);
  const [latest] = await db
    .select()
    .from(assistantAuthorizations)
    .where(and(eq(assistantAuthorizations.userId, owner), eq(assistantAuthorizations.recipient, target.recipient), eq(assistantAuthorizations.profileId, target.profileId)))
    .orderBy(desc(assistantAuthorizations.issuedAt), desc(assistantAuthorizations.createdAt))
    .limit(1);
  if (latest === undefined) return { status: "none" };
  if (latest.revokedAt !== null) return { status: "revoked", authorizationId: latest.id };
  return { status: "active", authorization: toAuthorization(latest) };
}
