// User-scoped data access for persisted tax computation results.
//
// Phase 1B scope: storage/retrieval only. No tax calculation happens
// here or anywhere in this codebase yet — createTaxComputation persists
// whatever result the (not-yet-built) tax engine will eventually pass
// in. See docs/SMARTCA-REPOSITORY-AUDIT.md for why the engine itself is
// out of scope for this phase.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { assessmentYears, taxComputations } from "@/db/schema";
import type { ComparisonInput, TaxResult } from "@/tax-engine";
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

// ---------------------------------------------------------------------
// Phase 3: saving and reading computation runs.
// ---------------------------------------------------------------------
// A "run" is one explicit user save: one row per regime that produced a
// result, all sharing a `runId` inside `computationData`.
//
// TRUST BOUNDARY: `saveTaxComputationRun` takes `TaxResult` objects that the
// tax engine just produced in this process. It must never be fed values
// that came from a request body — the API layer computes on the server and
// passes only the engine's own output. (The generic `createTaxComputation`
// above accepts arbitrary numbers and is deliberately not used by any API
// route.)
//
// What is stored is exactly what the engine returned, plus the
// server-validated input, so a stored computation can be displayed later as
// it was computed. It is never recomputed for display.
type DbExecutor = Pick<typeof db, "select" | "insert">;

export type TaxComputationRunInput = {
  assessmentYearId: string;
  runId: string;
  input: ComparisonInput;
  results: TaxResult[];
};

export async function listTaxComputationsForYear(userId: string, assessmentYearId: string, executor: DbExecutor = db) {
  return executor
    .select()
    .from(taxComputations)
    .where(and(eq(taxComputations.userId, userId), eq(taxComputations.assessmentYearId, assessmentYearId)))
    .orderBy(desc(taxComputations.createdAt), desc(taxComputations.id));
}

export async function saveTaxComputationRun(userId: string, run: TaxComputationRunInput, executor: DbExecutor = db) {
  if (!run.runId) throw new ValidationError("runId is required.");
  if (run.results.length === 0) throw new ValidationError("There is no computed result to save.");

  const [year] = await executor
    .select({ label: assessmentYears.label })
    .from(assessmentYears)
    .where(eq(assessmentYears.id, run.assessmentYearId));
  if (!year) throw new ValidationError("Unknown assessment year.");

  // Validate the whole set before writing anything.
  const regimes = new Set<string>();
  for (const result of run.results) {
    if (result.assessmentYearLabel !== year.label) {
      throw new ValidationError("A computed result does not belong to this assessment year.");
    }
    if (regimes.has(result.regime)) {
      throw new ValidationError("A run can hold at most one result per regime.");
    }
    regimes.add(result.regime);
    if (!Number.isInteger(result.totalTaxPaise) || result.totalTaxPaise < 0) {
      throw new ValidationError("A computed result has an invalid total.");
    }
    if (!result.engineVersion || !result.rulesVersion) {
      throw new ValidationError("A computed result is missing its engine or rules version.");
    }
  }

  // One multi-row INSERT: all regimes are saved together or not at all.
  return executor
    .insert(taxComputations)
    .values(
      run.results.map((result) => ({
        userId,
        assessmentYearId: run.assessmentYearId,
        regime: result.regime,
        engineVersion: result.engineVersion,
        rulesVersion: result.rulesVersion,
        resultTaxPaise: result.totalTaxPaise,
        computationData: { schemaVersion: 1, runId: run.runId, input: run.input, result },
      })),
    )
    .returning();
}
