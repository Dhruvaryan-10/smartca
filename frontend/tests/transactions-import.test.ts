// Transaction service tests for Phase 4: strict dates on manual entry (the
// Date.parse bug), and the batch insert used by CSV import. DB-backed; every
// test user is deleted afterwards (ON DELETE CASCADE removes their rows).
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { transactions } from "../db/schema";
import { NotFoundError, ValidationError } from "../services/errors";
import { createTransaction, insertImportedTransactions, listTransactions, updateTransaction } from "../services/transactions";
import { deleteTestUser, makeTestUser } from "./helpers";

const base = { type: "expense", amountPaise: 12_345, category: "Food" };

async function withUser<T>(label: string, fn: (userId: string) => Promise<T>): Promise<T> {
  const user = await makeTestUser(label);
  try {
    return await fn(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}

// --- regression: manual creation still works --------------------------------

test("manual transaction creation still works with ISO dates, exactly as the Income and Expenses pages send them", async () => {
  await withUser("manual-ok", async (userId) => {
    const today = new Date().toISOString().slice(0, 10);
    const created = await createTransaction(userId, { ...base, occurredOn: today, description: "lunch", source: "manual" });
    assert.equal(created.occurredOn, today);
    assert.equal(created.amountPaise, 12_345);
    assert.equal(created.importFingerprint, null, "manual rows carry no import fingerprint");
    assert.equal(created.importBatchId, null);
    assert.equal((await listTransactions(userId)).length, 1);
  });
});

test("dates that are not exact, real ISO calendar dates are refused before they can reach the database", async () => {
  await withUser("manual-dates", async (userId) => {
    for (const bad of ["2026-02-30", "garbage 1", "05/03/2026", "2026-03-05T10:00:00Z", "2026", "", "2026-13-01", "3 March 2026"]) {
      await assert.rejects(
        () => createTransaction(userId, { ...base, occurredOn: bad }),
        ValidationError,
        `should refuse ${JSON.stringify(bad)}`,
      );
    }
    assert.equal((await listTransactions(userId)).length, 0, "nothing was written");
  });
});

test("updates are held to the same strict date rule (they were not validated at all before)", async () => {
  await withUser("update-dates", async (userId) => {
    const row = await createTransaction(userId, { ...base, occurredOn: "2026-03-05" });
    await assert.rejects(() => updateTransaction(userId, row.id, { occurredOn: "2026-02-30" }), ValidationError);
    await assert.rejects(() => updateTransaction(userId, row.id, { occurredOn: "garbage 1" }), ValidationError);
    const updated = await updateTransaction(userId, row.id, { occurredOn: "2026-03-06" });
    assert.equal(updated.occurredOn, "2026-03-06");
    // Untouched fields stay untouched, and an update without a date still works.
    const again = await updateTransaction(userId, row.id, { category: "Dining" });
    assert.equal(again.occurredOn, "2026-03-06");
    assert.equal(again.category, "Dining");
  });
});

// --- batch insert for CSV import --------------------------------------------

function importedRow(n: number, overrides: Partial<Parameters<typeof insertImportedTransactions>[2][number]> = {}) {
  return {
    type: "expense" as const,
    amountPaise: 1_000 + n,
    category: "Uncategorized",
    description: `row ${n}`,
    occurredOn: "2026-03-05",
    importFingerprint: `fp-${n}`,
    ...overrides,
  };
}

async function newBatch(userId: string) {
  const { importBatches } = await import("../db/schema");
  const [batch] = await db
    .insert(importBatches)
    .values({ userId, filename: "test.csv", rowCount: 0, insertedCount: 0, skippedDuplicateCount: 0 })
    .returning();
  return batch;
}

test("insertImportedTransactions stores every row for the user, tagged with its batch and source", async () => {
  await withUser("batch-basic", async (userId) => {
    const batch = await newBatch(userId);
    const inserted = await insertImportedTransactions(userId, batch.id, [importedRow(1), importedRow(2), importedRow(3)]);
    assert.deepEqual([...inserted].sort(), ["fp-1", "fp-2", "fp-3"]);

    const rows = await listTransactions(userId);
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.equal(row.userId, userId);
      assert.equal(row.source, "csv_import");
      assert.equal(row.importBatchId, batch.id);
      assert.ok(row.importFingerprint);
    }
    assert.deepEqual(rows.map((r) => r.amountPaise).sort((a, b) => a - b), [1_001, 1_002, 1_003]);
  });
});

test("a repeated fingerprint for the same user is skipped, not inserted twice and not an error", async () => {
  await withUser("batch-dupes", async (userId) => {
    const batch = await newBatch(userId);
    const first = await insertImportedTransactions(userId, batch.id, [importedRow(1), importedRow(2)]);
    assert.equal(first.size, 2);

    const second = await insertImportedTransactions(userId, batch.id, [importedRow(1), importedRow(2), importedRow(3)]);
    assert.deepEqual([...second], ["fp-3"], "only the genuinely new row was inserted");
    assert.equal((await listTransactions(userId)).length, 3);
  });
});

test("the same fingerprint for two different users is fine, and neither can see the other's rows", async () => {
  const userA = await makeTestUser("fp-a");
  const userB = await makeTestUser("fp-b");
  try {
    const batchA = await newBatch(userA.id);
    const batchB = await newBatch(userB.id);
    assert.equal((await insertImportedTransactions(userA.id, batchA.id, [importedRow(1)])).size, 1);
    assert.equal((await insertImportedTransactions(userB.id, batchB.id, [importedRow(1)])).size, 1);
    assert.equal((await listTransactions(userA.id)).length, 1);
    assert.equal((await listTransactions(userB.id)).length, 1);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("imported rows are validated like manual ones: a bad row refuses the whole call", async () => {
  await withUser("batch-validate", async (userId) => {
    const batch = await newBatch(userId);
    for (const bad of [
      importedRow(1, { occurredOn: "2026-02-30" }),
      importedRow(1, { amountPaise: 0 }),
      importedRow(1, { amountPaise: 1.5 }),
      importedRow(1, { category: "  " }),
      importedRow(1, { importFingerprint: "" }),
    ]) {
      await assert.rejects(() => insertImportedTransactions(userId, batch.id, [importedRow(9), bad]), ValidationError);
    }
    assert.equal((await listTransactions(userId)).length, 0);
  });
});

test("an empty batch inserts nothing", async () => {
  await withUser("batch-empty", async (userId) => {
    const batch = await newBatch(userId);
    assert.equal((await insertImportedTransactions(userId, batch.id, [])).size, 0);
  });
});

test("inserts are chunked, so a file at the row limit fits within Postgres's parameter limit", async () => {
  await withUser("batch-large", async (userId) => {
    const batch = await newBatch(userId);
    const rows = Array.from({ length: 2_500 }, (_, i) => importedRow(i));
    const inserted = await insertImportedTransactions(userId, batch.id, rows);
    assert.equal(inserted.size, 2_500);
    const stored = await db.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.userId, userId), eq(transactions.importBatchId, batch.id)));
    assert.equal(stored.length, 2_500);
  });
});

test("a user cannot read or change another user's imported rows through the service functions", async () => {
  const userA = await makeTestUser("iso-a");
  const userB = await makeTestUser("iso-b");
  try {
    const batchA = await newBatch(userA.id);
    await insertImportedTransactions(userA.id, batchA.id, [importedRow(1)]);
    const [rowA] = await listTransactions(userA.id);
    assert.equal((await listTransactions(userB.id)).length, 0);
    await assert.rejects(() => updateTransaction(userB.id, rowA.id, { category: "hijack" }), NotFoundError);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});
