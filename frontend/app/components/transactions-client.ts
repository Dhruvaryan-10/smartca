// Loads the signed-in person's transactions (GET /api/transactions, services/transactions.ts) for the pages that read them:
// Summary, Ledger, Reports and Insights. Every failure (session expired, 401/403, server error, network, a body that is not
// the expected array) is thrown as an ApiFailure so each page reaches its error state; only a genuine `[]` is an empty account.
import { ApiFailure, requestJson } from "./request";

export async function fetchTransactions<T>(signal?: AbortSignal): Promise<T[]> {
  const data = await requestJson<unknown>("/api/transactions", { signal });
  if (!Array.isArray(data)) throw new ApiFailure("Your transactions didn’t load. Please try again.", "malformed_response");
  return data as T[];
}
