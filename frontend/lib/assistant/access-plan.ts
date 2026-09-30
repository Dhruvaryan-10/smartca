// THE MODEL ACCESS PLAN: the single place that turns an access profile, a person's authorization and the server's configured recipients
// into what one run may do and what its model may see. PURE: it imports only other pure lib/assistant modules, and reaches no database,
// session, provider, network or clock (a test pins that). It persists nothing and logs nothing: the audit record it builds is returned
// for a future audit log to store.
//
//   profile (the mode)  ∩  authorization (the person, the recipient, the classes, the window)  ∩  configured recipients (the server)
//     -> { allowedTools, visibleClasses, approvedRecipients, audit }
//
// Why it exists: those are four separate mechanisms (profiles.ts, authorization.ts, egress-filter.ts, the configuration's approved
// recipients), and passing some of them without the others is unsafe: tools without `visibleClasses` send every result whole, and an
// authorization for a recipient the configuration never approved must not run. A plan carries all of them together, so a future entry
// point passes `allowedTools`, `visibleClasses` and `approvedRecipients` from one object, never one without the others.
//
// It decides no egress policy: the classes and tools are whatever the profile and the person's authorization allow, intersected.
import { AssistantAuthorizationError, resolveAuthorization } from "./authorization";
import type { EffectiveAuthorization } from "./authorization";
import type { EgressClasses } from "./egress-filter";
import { describeEgress } from "./egress-disclosure";
import type { EgressDisclosure } from "./egress-disclosure";
import { EGRESS_FIELD_CLASSES } from "./profiles";
import type { EgressFieldClass, ToolName } from "./tool-contract";

/** Metadata about a run's access, for an audit log: ids, classes, tools and times. Never a value from the person's data or a result. */
export type AccessAuditRecord = Readonly<{
  authorizationId: string;
  userId: string;
  profileId: string;
  recipient: string;
  allowedTools: readonly ToolName[];
  visibleClasses: readonly EgressFieldClass[];
  issuedAt: string;
  expiresAt: string;
  /** The egress inventory's fingerprint: which field list the run's disclosure was derived from. */
  inventoryVersion: string;
  /** When the plan was made, as milliseconds since the epoch (the caller's `now`). */
  plannedAt: number;
}>;

export type ModelAccessPlan = Readonly<{
  /** Pass as the orchestrator's `allowedTools`. */
  allowedTools: readonly ToolName[];
  /** Pass as the orchestrator's `visibleClasses`: exactly the authorized classes are true. */
  visibleClasses: EgressClasses;
  /** Pass as the model policy's `approvedRecipients`: only the authorized recipient, and only if the configuration approves it. */
  approvedRecipients: readonly string[];
  /** Exactly what this run sends and withholds, field by field (egress-disclosure.ts). */
  disclosure: EgressDisclosure;
  audit: AccessAuditRecord;
}>;

/**
 * Plan one run's access. Throws AssistantAuthorizationError (consent, validity, binding, profile, class, recipient or inventory) or
 * AssistantProfileError, and never returns a partial or widened plan. `configuredRecipients` is the server configuration's approved
 * list (MODEL_APPROVED_RECIPIENTS); a malformed list is a mistake in code (a RangeError), and an empty one approves nothing.
 */
export function planModelAccess(profile: unknown, authorization: unknown, context: unknown, configuredRecipients: readonly string[]): ModelAccessPlan {
  if (!Array.isArray(configuredRecipients) || !configuredRecipients.every((r) => typeof r === "string")) {
    throw new RangeError("configuredRecipients must be the configuration's list of approved recipient ids.");
  }
  const effective: EffectiveAuthorization = resolveAuthorization(profile, authorization, context);
  // The authorization names a recipient; the configuration decides whether the server may talk to it at all. Both must agree.
  if (!configuredRecipients.includes(effective.recipient)) throw new AssistantAuthorizationError("recipient_not_approved");

  const shown = new Set<EgressFieldClass>(effective.dataClasses);
  const visibleClasses = Object.freeze(Object.fromEntries(EGRESS_FIELD_CLASSES.map((c) => [c, shown.has(c)])) as Record<EgressFieldClass, boolean>);
  const disclosure = describeEgress(effective.allowedTools, visibleClasses);
  // Consent covers exactly the inventory the person was shown: a grant for any other one (a field, class or tool added, removed or
  // reclassified since) authorizes nothing until the person grants the current disclosure. This is not AUTHORIZATION_VERSION.
  if (effective.inventoryVersion !== disclosure.inventoryVersion) throw new AssistantAuthorizationError("inventory_changed");
  const audit: AccessAuditRecord = Object.freeze({
    authorizationId: effective.authorizationId,
    userId: effective.userId,
    profileId: effective.profileId,
    recipient: effective.recipient,
    allowedTools: effective.allowedTools,
    visibleClasses: effective.dataClasses,
    issuedAt: effective.issuedAt,
    expiresAt: effective.expiresAt,
    inventoryVersion: disclosure.inventoryVersion,
    plannedAt: (context as { now: number }).now,
  });
  return Object.freeze({
    allowedTools: effective.allowedTools,
    visibleClasses,
    approvedRecipients: Object.freeze([effective.recipient]),
    disclosure,
    audit,
  });
}
