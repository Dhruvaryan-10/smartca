// Small helper for reading real PostgreSQL error codes back out of
// errors thrown by the `pg` driver / Drizzle. Drizzle wraps the
// underlying pg error (which carries `.code`, e.g. 23505/23503) inside
// its own DrizzleQueryError as `.cause` — this checks both shapes so
// callers don't need to know which layer threw.
export function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    const direct = (err as { code?: unknown }).code;
    if (typeof direct === "string") return direct;
    const cause = (err as { cause?: unknown }).cause;
    if (typeof cause === "object" && cause !== null) {
      const causeCode = (cause as { code?: unknown }).code;
      if (typeof causeCode === "string") return causeCode;
    }
  }
  return undefined;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23505";
}

export function isForeignKeyViolation(err: unknown): boolean {
  return pgErrorCode(err) === "23503";
}
