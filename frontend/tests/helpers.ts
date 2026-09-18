// Shared setup/teardown for Phase 1B tests. Every test user created
// here uses a throwaway *.test.smartca.invalid address and is deleted
// again in a `finally` block by the test that created it — ON DELETE
// CASCADE on every user-owned table means deleting the user also
// removes any transactions/deductions/documents/tax_computations it
// created, so tests never leave data behind in the real dev database.
import "../db/load-env";

import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { assessmentYears, users } from "../db/schema";
import { createUser } from "../services/users";

let counter = 0;

export async function makeTestUser(label: string) {
  counter += 1;
  const email = `phase1b-${Date.now()}-${counter}-${label}@test.smartca.invalid`;
  return createUser({ email, password: "TestPassword123!", name: `Test ${label}` });
}

export async function deleteTestUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

export async function getSeededAssessmentYearId(): Promise<string> {
  const [ay] = await db.select().from(assessmentYears).where(eq(assessmentYears.label, "2026-27"));
  if (!ay) {
    throw new Error("AY 2026-27 is not seeded — run `npm run db:seed` before running tests.");
  }
  return ay.id;
}
