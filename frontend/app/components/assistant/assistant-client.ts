// Browser client for the assistant's HTTP API. The UI reaches the assistant only over HTTP: it never imports the assistant's server
// code or types (an architecture test pins that). The wire types below describe the JSON the API returns, as far as the panel reads
// it; tests/ask-smartca-ui.test.ts checks at compile time that the server's own response types still fit them.
//
//   POST   /api/assistant                     { messages }                                -> { ok, answer } | { ok: false, error }
//   GET    /api/assistant/consent             -                                           -> { ok, consent } | failure
//   GET    /api/assistant/consent/disclosure  -                                           -> { ok, disclosure } | failure
//   POST   /api/assistant/consent             { consent: "granted", inventoryVersion }    (inventoryVersion from the disclosure, as received)
//   DELETE /api/assistant/consent             -                                           -> { ok: true } | failure
//
// The user, profile, recipient, tools and limits are decided on the server; nothing else is sent.

/** The most user messages one request may carry (the server's limit; a test pins that they agree). */
export const MAX_SENT_MESSAGES = 20;

// ---------------------------------------------------------------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------------------------------------------------------------

export type AnswerState = "answered" | "insufficient_evidence" | "unsupported" | "withheld";
type FactOrigin = Readonly<{ callId: string; round: number }>;

export type AnswerEvidence = Readonly<{
  title: string;
  publisher: string;
  url: string;
  sectionRef: string | null;
  quote: string;
  assessmentYear: string;
}>;
export type AnswerTaxValue = FactOrigin &
  Readonly<{
    shape: "single_regime" | "regime_comparison" | "scenario";
    assessmentYear: string;
    engineVersion: string | null;
    rulesVersion: string | null;
    notice: string | null;
  }>;
export type AnswerLedger = FactOrigin & Readonly<{ shape: "transactions" | "summary"; notice: string | null }>;
export type AnswerRefusal = FactOrigin & Readonly<{ message: string }>;

/** An assistant answer: the model's text (if released) kept apart from the tool facts and citations it rests on. */
export type AssistantAnswer = Readonly<{
  state: AnswerState;
  text: Readonly<{ origin: "model"; content: string }> | null;
  citations: ReadonlyArray<Readonly<{ evidenceId: string; evidence: AnswerEvidence }>>;
  facts: Readonly<{
    taxValues: readonly AnswerTaxValue[];
    ledger: readonly AnswerLedger[];
    refusals: readonly AnswerRefusal[];
  }>;
  notices: readonly string[];
  authority: Readonly<{ guidanceOnly: boolean }>;
}>;

export type ConsentStatusView = Readonly<{ state: string; valid: boolean; recipient: string; expiresAt: string | null }>;
export type DisclosedFieldView = Readonly<{ path: string; class: string }>;
export type ConsentDisclosureView = Readonly<{
  recipient: string;
  validForDays: number;
  egress: Readonly<{
    inventoryVersion: string;
    tools: ReadonlyArray<Readonly<{ tool: string; sent: readonly DisclosedFieldView[]; withheld: readonly DisclosedFieldView[] }>>;
  }>;
}>;

export type ServerErrorCategory =
  | "authentication"
  | "consent"
  | "rate_limit"
  | "validation"
  | "configuration"
  | "provider"
  | "assistant"
  | "internal";

/** A failure as the panel sees it: the server's public error, or one of two client-side conditions. */
export type ClientError = Readonly<{
  code: string;
  category: ServerErrorCategory | "network" | "cancelled";
  retryable: boolean;
  message: string;
}>;

export type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ClientError }>;

// ---------------------------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------------------------

const NETWORK: ClientError = {
  code: "network",
  category: "network",
  retryable: true,
  message: "SmartCA couldn't reach the server. Check your connection and try again.",
};
const CANCELLED: ClientError = { code: "cancelled", category: "cancelled", retryable: false, message: "You cancelled this question." };
const SESSION_ENDED: ClientError = {
  code: "not_authenticated",
  category: "authentication",
  retryable: false,
  message: "Your session has ended. Sign in again to continue.",
};

type Envelope = { ok: true } & Record<string, unknown>;
type Failure = { ok: false; error: ClientError };

function isEnvelope(body: unknown): body is Envelope | Failure {
  return typeof body === "object" && body !== null && typeof (body as { ok?: unknown }).ok === "boolean";
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

async function call<T>(url: string, init: RequestInit, pick: (body: Envelope) => T): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch (error) {
    return { ok: false, error: isAbort(error) ? CANCELLED : NETWORK };
  }
  // An expired session is redirected to the sign-in page by the proxy, which arrives here as HTML rather than JSON.
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    return { ok: false, error: response.redirected || response.status === 401 ? SESSION_ENDED : NETWORK };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, error: isAbort(error) ? CANCELLED : NETWORK };
  }
  if (!isEnvelope(body)) return { ok: false, error: NETWORK };
  if (!body.ok) return { ok: false, error: (body as Failure).error };
  return { ok: true, value: pick(body as Envelope) };
}

const JSON_HEADERS = { "content-type": "application/json" };

export function fetchConsentStatus(signal?: AbortSignal): Promise<Result<ConsentStatusView>> {
  return call("/api/assistant/consent", { method: "GET", signal }, (body) => body.consent as ConsentStatusView);
}

export function fetchConsentDisclosure(signal?: AbortSignal): Promise<Result<ConsentDisclosureView>> {
  return call("/api/assistant/consent/disclosure", { method: "GET", signal }, (body) => body.disclosure as ConsentDisclosureView);
}

export function postConsentGrant(inventoryVersion: string): Promise<Result<ConsentStatusView>> {
  return call(
    "/api/assistant/consent",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ consent: "granted", inventoryVersion }) },
    (body) => body.consent as ConsentStatusView,
  );
}

export function deleteConsent(): Promise<Result<true>> {
  return call("/api/assistant/consent", { method: "DELETE" }, () => true as const);
}

export function postQuestion(messages: readonly string[], signal?: AbortSignal): Promise<Result<AssistantAnswer>> {
  return call(
    "/api/assistant",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ messages: messages.slice(-MAX_SENT_MESSAGES) }), signal },
    (body) => body.answer as AssistantAnswer,
  );
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Presentation rules
// ---------------------------------------------------------------------------------------------------------------------------------

/** How the panel responds to a failure. */
export type ErrorTreatment = "signin" | "consent" | "unavailable" | "retry" | "cancelled" | "message";

export function treatmentFor(error: ClientError): ErrorTreatment {
  if (error.category === "cancelled") return "cancelled";
  if (error.category === "authentication") return "signin";
  if (error.category === "consent" || error.code === "disclosure_outdated") return "consent";
  if (error.category === "configuration") return "unavailable";
  if (error.retryable) return "retry";
  return "message";
}

/** Only http(s) evidence links are rendered as links. */
export function safeExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
