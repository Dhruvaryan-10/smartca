// Client-side fetch helper for the Vault. Turns every failure into an ApiFailure
// carrying a message written for the person using the app.

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
    throw new ApiFailure(
      typeof body.error === "string" ? body.error : "Something went wrong. Please try again.",
      typeof body.code === "string" ? body.code : undefined,
      res.status,
      body.details,
    );
  }
  return data as T;
}

export const messageOf = (err: unknown): string =>
  err instanceof ApiFailure ? err.message : "Something went wrong. Please try again.";

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatUploaded(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
