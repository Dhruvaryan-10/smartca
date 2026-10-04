// Client-side JSON fetch helper shared by the app's pages (Ledger, Tax, Vault). Turns every failure into an ApiFailure carrying a
// message written for the person using the app; the server's own `error` text is used when it sends one.

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiFailure("Couldn’t reach SmartCA. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;

  // An expired session is redirected to the login page, which is HTML, not JSON.
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new ApiFailure("Your session may have expired. Log in again to continue.", "session", res.status);
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const body = (data ?? {}) as { error?: unknown; code?: unknown; details?: unknown };
    const serverMessage = typeof body.error === "string" ? body.error : null;
    // A 5xx with a `code` (the tax engine's) carries a message written for people; the generic 500 has none.
    const written = res.status >= 500 ? (typeof body.code === "string" ? serverMessage : null) : serverMessage;
    throw new ApiFailure(
      STATUS_MESSAGES[res.status] ?? written ?? (res.status >= 500 ? SERVER_FAILURE : "Something went wrong. Please try again."),
      typeof body.code === "string" ? body.code : res.status === 401 ? "session" : undefined,
      res.status,
      body.details,
    );
  }
  return data as T;
}

// Statuses whose server text is a bare HTTP phrase ("Unauthorized", "Not found", "Internal server error") get the app's own
// wording. Validation, conflict and upload refusals (400, 409, 413, 415, 422) keep the server's message: it is written for people.
const SERVER_FAILURE = "Something went wrong on SmartCA’s side. Please try again.";
const STATUS_MESSAGES: Record<number, string> = {
  401: "Your session may have expired. Log in again to continue.",
  403: "You don’t have access to this.",
  404: "This item couldn’t be found. It may have been deleted.",
  429: "Too many requests. Wait a moment and try again.",
};

export const messageOf = (err: unknown): string =>
  err instanceof ApiFailure ? err.message : "Something went wrong. Please try again.";
