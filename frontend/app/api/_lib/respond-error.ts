// Shared mapping from service-layer errors to HTTP responses. Kept
// deliberately generic — no error message here ever includes internal
// details (stack traces, SQL, file paths); unexpected errors are logged
// server-side and returned to the client as a plain 500.
import { NextResponse } from "next/server";
import { NotAuthenticatedError, NotFoundError, ValidationError } from "@/services/errors";

export function respondToError(err: unknown): NextResponse {
  if (err instanceof NotAuthenticatedError) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (err instanceof NotFoundError) {
    // Deliberately identical to "doesn't exist" — see services/errors.ts.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (err instanceof ValidationError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error("Unhandled API error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
