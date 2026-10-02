// THE HTTP BOUNDARY of the assistant: one function from a web Request to a web Response, around the application service (service.ts).
// The route (app/api/assistant/route.ts) is a single call to it with the real session reader; everything else here is a default that
// only server code can replace (tests inject a configuration, a recording provider, a clock and an event sink). It uses no framework
// type, so it runs, and is tested, without Next.js.
//
//   Request -> method POST -> the user FROM THE SERVER SESSION (never the body; without one, the body is not even read)
//           -> the body: application/json, at most MAX_ASSISTANT_BODY_BYTES (not read past it), valid UTF-8 JSON; anything else is
//              handed on as "no body", which the service refuses as invalid_request and records
//           -> handleAssistantRequest(session, body, deps): body shape { messages } only, configuration, consent from the database,
//              access plan, limits, run, audit (service.ts; nothing here repeats or skips a step of it)
//           -> the public response (api-contract.ts) as JSON, with an HTTP status from its category, never cached
//   The request's own signal is passed on: a client that disconnects cancels the run (request_cancelled), with no further provider call.
//
// What a client can choose: only the text of its messages. The user, profile, tools, data classes, recipient, provider, model, endpoint
// and limits come from the session, the code and the server's configuration; a body naming any of them is refused by the service. The
// response carries no key, endpoint, user id, consent record or error text (api-contract.ts). A cross-site HTML form cannot send
// application/json, so requiring it also keeps a signed-in person's browser from being made to post here by another site.
import { MAX_USER_MESSAGES } from "./ask";
import { readAssistantConfig } from "./config";
import type { AssistantConfig } from "./config";
import { MAX_MESSAGE_CHARS } from "./model";
import type { ProviderDriver } from "./provider";
import { handleAssistantRequest } from "./service";
import type { AssistantApiErrorCategory, AssistantApiResponse } from "./api-contract";
import type { AssistantEventSink } from "./events";
import type { RunLimiter } from "@/lib/assistant/run-limits";

/**
 * The largest request body read, in bytes: the most messages the service accepts, each of the most characters, at up to 3 UTF-8 bytes
 * per character, plus room for the JSON around them. A larger body is refused without being read.
 */
export const MAX_ASSISTANT_BODY_BYTES = MAX_USER_MESSAGES * MAX_MESSAGE_CHARS * 3 + 4_096;

export type AssistantHttpDeps = {
  /** The signed-in user's id from the server-verified session (services/session.ts), or null. The only source of identity. */
  getSessionUserId: () => Promise<string | null>;
  /** Defaults to reading the server's environment on each request (readAssistantConfig), which fails closed. */
  config?: AssistantConfig | (() => AssistantConfig);
  /** Defaults to the registry's driver for the configuration's MODEL_WIRE_FORMAT (provider-registry.ts), chosen by the service. */
  driver?: ProviderDriver;
  now?: () => number;
  onEvent?: AssistantEventSink;
  limiter?: RunLimiter;
};

/** The HTTP status of each public error category (the consent API, consent-http.ts, uses the same one). */
export const HTTP_STATUS_BY_CATEGORY: Readonly<Record<AssistantApiErrorCategory, number>> = {
  authentication: 401,
  consent: 403,
  rate_limit: 429,
  validation: 400,
  configuration: 503,
  provider: 502,
  assistant: 422,
  internal: 500,
};

/** The HTTP status of a public response: 200 for an answer, otherwise one per error category (504 for a provider timeout). */
export function httpStatusOf(response: AssistantApiResponse): number {
  if (response.ok) return 200;
  if (response.error.code === "provider_timeout") return 504;
  return HTTP_STATUS_BY_CATEGORY[response.error.category] ?? 500;
}

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
/** A JSON response that is never cached or sniffed. */
export const jsonResponse = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: HEADERS });

/** The signed-in user's id, or null. A session reader that fails, or returns anything but a non-blank string, authenticates nobody. */
export async function readSessionUser(getSessionUserId: () => Promise<string | null>): Promise<string | null> {
  try {
    const id = await getSessionUserId();
    return typeof id === "string" && id.trim() !== "" ? id : null;
  } catch {
    return null;
  }
}

/** The body as JSON, or null for anything unusable: another content type, too large, not UTF-8, not JSON. Never reads past the cap. */
export async function readJsonBody(request: Request, maxBytes: number = MAX_ASSISTANT_BODY_BYTES): Promise<unknown> {
  const discard = () => request.body?.cancel().catch(() => undefined);
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") {
    await discard();
    return null;
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard();
    return null;
  }
  if (request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

export async function handleAssistantHttp(request: Request, deps: AssistantHttpDeps): Promise<Response> {
  if (request.method !== "POST") {
    await request.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
  }

  // Identity from the server session only. A session reader that fails authenticates nobody.
  const userId = await readSessionUser(deps.getSessionUserId);

  // Without a user the body is never read: the service answers not_authenticated before anything else.
  const body = userId === null ? null : await readJsonBody(request);
  if (userId === null) await request.body?.cancel().catch(() => undefined);

  const response = await handleAssistantRequest(userId === null ? null : { userId }, body, {
    config: deps.config ?? (() => readAssistantConfig()),
    ...(deps.driver === undefined ? {} : { driver: deps.driver }),
    // The client's connection: when it goes away (Next.js aborts request.signal when the response closes unfinished), the run stops at its
    // next model call, and an in-flight provider request is aborted, so nobody pays for an answer nobody will read.
    signal: request.signal,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.onEvent === undefined ? {} : { onEvent: deps.onEvent }),
    ...(deps.limiter === undefined ? {} : { limiter: deps.limiter }),
  });
  return jsonResponse(response, httpStatusOf(response));
}
