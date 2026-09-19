// Phase 1A database verification.
//
// This proves the schema actually behaves correctly against the real
// PostgreSQL database named by DATABASE_URL — not just that the
// TypeScript types compile. It inserts real rows, runs real queries,
// and deliberately triggers constraint violations to confirm the
// database itself rejects bad data.
//
// Everything runs inside one outer transaction that is rolled back at
// the end, so this script never leaves test data behind in the
// database. Run with: npm run db:verify

import "../db/load-env";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, TransactionRollbackError } from "drizzle-orm";
import * as schema from "../db/schema";
import { pgErrorCode } from "../db/pg-errors";

const {
  users,
  assessmentYears,
  transactions,
  deductions,
  taxComputations,
  documents,
} = schema;

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}: ${detail}`);
}

function isPgError(err: unknown, code: string): boolean {
  return pgErrorCode(err) === code;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (see frontend/.env.example).");
  }

  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  try {
    await db.transaction(async (tx) => {
      // --- Setup: AY 2026-27 must already exist (seeded) -------------
      const [ay2627] = await tx
        .select()
        .from(assessmentYears)
        .where(eq(assessmentYears.label, "2026-27"));

      record(
        "10. AY 2026-27 can be represented",
        !!ay2627 && ay2627.startDate === "2025-04-01" && ay2627.endDate === "2026-03-31",
        ay2627
          ? `found assessment_years row: label=${ay2627.label}, start=${ay2627.startDate}, end=${ay2627.endDate}`
          : "no 2026-27 row found — run `npm run db:seed` first",
      );
      if (!ay2627) throw new Error("AY 2026-27 missing; aborting remaining checks.");

      // --- 1. A user can exist ---------------------------------------
      const [userA] = await tx
        .insert(users)
        .values({
          name: "Verify User A",
          email: "verify-db-a@test.smartca.invalid",
          passwordHash: "not-a-real-hash",
          phone: "+910000000001",
        })
        .returning();
      record("1. A user can exist", !!userA?.id, `inserted users.id=${userA?.id}`);

      // --- 2. Two users can exist independently -----------------------
      const [userB] = await tx
        .insert(users)
        .values({
          name: "Verify User B",
          email: "verify-db-b@test.smartca.invalid",
          passwordHash: "not-a-real-hash",
          phone: "+910000000002",
        })
        .returning();
      record(
        "2. Two users can exist independently",
        !!userB?.id && userB.id !== userA.id,
        `users.id A=${userA.id} B=${userB.id} (distinct: ${userB.id !== userA.id})`,
      );

      // --- 3. A transaction can belong to one user --------------------
      const amountPaiseIn = 333333; // ₹3,333.33 — deliberately not a round rupee amount
      const [txn] = await tx
        .insert(transactions)
        .values({
          userId: userA.id,
          type: "income",
          amountPaise: amountPaiseIn,
          category: "Salary",
          description: "Verification transaction",
          source: "verify-db script",
          occurredOn: "2025-06-01",
        })
        .returning();
      record(
        "3. A transaction can belong to one user",
        txn?.userId === userA.id,
        `transactions.id=${txn?.id}, userId=${txn?.userId}`,
      );

      // --- 9. Money is stored as integer paise -------------------------
      const isIntegerPaise = Number.isInteger(txn.amountPaise) && txn.amountPaise === amountPaiseIn;
      record(
        "9. Money is stored as integer paise",
        isIntegerPaise,
        `inserted amountPaise=${amountPaiseIn}, read back amountPaise=${txn.amountPaise} (Number.isInteger: ${Number.isInteger(txn.amountPaise)})`,
      );

      // --- 4. A deduction belongs to one user --------------------------
      const [deduction] = await tx
        .insert(deductions)
        .values({
          userId: userA.id,
          assessmentYearId: ay2627.id,
          section: "80C",
          amountPaise: 15000000, // ₹1,50,000
        })
        .returning();
      record(
        "4. A deduction belongs to one user",
        deduction?.userId === userA.id,
        `deductions.id=${deduction?.id}, userId=${deduction?.userId}, section=${deduction?.section}`,
      );

      // --- 8. Duplicate deduction declarations are prevented -----------
      let duplicateRejected = false;
      let duplicateDetail = "";
      try {
        await tx.transaction(async (tx2) => {
          await tx2.insert(deductions).values({
            userId: userA.id,
            assessmentYearId: ay2627.id,
            section: "80C", // same user + AY + section as above
            amountPaise: 5000000,
          });
        });
      } catch (err) {
        duplicateRejected = isPgError(err, "23505");
        duplicateDetail = duplicateRejected
          ? "rejected with unique_violation (23505) as expected"
          : `rejected, but with unexpected Postgres error code: ${pgErrorCode(err) ?? "unknown"}`;
      }
      if (!duplicateRejected) duplicateDetail ||= "insert unexpectedly succeeded — duplicate was NOT prevented";
      record("8. Duplicate deduction declarations are prevented", duplicateRejected, duplicateDetail);

      // Prove the unique constraint is scoped correctly (not overly broad):
      // a different section for the same user/year must still succeed.
      const [secondDeduction] = await tx
        .insert(deductions)
        .values({
          userId: userA.id,
          assessmentYearId: ay2627.id,
          section: "80D",
          amountPaise: 2500000,
        })
        .returning();
      record(
        "8b. A different section for the same user/year is still allowed",
        !!secondDeduction?.id,
        `deductions.id=${secondDeduction?.id}, section=${secondDeduction?.section} — constraint is not over-broad`,
      );

      // --- 5. A computation belongs to one user -------------------------
      const [computation] = await tx
        .insert(taxComputations)
        .values({
          userId: userA.id,
          assessmentYearId: ay2627.id,
          regime: "new",
          engineVersion: "unbuilt-placeholder",
          rulesVersion: "unbuilt-placeholder",
          resultTaxPaise: 0,
          computationData: { note: "Phase 1A schema verification only; no tax engine exists yet." },
        })
        .returning();
      record(
        "5. A computation belongs to one user",
        computation?.userId === userA.id,
        `tax_computations.id=${computation?.id}, userId=${computation?.userId}`,
      );

      // --- 6. A document belongs to one user ----------------------------
      const [document] = await tx
        .insert(documents)
        .values({
          userId: userA.id,
          assessmentYearId: ay2627.id,
          documentType: "form16",
          filename: "verify-db-test.pdf",
          storageRef: "verify-db://placeholder",
          contentType: "application/pdf",
          sizeBytes: 0,
          sha256: "0".repeat(64),
        })
        .returning();
      record(
        "6. A document belongs to one user",
        document?.userId === userA.id,
        `documents.id=${document?.id}, userId=${document?.userId}, status=${document?.processingStatus}`,
      );

      // --- 7. Foreign-key relationships work (reject orphaned rows) ------
      const fakeUserId = "00000000-0000-0000-0000-000000000000";
      let fkRejected = false;
      let fkDetail = "";
      try {
        await tx.transaction(async (tx2) => {
          await tx2.insert(transactions).values({
            userId: fakeUserId, // does not exist in users
            type: "expense",
            amountPaise: 100,
            category: "Should Fail",
            occurredOn: "2025-06-01",
          });
        });
      } catch (err) {
        fkRejected = isPgError(err, "23503");
        fkDetail = fkRejected
          ? "rejected with foreign_key_violation (23503) as expected"
          : `rejected, but with unexpected Postgres error code: ${pgErrorCode(err) ?? "unknown"}`;
      }
      if (!fkRejected) fkDetail ||= "insert unexpectedly succeeded — FK constraint did NOT hold";
      record("7. Foreign-key relationships work", fkRejected, fkDetail);

      // Roll back so this script never leaves data behind.
      await tx.rollback();
    });
  } catch (err) {
    // tx.rollback() intentionally throws to abort the transaction —
    // that is the expected control-flow path, not a real failure.
    if (!(err instanceof TransactionRollbackError)) {
      throw err;
    }
  } finally {
    await pool.end();
  }

  const failed = results.filter((r) => !r.pass);
  console.log("\n--- Summary ---");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
  console.log("All Phase 1A database verification checks PASSED. No data was left in the database (transaction rolled back).");
}

main().catch((err) => {
  console.error("Verification script crashed:", err);
  process.exit(1);
});
