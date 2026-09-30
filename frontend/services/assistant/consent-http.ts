// THE CONSENT HTTP BOUNDARY: web Request -> web Response around the consent service (consent-service.ts). The routes
// (app/api/assistant/consent/route.ts and .../consent/disclosure/route.ts) are single calls to it with the real session reader.
//
//   GET    /api/assistant/consent/disclosure  -> getConsentDisclosure
//   GET    /api/assistant/consent             -> getConsentStatus
//   POST   /api/assistant/consent             -> parseConsentGrantRequest (application/json, at most MAX_CONSENT_BODY_BYTES) -> grantConsent
//   DELETE /api/assistant/consent             -> revokeConsent
//
// The user comes FROM THE SERVER SESSION only; without one nothing is read and the answer is not_authenticated. No request field, query
// or header selects a user, profile, recipient, class, version or window. Every response is a consent-contract.ts shape, never a row,
// and every failure a stable code with a fixed message (no error text, stack, SQL or configuration value). Nothing is cached.
import { readAssistantConfig } from "./config";
import type { AssistantConfig } from "./config";
import { HTTP_STATUS_BY_CATEGORY, jsonResponse, readJsonBody, readSessionUser } from "./http";
import { parseConsentGrantRequest, toConsentApiError } from "./consent-contract";
import type { ConsentApiError, ConsentApiResponse } from "./consent-contract";
import { getConsentDisclosure, getConsentStatus, grantConsent, revokeConsent } from "./consent-service";
import type { ConsentServiceDeps } from "./consent-service";
import { NotAuthenticatedError } from "../errors";

/** The largest grant body read, in bytes. The only valid body is two short fields. */
export const MAX_CONSENT_BODY_BYTES = 1_024;

export type ConsentHttpDeps = {
  /** The signed-in user's id from the server-verified session (services/session.ts), or null. The only source of identity. */
  getSessionUserId: () => Promise<string | null>;
  /** Defaults to reading the server's environment on each request (readAssistantConfig), which fails closed. */
  config?: AssistantConfig | (() => AssistantConfig);
  now?: () => number;
};

function statusOf(error: ConsentApiError): number {
  if (error.code === "disclosure_outdated") return 409;
  return HTTP_STATUS_BY_CATEGORY[error.category] ?? 500;
}

async function respond(run: () => Promise<ConsentApiResponse>): Promise<Response> {
  try {
    return jsonResponse(await run(), 200);
  } catch (error) {
    const publicError = toConsentApiError(error);
    return jsonResponse(Object.freeze({ ok: false, error: publicError }), statusOf(publicError));
  }
}

const discard = (request: Request) => request.body?.cancel().catch(() => undefined);
const notAllowed = async (request: Request, allow: string) => {
  await discard(request);
  return new Response(null, { status: 405, headers: { allow, "cache-control": "no-store" } });
};

async function sessionAndDeps(request: Request, deps: ConsentHttpDeps, readsBody: boolean) {
  const userId = await readSessionUser(deps.getSessionUserId);
  if (userId === null || !readsBody) await discard(request);
  const service: ConsentServiceDeps = { config: deps.config ?? (() => readAssistantConfig()), ...(deps.now === undefined ? {} : { now: deps.now }) };
  return { session: userId === null ? null : { userId }, service };
}

/** GET status, POST grant, DELETE revoke. */
export async function handleConsentHttp(request: Request, deps: ConsentHttpDeps): Promise<Response> {
  const method = request.method;
  if (method !== "GET" && method !== "POST" && method !== "DELETE") return notAllowed(request, "GET, POST, DELETE");
  const { session, service } = await sessionAndDeps(request, deps, method === "POST");
  return respond(async () => {
    // Without a session nothing is read, not even the body.
    if (session === null) throw new NotAuthenticatedError();
    if (method === "GET") return { ok: true, consent: await getConsentStatus(session, service) };
    if (method === "DELETE") {
      await revokeConsent(session, service);
      return { ok: true };
    }
    const grant = parseConsentGrantRequest(await readJsonBody(request, MAX_CONSENT_BODY_BYTES));
    return { ok: true, consent: await grantConsent(session, grant, service) };
  });
}

/** GET the disclosure a person must see before granting. */
export async function handleConsentDisclosureHttp(request: Request, deps: ConsentHttpDeps): Promise<Response> {
  if (request.method !== "GET") return notAllowed(request, "GET");
  const { session, service } = await sessionAndDeps(request, deps, false);
  return respond(async () => ({ ok: true, disclosure: await getConsentDisclosure(session, service) }));
}
