// Test F: User B cannot access User A's deductions. Also exercises the
// Phase 1A duplicate-declaration unique constraint through the service
// layer (still enforced in Phase 1B).
import "../db/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError, ValidationError } from "../services/errors";
import { createDeduction, deleteDeduction, getDeduction, listDeductions } from "../services/deductions";
import { deleteTestUser, getSeededAssessmentYearId, makeTestUser } from "./helpers";

test("F. deduction ownership is enforced, and duplicate declarations are still rejected", async () => {
  const userA = await makeTestUser("ded-a");
  const userB = await makeTestUser("ded-b");
  const ayId = await getSeededAssessmentYearId();

  try {
    const created = await createDeduction(userA.id, {
      assessmentYearId: ayId,
      section: "80C",
      amountPaise: 15000000,
    });
    assert.equal(created.userId, userA.id);

    // User A can read their own.
    assert.ok(await getDeduction(userA.id, created.id));

    // F. User B cannot read User A's deduction.
    assert.equal(await getDeduction(userB.id, created.id), null);

    // User B's list does not contain User A's deduction.
    const bList = await listDeductions(userB.id);
    assert.ok(!bList.some((d) => d.id === created.id));

    // F. User B cannot delete User A's deduction.
    await assert.rejects(() => deleteDeduction(userB.id, created.id), NotFoundError);
    assert.ok(await getDeduction(userA.id, created.id));

    // The Phase 1A unique constraint (user, AY, section) still holds —
    // User A cannot double-declare the same section for the same year.
    await assert.rejects(
      () => createDeduction(userA.id, { assessmentYearId: ayId, section: "80C", amountPaise: 1 }),
      ValidationError,
    );

    // But User B declaring the SAME section for the SAME year is a
    // completely independent row — the constraint is per-user, not global.
    const bDeduction = await createDeduction(userB.id, {
      assessmentYearId: ayId,
      section: "80C",
      amountPaise: 2000000,
    });
    assert.equal(bDeduction.userId, userB.id);
    await deleteDeduction(userB.id, bDeduction.id);

    await deleteDeduction(userA.id, created.id);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});
