// Test K: the Phase 1A database constraints still hold after the
// Phase 1B schema change (users.email NOT NULL + users.password_hash).
// Runs inside a transaction that is always rolled back, so this test
// never leaves data behind — same approach as scripts/verify-db.ts,
// which remains the manual/CLI version of this same check.
import "../db/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, TransactionRollbackError } from "drizzle-orm";
import * as schema from "../db/schema";
import { isForeignKeyViolation, isUniqueViolation } from "../db/pg-errors";

const { users, assessmentYears, transactions, deductions } = schema;

test("K. Phase 1A constraints (FK, unique, integer paise, AY 2026-27) still hold", async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });

  try {
    await db.transaction(async (tx) => {
      const [ay] = await tx.select().from(assessmentYears).where(eq(assessmentYears.label, "2026-27"));
      assert.ok(ay, "AY 2026-27 must be seeded");
      assert.equal(ay.startDate, "2025-04-01");
      assert.equal(ay.endDate, "2026-03-31");

      const [user] = await tx
        .insert(users)
        .values({ email: "schema-integrity@test.smartca.invalid", passwordHash: "not-a-real-hash", name: "K" })
        .returning();
      assert.ok(user.id);

      const amountPaiseIn = 727272;
      const [txn] = await tx
        .insert(transactions)
        .values({
          userId: user.id,
          type: "expense",
          amountPaise: amountPaiseIn,
          category: "Test",
          occurredOn: "2025-06-01",
        })
        .returning();
      assert.equal(txn.amountPaise, amountPaiseIn);
      assert.ok(Number.isInteger(txn.amountPaise));

      // FK: inserting a transaction for a non-existent user must fail.
      await assert.rejects(async () => {
        await tx.transaction(async (tx2) => {
          await tx2.insert(transactions).values({
            userId: "00000000-0000-0000-0000-000000000000",
            type: "expense",
            amountPaise: 1,
            category: "Should fail",
            occurredOn: "2025-06-01",
          });
        });
      }, (err: unknown) => isForeignKeyViolation(err));

      // Unique: a duplicate (user, AY, section) deduction must fail.
      await tx.insert(deductions).values({
        userId: user.id,
        assessmentYearId: ay.id,
        section: "80C",
        amountPaise: 1000000,
      });
      await assert.rejects(async () => {
        await tx.transaction(async (tx2) => {
          await tx2.insert(deductions).values({
            userId: user.id,
            assessmentYearId: ay.id,
            section: "80C",
            amountPaise: 2000000,
          });
        });
      }, (err: unknown) => isUniqueViolation(err));

      await tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  } finally {
    await pool.end();
  }
});
