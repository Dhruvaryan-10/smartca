// A Drizzle-style query error for the error-boundary tests. PURE: no database, no imports beyond the fixtures' own constant.
//
// drizzle-orm 0.45 builds its DrizzleQueryError message as `Failed query: ${query}\nparams: ${params}`, so the statement AND
// every bound parameter (for a ledger query, the userId) sit in the message, in `query` and in `params`. The cause is the driver's
// own error, which carries the database error code. This reproduces that shape without importing drizzle.
import { USER } from "./helpers-orchestrator";

export class DrizzleQueryError extends Error {
  constructor(readonly query: string, readonly params: unknown[], readonly cause: unknown) {
    super(`Failed query: ${query}\nparams: ${params}`);
    this.name = "DrizzleQueryError";
  }
}

export const leakyDatabaseError = () =>
  new DrizzleQueryError(
    'select "id", "amount_paise" from "transactions" where "transactions"."user_id" = $1',
    [USER],
    Object.assign(new Error(`connection to ${USER} lost`), { code: "57P01" }),
  );

/** Everything a logger, a response or a debugger could reach on an error. */
export const everythingOn = (error: unknown): string => [
  String((error as Error).message), (error as Error).stack ?? "", JSON.stringify(error), JSON.stringify(Object.getOwnPropertyNames(error)),
].join("\n");
