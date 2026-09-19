// User-scoped data access for transactions. Every function requires an
// explicit `userId` (see services/session.ts for the only legitimate
// way callers should obtain one) and every query is filtered by it —
// list/get/update/delete can never touch another user's rows, because
// the WHERE clause makes it structurally impossible, not just checked
// after the fact.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { transactions } from "@/db/schema";
import { parseIsoDate } from "@/lib/date-parse";
import { MAX_MONEY_PAISE } from "@/lib/money-input";
import { NotFoundError, ValidationError } from "./errors";

const TRANSACTION_TYPES = new Set(["income", "expense"]);

export type NewTransactionInput = {
  type: string;
  amountPaise: number;
  category: string;
  description?: string | null;
  source?: string | null;
  occurredOn: string; // YYYY-MM-DD
};

export type TransactionUpdateInput = Partial<NewTransactionInput>;

function assertValidCreateInput(input: NewTransactionInput) {
  if (!TRANSACTION_TYPES.has(input.type)) {
    throw new ValidationError('type must be "income" or "expense".');
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new ValidationError("amountPaise must be a positive integer.");
  }
  if (!input.category || !input.category.trim()) {
    throw new ValidationError("category is required.");
  }
  assertValidOccurredOn(input.occurredOn);
}

// A real calendar date written exactly as YYYY-MM-DD. This used to be
// `Date.parse`, which accepted "garbage 1", rolled "2026-02-30" over to
// 2 March, and read "05/03/2026" differently from Postgres, so what was
// checked was not what was stored.
function assertValidOccurredOn(occurredOn: unknown): void {
  if (typeof occurredOn !== "string" || parseIsoDate(occurredOn) === null) {
    throw new ValidationError("occurredOn must be a valid date in YYYY-MM-DD format.");
  }
}

export async function listTransactions(userId: string) {
  return db
    .select()
    .from(transactions)
    .where(eq(transactions.userId, userId))
    .orderBy(desc(transactions.occurredOn));
}

export async function createTransaction(userId: string, input: NewTransactionInput) {
  assertValidCreateInput(input);
  const [row] = await db
    .insert(transactions)
    .values({
      userId,
      type: input.type as "income" | "expense",
      amountPaise: input.amountPaise,
      category: input.category,
      description: input.description ?? null,
      source: input.source ?? null,
      occurredOn: input.occurredOn,
    })
    .returning();
  return row;
}

export async function getTransaction(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)));
  return row ?? null;
}

export async function updateTransaction(userId: string, id: string, input: TransactionUpdateInput) {
  if (input.type !== undefined && !TRANSACTION_TYPES.has(input.type)) {
    throw new ValidationError('type must be "income" or "expense".');
  }
  if (input.amountPaise !== undefined && (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0)) {
    throw new ValidationError("amountPaise must be a positive integer.");
  }
  if (input.occurredOn !== undefined) assertValidOccurredOn(input.occurredOn);

  const [row] = await db
    .update(transactions)
    .set({
      ...(input.type !== undefined ? { type: input.type as "income" | "expense" } : {}),
      ...(input.amountPaise !== undefined ? { amountPaise: input.amountPaise } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.occurredOn !== undefined ? { occurredOn: input.occurredOn } : {}),
      updatedAt: new Date(),
    })
    // The user-scoping predicate is what makes this authorization, not
    // just a database update — a row that exists but belongs to
    // someone else matches zero rows here, identically to a row that
    // doesn't exist at all.
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .returning();

  if (!row) throw new NotFoundError("Transaction not found.");
  return row;
}

export async function deleteTransaction(userId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(transactions)
    .where(and(eq(transactions.id, id), eq(transactions.userId, userId)))
    .returning({ id: transactions.id });

  if (!row) throw new NotFoundError("Transaction not found.");
}

// ---------------------------------------------------------------------
// Phase 4: batch insert for CSV import
// ---------------------------------------------------------------------

export type ImportedTransactionInput = {
  type: "income" | "expense";
  amountPaise: number;
  category: string;
  description: string | null;
  occurredOn: string; // YYYY-MM-DD
  /** Deterministic per-row hash (lib/csv-import.ts); unique per user. */
  importFingerprint: string;
};

// 7 bound values per row; Postgres allows 65,535 parameters per statement.
const INSERT_CHUNK_SIZE = 1000;

type InsertExecutor = Pick<typeof db, "insert">;

function assertValidImportedRow(row: ImportedTransactionInput): void {
  assertValidCreateInput({
    type: row.type,
    amountPaise: row.amountPaise,
    category: row.category,
    occurredOn: row.occurredOn,
  });
  if (row.amountPaise > MAX_MONEY_PAISE) throw new ValidationError("amountPaise is larger than supported.");
  if (typeof row.importFingerprint !== "string" || row.importFingerprint === "") {
    throw new ValidationError("importFingerprint is required.");
  }
}

/**
 * Insert already-validated CSV rows for `userId`, tagged with their batch
 * and `source = "csv_import"`. A row whose fingerprint the user already has
 * is skipped, not an error, so re-importing a file adds nothing. Returns the
 * fingerprints that were actually inserted.
 *
 * Every row is checked again here, before anything is written, so this
 * function never depends on its caller having validated. Run it inside a
 * transaction (pass `executor`) for an all-or-nothing import.
 */
export async function insertImportedTransactions(
  userId: string,
  batchId: string,
  rows: ImportedTransactionInput[],
  executor: InsertExecutor = db,
): Promise<Set<string>> {
  for (const row of rows) assertValidImportedRow(row);

  const inserted = new Set<string>();
  for (let start = 0; start < rows.length; start += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(start, start + INSERT_CHUNK_SIZE);
    const returned = await executor
      .insert(transactions)
      .values(
        chunk.map((row) => ({
          userId,
          type: row.type,
          amountPaise: row.amountPaise,
          category: row.category.trim(),
          description: row.description,
          source: "csv_import",
          occurredOn: row.occurredOn,
          importFingerprint: row.importFingerprint,
          importBatchId: batchId,
        })),
      )
      .onConflictDoNothing({ target: [transactions.userId, transactions.importFingerprint] })
      .returning({ fingerprint: transactions.importFingerprint });
    for (const { fingerprint } of returned) if (fingerprint) inserted.add(fingerprint);
  }
  return inserted;
}
