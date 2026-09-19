// User-scoped data access for declared deductions. Same ownership
// pattern as services/transactions.ts — every query is filtered by
// userId at the database level.
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { deductions } from "@/db/schema";
import { NotFoundError, ValidationError } from "./errors";
import { isUniqueViolation } from "@/db/pg-errors";

export type NewDeductionInput = {
  assessmentYearId: string;
  section: string;
  amountPaise: number;
  description?: string | null;
};

function assertValidInput(input: NewDeductionInput) {
  if (!input.section || !input.section.trim()) {
    throw new ValidationError("section is required.");
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new ValidationError("amountPaise must be a positive integer.");
  }
}

export async function listDeductions(userId: string) {
  return db.select().from(deductions).where(eq(deductions.userId, userId));
}

export async function createDeduction(userId: string, input: NewDeductionInput) {
  assertValidInput(input);
  try {
    const [row] = await db
      .insert(deductions)
      .values({
        userId,
        assessmentYearId: input.assessmentYearId,
        section: input.section,
        amountPaise: input.amountPaise,
        description: input.description ?? null,
      })
      .returning();
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ValidationError(
        `A deduction for section "${input.section}" already exists for this assessment year.`,
      );
    }
    throw err;
  }
}

export async function getDeduction(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(deductions)
    .where(and(eq(deductions.id, id), eq(deductions.userId, userId)));
  return row ?? null;
}

export async function deleteDeduction(userId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(deductions)
    .where(and(eq(deductions.id, id), eq(deductions.userId, userId)))
    .returning({ id: deductions.id });
  if (!row) throw new NotFoundError("Deduction not found.");
}

// ---------------------------------------------------------------------
// Phase 3: per-assessment-year access, used by the tax workspace.
// ---------------------------------------------------------------------
// `executor` lets a caller run these inside its own transaction (see
// services/tax.ts); by default they use the shared connection.
type DbExecutor = Pick<typeof db, "select" | "insert" | "delete">;

export async function listDeductionsForYear(userId: string, assessmentYearId: string, executor: DbExecutor = db) {
  return executor
    .select()
    .from(deductions)
    .where(and(eq(deductions.userId, userId), eq(deductions.assessmentYearId, assessmentYearId)))
    .orderBy(asc(deductions.section));
}

/**
 * Create the user's declaration for a section and year, or update it in
 * place. The table allows one row per (user, year, section), so this never
 * produces a duplicate.
 */
export async function upsertDeduction(userId: string, input: NewDeductionInput, executor: DbExecutor = db) {
  assertValidInput(input);
  const [row] = await executor
    .insert(deductions)
    .values({
      userId,
      assessmentYearId: input.assessmentYearId,
      section: input.section,
      amountPaise: input.amountPaise,
      description: input.description ?? null,
    })
    .onConflictDoUpdate({
      target: [deductions.userId, deductions.assessmentYearId, deductions.section],
      set: {
        amountPaise: input.amountPaise,
        description: input.description ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

/** Remove the user's declaration for a section and year, if there is one. */
export async function removeDeductionForSection(
  userId: string,
  assessmentYearId: string,
  section: string,
  executor: DbExecutor = db,
): Promise<void> {
  await executor
    .delete(deductions)
    .where(
      and(
        eq(deductions.userId, userId),
        eq(deductions.assessmentYearId, assessmentYearId),
        eq(deductions.section, section),
      ),
    );
}
