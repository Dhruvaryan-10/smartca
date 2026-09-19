// Shared mapping from service-layer errors to HTTP responses. Kept
// deliberately generic — no error message here ever includes internal
// details (stack traces, SQL, file paths); unexpected errors are logged
// server-side and returned to the client as a plain 500.
import { NextResponse } from "next/server";
import {
  ConflictError,
  NotAuthenticatedError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "@/services/errors";
import {
  TaxEngineInternalError,
  TaxInputValidationError,
  UnsupportedAssessmentYearError,
  UnsupportedTaxRuleError,
} from "@/tax-engine";

export function respondToError(err: unknown): NextResponse {
  // Tax-engine errors carry a stable `code` so the client can tell them
  // apart. Their messages are written for people (never stack traces, SQL
  // or paths), except an engine self-check failure, which is a bug and
  // gets a generic message.
  if (err instanceof TaxInputValidationError) {
    return NextResponse.json({ error: err.message, code: "invalid_tax_input" }, { status: 400 });
  }
  if (err instanceof UnsupportedAssessmentYearError) {
    return NextResponse.json({ error: err.message, code: "unsupported_assessment_year" }, { status: 422 });
  }
  if (err instanceof UnsupportedTaxRuleError) {
    return NextResponse.json({ error: err.message, code: "unsupported_tax_rule" }, { status: 422 });
  }
  if (err instanceof TaxEngineInternalError) {
    console.error("Tax engine self-check failed:", err);
    return NextResponse.json(
      { error: "The tax calculation could not be completed. Please try again later.", code: "tax_engine_error" },
      { status: 500 },
    );
  }

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
  // Documents and imports. Messages are written for the person uploading and
  // never contain any of the file's content. `details` is structured and
  // content-free (for example row numbers and reasons for a CSV).
  if (err instanceof ConflictError) {
    return NextResponse.json({ error: err.message, code: "conflict" }, { status: 409 });
  }
  if (err instanceof PayloadTooLargeError) {
    return NextResponse.json({ error: err.message, code: "payload_too_large" }, { status: 413 });
  }
  if (err instanceof UnsupportedMediaTypeError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 415 });
  }
  if (err instanceof UnprocessableContentError) {
    return NextResponse.json(
      { error: err.message, code: err.code, ...(err.details !== undefined ? { details: err.details } : {}) },
      { status: 422 },
    );
  }
  console.error("Unhandled API error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}
