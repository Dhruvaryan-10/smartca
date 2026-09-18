// Test H: User B cannot access User A's tax computations. No tax
// calculation happens here — createTaxComputation just persists a
// pre-built result, matching Phase 1B's storage-only scope.
import "../db/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError } from "../services/errors";
import {
  createTaxComputation,
  deleteTaxComputation,
  getTaxComputation,
  listTaxComputations,
} from "../services/tax-computations";
import { deleteTestUser, getSeededAssessmentYearId, makeTestUser } from "./helpers";

test("H. tax computation ownership is enforced", async () => {
  const userA = await makeTestUser("tax-a");
  const userB = await makeTestUser("tax-b");
  const ayId = await getSeededAssessmentYearId();

  try {
    const created = await createTaxComputation(userA.id, {
      assessmentYearId: ayId,
      regime: "new",
      engineVersion: "test-fixture",
      rulesVersion: "test-fixture",
      resultTaxPaise: 0,
      computationData: { note: "Phase 1B isolation test fixture — not a real computation." },
    });
    assert.equal(created.userId, userA.id);

    assert.ok(await getTaxComputation(userA.id, created.id));

    // H. User B cannot read User A's tax computation.
    assert.equal(await getTaxComputation(userB.id, created.id), null);

    const bList = await listTaxComputations(userB.id);
    assert.ok(!bList.some((c) => c.id === created.id));

    // H. User B cannot delete User A's tax computation.
    await assert.rejects(() => deleteTaxComputation(userB.id, created.id), NotFoundError);
    assert.ok(await getTaxComputation(userA.id, created.id));

    await deleteTaxComputation(userA.id, created.id);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});
