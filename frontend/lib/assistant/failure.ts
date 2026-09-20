// The assistant's error boundary. PURE: no imports at all (a test pins that), so it pulls in no database client and no logger.
//
// When something UNEXPECTED goes wrong (a database error in a tool, a provider's own failure, a bug), what may leave the
// assistant, to a log or to a caller, is deliberately tiny: a code, the error's CLASS NAME, and for a database error the
// database's own error code. Never its message, its statement, its bound parameters, its cause, a raw tool result, or anything a
// model wrote.
//
// Why: a Drizzle query error builds its message as `Failed query: <sql>\nparams: <parameters>`, so for a ledger query the
// authenticated userId sits in the message of an error that otherwise looks harmless; a provider SDK error can quote a request
// body or a credential. Typed errors that MEAN something (a refusal, an OrchestratorError, NotAuthenticatedError) are not
// touched by this: they are written to be safe, and callers rely on their codes.

export const ASSISTANT_FAILURE_CODES = ["tool_failed", "unexpected_failure"] as const;
export type AssistantFailureCode = (typeof ASSISTANT_FAILURE_CODES)[number];

const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DATABASE_CODE = /^[0-9A-Za-z_]{1,32}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** A property of an arbitrary thrown value, or undefined: reading it must never throw (a getter can). */
function read(value: unknown, key: string): unknown {
  try {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/** The error's class name, only when it is a plain identifier. A name with a space, a newline or an id in it is dropped, not echoed. */
function classNameOf(error: unknown): string | null {
  const name = read(error, "name");
  return typeof name === "string" && CLASS_NAME.test(name) ? name : null;
}

/** A PostgreSQL error code such as "23505", from the error or from the driver error it wraps (Drizzle keeps that as `cause`). */
function databaseCodeOf(error: unknown): string | null {
  for (const candidate of [read(error, "code"), read(read(error, "cause"), "code")]) {
    if (typeof candidate === "string" && DATABASE_CODE.test(candidate)) return candidate;
  }
  return null;
}

export class AssistantFailure extends Error {
  readonly code: AssistantFailureCode;
  /** The failing error's class name (for example "DrizzleQueryError"), when it was a plain identifier. Never its message. */
  readonly errorName: string | null;
  /** The database's own error code (for example "57P01"), when the failing error carried one. Never a statement or a parameter. */
  readonly databaseCode: string | null;

  /**
   * @param cause the failing error, read ONCE for its class name and database code and then dropped: it is not kept, so it can
   *              not be logged or inspected later.
   * @param tool  the tool that failed, when it was a tool.
   */
  constructor(code: AssistantFailureCode, cause: unknown, tool?: string) {
    const errorName = classNameOf(cause);
    const databaseCode = databaseCodeOf(cause);
    const subject = tool !== undefined && TOOL_NAME.test(tool) ? `The ${tool} tool` : "The assistant";
    const detail = errorName === null && databaseCode === null ? "" : ` (${[errorName, databaseCode === null ? null : `database error ${databaseCode}`].filter((part) => part !== null).join(", ")})`;
    super(`${subject} failed unexpectedly${detail}.`);
    this.name = "AssistantFailure";
    this.code = code;
    this.errorName = errorName;
    this.databaseCode = databaseCode;
  }
}
