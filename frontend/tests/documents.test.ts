// Test G: User B cannot access User A's documents.
import "../db/load-env";

import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError } from "../services/errors";
import { createDocument, deleteDocument, getDocument, listDocuments } from "../services/documents";
import { deleteTestUser, makeTestUser } from "./helpers";

test("G. document ownership is enforced", async () => {
  const userA = await makeTestUser("doc-a");
  const userB = await makeTestUser("doc-b");

  try {
    const created = await createDocument(userA.id, {
      documentType: "form16",
      filename: "form16-fy2025-26.pdf",
      storageRef: "test://placeholder",
    });
    assert.equal(created.userId, userA.id);

    assert.ok(await getDocument(userA.id, created.id));

    // G. User B cannot read User A's document.
    assert.equal(await getDocument(userB.id, created.id), null);

    const bList = await listDocuments(userB.id);
    assert.ok(!bList.some((d) => d.id === created.id));

    // G. User B cannot delete User A's document.
    await assert.rejects(() => deleteDocument(userB.id, created.id), NotFoundError);
    assert.ok(await getDocument(userA.id, created.id));

    await deleteDocument(userA.id, created.id);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});
