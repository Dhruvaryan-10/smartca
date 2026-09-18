// User-scoped data access for transactions. Every function requires an
// explicit `userId` (see services/session.ts for the only legitimate
// way callers should obtain one) and every query is filtered by it —
// list/get/update/delete can never touch another user's rows, because
// the WHERE clause makes it structurally impossible, not just checked
// after the fact.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { transactions } from "@/db/schema";
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
  if (!input.occurredOn || Number.isNaN(Date.parse(input.occurredOn))) {
    throw new ValidationError("occurredOn must be a valid date.");
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
