// THE CONSENT API CONTRACT (GET/POST/DELETE /api/assistant/consent and GET /api/assistant/consent/disclosure, through consent-http.ts):
// the request a client may send, the responses it gets back, and the public form of every failure. PURE (no database, no session, no
// provider; a test pins that), and separate from the store's rows: nothing here is a database type.
//
//   GET    /disclosure  { ok: true, disclosure: { recipient, validForDays, egress } }     egress: the access plan's own EgressDisclosure
//   GET    /            { ok: true, consent: ConsentStatus }
//   POST   /            body { consent: "granted", inventoryVersion }  ->  { ok: true, consent: ConsentStatus }
//   DELETE /            { ok: true }                                    (idempotent)
//   failure             { ok: false, error: { code, category, retryable, message } }        a fixed message per code
//
// A grant body states only the person's decision and which disclosure they saw. It cannot name a user, profile, recipient, data class,
// version or validity window: every other field, and every missing or extra one, is refused. The server decides all of those.
import type { EgressDisclosure } from "@/lib/assistant/egress-disclosure";
import { toAssistantApiError } from "./api-contract";
import type { AssistantApiErrorCategory, AssistantApiErrorCode } from "./api-contract";
import { OrchestratorError } from "./orchestrator";

/** The only body a grant accepts: the explicit decision, and the `inventoryVersion` of the disclosure the person was shown. */
export type ConsentGrantRequest = Readonly<{ consent: "granted"; inventoryVersion: string }>;

/** "outdated": granted for an earlier egress inventory; the person must review the current disclosure and grant again. */
export type ConsentState = "none" | "active" | "expired" | "outdated" | "revoked" | "invalid";
/** Whether the signed-in person's consent for the configured recipient would authorize a run now. Never a database row. */
export type ConsentStatus = Readonly<{ state: ConsentState; valid: boolean; recipient: string; expiresAt: string | null }>;
export type ConsentDisclosure = Readonly<{ recipient: string; validForDays: number; egress: EgressDisclosure }>;

export type ConsentApiErrorCode = AssistantApiErrorCode | "disclosure_outdated";
export type ConsentApiError = Readonly<{ code: ConsentApiErrorCode; category: AssistantApiErrorCategory; retryable: boolean; message: string }>;
type Failure = Readonly<{ ok: false; error: ConsentApiError }>;
export type ConsentDisclosureResponse = Readonly<{ ok: true; disclosure: ConsentDisclosure }> | Failure;
export type ConsentStatusResponse = Readonly<{ ok: true; consent: ConsentStatus }> | Failure;
export type ConsentRevokeResponse = Readonly<{ ok: true }> | Failure;
export type ConsentApiResponse = ConsentDisclosureResponse | ConsentStatusResponse | ConsentRevokeResponse;

/** A consent request that cannot be accepted: its body is malformed, or the disclosure it acknowledges is no longer the current one. */
export class ConsentRequestError extends Error {
  constructor(readonly code: "invalid_request" | "disclosure_outdated") {
    super(code === "invalid_request" ? "The consent request is malformed." : "The disclosure acknowledged is not the current one.");
    this.name = "ConsentRequestError";
  }
}

// api-contract maps an orchestrator "invalid_input" to invalid_request: reusing it keeps one public message for that code.
const invalidRequest = new OrchestratorError("invalid_input", "The consent request is malformed.");

const OUTDATED: ConsentApiError = Object.freeze({
  code: "disclosure_outdated",
  category: "validation",
  retryable: false,
  message: "What the assistant shares has changed. Review the current disclosure and grant again.",
});

/** The public form of any error a consent operation throws: a stable code and a fixed message, never the error's own text. */
export function toConsentApiError(error: unknown): ConsentApiError {
  if (error instanceof ConsentRequestError) return error.code === "disclosure_outdated" ? OUTDATED : toAssistantApiError(invalidRequest);
  return toAssistantApiError(error);
}

const INVENTORY_VERSION = /^[A-Za-z0-9-]{1,64}$/;

/** Strictly read a grant body: exactly { consent: "granted", inventoryVersion }. Anything else is a ConsentRequestError. */
export function parseConsentGrantRequest(body: unknown): ConsentGrantRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.getPrototypeOf(body) !== Object.prototype) throw new ConsentRequestError("invalid_request");
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes("consent") || !keys.includes("inventoryVersion")) throw new ConsentRequestError("invalid_request");
  const { consent, inventoryVersion } = body as Record<string, unknown>;
  if (consent !== "granted" || typeof inventoryVersion !== "string" || !INVENTORY_VERSION.test(inventoryVersion)) throw new ConsentRequestError("invalid_request");
  return Object.freeze({ consent, inventoryVersion });
}
