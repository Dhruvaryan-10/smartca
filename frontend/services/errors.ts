// Shared error types for the service layer and its API-route callers.
//
// NotFoundError is deliberately the SAME error whether a record truly
// doesn't exist or exists but belongs to another user — callers must
// map it to a 404, never a 403, so a client can never distinguish
// "not yours" from "doesn't exist" (see Phase 1B authorization spec).

export class NotFoundError extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class NotAuthenticatedError extends Error {
  constructor(message = "Not authenticated.") {
    super(message);
    this.name = "NotAuthenticatedError";
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class EmailAlreadyRegisteredError extends Error {
  constructor(message = "An account with this email already exists.") {
    super(message);
    this.name = "EmailAlreadyRegisteredError";
  }
}

// ---------------------------------------------------------------------
// Phase 4: documents and imports
// ---------------------------------------------------------------------

/** The request conflicts with existing state (for example the same file uploaded twice). HTTP 409. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** The upload is larger than allowed. HTTP 413. */
export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/** The bytes are not the kind of file this endpoint accepts. HTTP 415. */
export class UnsupportedMediaTypeError extends Error {
  constructor(
    message: string,
    readonly code = "unsupported_media_type",
  ) {
    super(message);
    this.name = "UnsupportedMediaTypeError";
  }
}

/**
 * The request was understood and the file is the right kind, but its
 * content cannot be used (an encrypted PDF, a scanned Form 16, a CSV with
 * invalid rows). HTTP 422. `code` is stable for clients; `details` carries
 * structured, content-free information such as row-level CSV errors.
 */
export class UnprocessableContentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "UnprocessableContentError";
  }
}
