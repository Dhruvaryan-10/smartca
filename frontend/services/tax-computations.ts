// User-scoped data access for persisted tax computation results.
//
// Phase 1B scope: storage/retrieval only. No tax calculation happens
// here or anywhere in this codebase yet — createTaxComputation persists
// whatever result the (not-yet-built) tax engine will eventually pass
// in. See docs/SMARTCA-REPOSITORY-AUDIT.md for why the engine itself is
// out of scope for this phase.
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { taxComputations } from "@/db/schema";
import { NotFoundError, ValidationError } from "./errors";

export type NewTaxComputationInput = {
  assessmentYearId: string;
  regime: "old" | "new";
  engineVersion: string;
  rulesVersion: string;
  resultTaxPaise: number;
  computationData: unknown;
};

function assertValidInput(input: NewTaxComputationInput) {
  if (!Number.isInteger(input.resultTaxPaise) || input.resultTaxPaise < 0) {
    throw new ValidationError("resultTaxPaise must be a non-negative integer.");
  }
  if (!input.engineVersion || !input.rulesVersion) {
    throw new ValidationError("engineVersion and rulesVersion are required.");
  }
}

export async function listTaxComputations(userId: string) {
  return db.select().from(taxComputations).where(eq(taxComputations.userId, userId));
}

export async function createTaxComputation(userId: string, input: NewTaxComputationInput) {
  assertValidInput(input);
  const [row] = await db
    .insert(taxComputations)
    .values({
      userId,
      assessmentYearId: input.assessmentYearId,
      regime: input.regime,
      engineVersion: input.engineVersion,
      rulesVersion: input.rulesVersion,
      resultTaxPaise: input.resultTaxPaise,
      computationData: input.computationData,
    })
    .returning();
  return row;
}

export async function getTaxComputation(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(taxComputations)
    .where(and(eq(taxComputations.id, id), eq(taxComputations.userId, userId)));
  return row ?? null;
}

export async function deleteTaxComputation(userId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(taxComputations)
    .where(and(eq(taxComputations.id, id), eq(taxComputations.userId, userId)))
    .returning({ id: taxComputations.id });
  if (!row) throw new NotFoundError("Tax computation not found.");
}
