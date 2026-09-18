// Tests B (User A CRUD on own transaction), C (User B cannot read User
// A's), D (User B cannot update User A's), E (User B cannot delete User
// A's) — plus list isolation.
import "../db/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError } from "../services/errors";
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from "../services/transactions";
import { deleteTestUser, makeTestUser } from "./helpers";

test("B-E. transaction ownership is enforced end to end", async () => {
  const userA = await makeTestUser("txn-a");
  const userB = await makeTestUser("txn-b");

  try {
    // --- B. User A can create/read/update/delete their own transaction ---
    const created = await createTransaction(userA.id, {
      type: "income",
      amountPaise: 500000,
      category: "Salary",
      occurredOn: "2025-06-01",
    });
    assert.equal(created.userId, userA.id);

    const fetched = await getTransaction(userA.id, created.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, created.id);

    const updated = await updateTransaction(userA.id, created.id, { amountPaise: 600000 });
    assert.equal(updated.amountPaise, 600000);

    // --- List isolation: User B's list must never contain User A's data ---
    const bListBeforeDelete = await listTransactions(userB.id);
    assert.ok(!bListBeforeDelete.some((t) => t.id === created.id));

    const aList = await listTransactions(userA.id);
    assert.ok(aList.some((t) => t.id === created.id));

    // --- C. User B cannot read User A's transaction ---
    const bReadsA = await getTransaction(userB.id, created.id);
    assert.equal(bReadsA, null, "User B must not be able to read User A's transaction");

    // --- D. User B cannot update User A's transaction ---
    await assert.rejects(
      () => updateTransaction(userB.id, created.id, { amountPaise: 1 }),
      NotFoundError,
      "User B must not be able to update User A's transaction",
    );
    // Confirm it truly wasn't changed.
    const stillA = await getTransaction(userA.id, created.id);
    assert.equal(stillA!.amountPaise, 600000);

    // --- E. User B cannot delete User A's transaction ---
    await assert.rejects(
      () => deleteTransaction(userB.id, created.id),
      NotFoundError,
      "User B must not be able to delete User A's transaction",
    );
    // Confirm it still exists for User A.
    assert.ok(await getTransaction(userA.id, created.id));

    // Finally, User A can delete their own.
    await deleteTransaction(userA.id, created.id);
    assert.equal(await getTransaction(userA.id, created.id), null);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});
