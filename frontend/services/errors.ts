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
