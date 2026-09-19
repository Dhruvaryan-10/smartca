// Document storage service tests. DB-backed; every test user is deleted
// afterwards and ON DELETE CASCADE removes everything they own.
//
// What must hold: file bytes live only in document_files and never in a list;
// the server, not the caller, decides size and hash; the same user cannot
// store the same file twice; every read, download and delete is scoped to the
// owner; and deleting a document leaves no orphaned bytes or extraction.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { documentExtractions, documentFiles, documents } from "../db/schema";
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from "../services/errors";
import {
  createDocumentWithFile,
  deleteDocument,
  findDocumentIdByHash,
  getDocument,
  getDocumentFile,
  getDocumentSummary,
  listDocumentSummaries,
} from "../services/documents";
import { MAX_PDF_BYTES, sha256Hex } from "../lib/file-validation";
import { deleteTestUser, getSeededAssessmentYearId, makeTestUser } from "./helpers";

const bytesOf = (text: string) => new TextEncoder().encode(text);
const pdfBytes = (marker = "a") => bytesOf(`%PDF-1.4\n% synthetic ${marker}\n%%EOF\n`);

async function withUser<T>(label: string, fn: (userId: string) => Promise<T>): Promise<T> {
  const user = await makeTestUser(label);
  try {
    return await fn(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}

const input = (bytes: Uint8Array, overrides: Record<string, unknown> = {}) => ({
  documentType: "form16",
  filename: "Form 16.pdf",
  contentType: "application/pdf",
  bytes,
  ...overrides,
});

test("createDocumentWithFile stores metadata and bytes, and the SERVER decides size and hash", async () => {
  await withUser("store", async (userId) => {
    const bytes = pdfBytes("store");
    const doc = await createDocumentWithFile(userId, {
      ...input(bytes),
      // Anything a caller might try to assert about the file is ignored:
      sizeBytes: 1,
      sha256: "0".repeat(64),
    } as never);

    assert.equal(doc.userId, userId);
    assert.equal(doc.documentType, "form16");
    assert.equal(doc.contentType, "application/pdf");
    assert.equal(doc.sizeBytes, bytes.length);
    assert.equal(doc.sha256, sha256Hex(bytes));
    assert.equal(doc.processingStatus, "uploaded");

    // The bytes are in document_files, exactly as uploaded.
    const [file] = await db.select().from(documentFiles).where(eq(documentFiles.documentId, doc.id));
    assert.ok(file);
    assert.deepEqual(new Uint8Array(file.content), bytes);
  });
});

test("storageRef is an opaque reference, never a filesystem path", async () => {
  await withUser("ref", async (userId) => {
    const doc = await createDocumentWithFile(userId, input(pdfBytes("ref"), { filename: "../../etc/passwd.pdf" }));
    assert.match(doc.storageRef, /^pg:document_files:[0-9a-f-]{36}$/);
    assert.equal(/[\\/.]/.test(doc.storageRef.replace(/^pg:/, "")), false);
    assert.equal(doc.filename, "passwd.pdf", "the display name is sanitized on the way in");
  });
});

test("the documents table itself holds no file content, so no listing can carry it", async () => {
  await withUser("no-bytes", async (userId) => {
    const doc = await createDocumentWithFile(userId, input(pdfBytes("nb")));
    assert.equal("content" in doc, false);
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    assert.equal(Object.keys(row).some((k) => /content$/i.test(k) && k !== "contentType"), false);
  });
});

test("document summaries expose what the Vault needs and never storageRef or bytes", async () => {
  await withUser("summary", async (userId) => {
    const doc = await createDocumentWithFile(userId, input(pdfBytes("sum")));
    const [summary] = await listDocumentSummaries(userId);

    assert.deepEqual(Object.keys(summary).sort(), [
      "assessmentYear",
      "confirmedAt",
      "contentType",
      "documentType",
      "filename",
      "id",
      "processingStatus",
      "reviewState",
      "sizeBytes",
      "uploadedAt",
    ]);
    assert.equal(summary.id, doc.id);
    assert.equal(summary.reviewState, null, "no extraction yet");
    assert.equal(summary.assessmentYear, null);
    assert.equal(JSON.stringify(summary).includes("pg:document_files"), false);
    assert.equal(typeof summary.uploadedAt, "string");
    assert.deepEqual(await getDocumentSummary(userId, doc.id), summary);
  });
});

test("summaries include the review state and assessment year once an extraction and year exist", async () => {
  await withUser("summary-state", async (userId) => {
    const ayId = await getSeededAssessmentYearId();
    const doc = await createDocumentWithFile(userId, input(pdfBytes("state")));
    await db.update(documents).set({ assessmentYearId: ayId }).where(eq(documents.id, doc.id));
    await db.insert(documentExtractions).values({
      documentId: doc.id,
      userId,
      extractorVersion: "test",
      status: "needs_review",
      extracted: { fields: [] },
    });
    const summary = await getDocumentSummary(userId, doc.id);
    assert.equal(summary?.reviewState, "needs_review");
    assert.equal(summary?.assessmentYear, "2026-27");
  });
});

test("summaries are newest first", async () => {
  await withUser("order", async (userId) => {
    const first = await createDocumentWithFile(userId, input(pdfBytes("1")));
    await new Promise((r) => setTimeout(r, 15));
    const second = await createDocumentWithFile(userId, input(pdfBytes("2")));
    assert.deepEqual((await listDocumentSummaries(userId)).map((d) => d.id), [second.id, first.id]);
  });
});

test("the same user cannot store the same file twice, even under another name", async () => {
  await withUser("dupe", async (userId) => {
    const bytes = pdfBytes("dupe");
    const first = await createDocumentWithFile(userId, input(bytes));
    await assert.rejects(() => createDocumentWithFile(userId, input(bytes, { filename: "renamed.pdf" })), ConflictError);
    assert.equal((await listDocumentSummaries(userId)).length, 1);
    assert.equal(await findDocumentIdByHash(userId, sha256Hex(bytes)), first.id);
    assert.equal(await findDocumentIdByHash(userId, sha256Hex(pdfBytes("other"))), null);
    // The failed duplicate left no orphaned bytes: this user has exactly one stored file.
    const stored = await db
      .select({ id: documentFiles.documentId })
      .from(documentFiles)
      .innerJoin(documents, eq(documentFiles.documentId, documents.id))
      .where(eq(documents.userId, userId));
    assert.deepEqual(stored.map((r) => r.id), [first.id]);
  });
});

test("two different users may each store the same file, and neither sees the other's", async () => {
  const userA = await makeTestUser("same-a");
  const userB = await makeTestUser("same-b");
  try {
    const bytes = pdfBytes("shared");
    const a = await createDocumentWithFile(userA.id, input(bytes));
    const b = await createDocumentWithFile(userB.id, input(bytes));
    assert.notEqual(a.id, b.id);
    assert.equal(await findDocumentIdByHash(userA.id, sha256Hex(bytes)), a.id);
    assert.equal(await findDocumentIdByHash(userB.id, sha256Hex(bytes)), b.id);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("only the owner can read, download or delete a document", async () => {
  const userA = await makeTestUser("own-a");
  const userB = await makeTestUser("own-b");
  try {
    const bytes = pdfBytes("mine");
    const doc = await createDocumentWithFile(userA.id, input(bytes));

    const file = await getDocumentFile(userA.id, doc.id);
    assert.ok(file);
    assert.deepEqual(new Uint8Array(file.bytes), bytes);
    assert.equal(file.filename, "Form 16.pdf");
    assert.equal(file.contentType, "application/pdf");

    assert.equal(await getDocumentFile(userB.id, doc.id), null);
    assert.equal(await getDocument(userB.id, doc.id), null);
    assert.equal(await getDocumentSummary(userB.id, doc.id), null);
    assert.equal((await listDocumentSummaries(userB.id)).length, 0);
    await assert.rejects(() => deleteDocument(userB.id, doc.id), NotFoundError);

    // The owner's document, file and bytes are all still there.
    assert.ok(await getDocumentFile(userA.id, doc.id));
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("an unknown or malformed id is simply not found", async () => {
  await withUser("unknown", async (userId) => {
    assert.equal(await getDocumentFile(userId, "00000000-0000-4000-8000-000000000000"), null);
    assert.equal(await getDocumentSummary(userId, "00000000-0000-4000-8000-000000000000"), null);
    await assert.rejects(() => deleteDocument(userId, "00000000-0000-4000-8000-000000000000"), NotFoundError);
  });
});

test("deleting a document removes its bytes and its extraction: nothing is orphaned", async () => {
  await withUser("cascade", async (userId) => {
    const doc = await createDocumentWithFile(userId, input(pdfBytes("cascade")));
    await db.insert(documentExtractions).values({
      documentId: doc.id,
      userId,
      extractorVersion: "test",
      status: "needs_review",
      extracted: { fields: [] },
    });
    assert.equal((await db.select().from(documentFiles).where(eq(documentFiles.documentId, doc.id))).length, 1);
    assert.equal((await db.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id))).length, 1);

    await deleteDocument(userId, doc.id);

    assert.equal((await db.select().from(documents).where(eq(documents.id, doc.id))).length, 0);
    assert.equal((await db.select().from(documentFiles).where(eq(documentFiles.documentId, doc.id))).length, 0);
    assert.equal((await db.select().from(documentExtractions).where(eq(documentExtractions.documentId, doc.id))).length, 0);
    assert.equal(await getDocumentFile(userId, doc.id), null);
  });
});

test("deleting a user removes all of their documents and file bytes", async () => {
  const user = await makeTestUser("user-cascade");
  try {
    const doc = await createDocumentWithFile(user.id, input(pdfBytes("uc")));
    await deleteTestUser(user.id);
    assert.equal((await db.select().from(documents).where(eq(documents.id, doc.id))).length, 0);
    assert.equal((await db.select().from(documentFiles).where(eq(documentFiles.documentId, doc.id))).length, 0);
  } finally {
    await deleteTestUser(user.id); // a no-op once deleted; keeps a failed run from leaking the user
  }
});

test("the service enforces its own limits and rules regardless of the caller", async () => {
  await withUser("limits", async (userId) => {
    await assert.rejects(() => createDocumentWithFile(userId, input(new Uint8Array(0))), ValidationError);
    await assert.rejects(() => createDocumentWithFile(userId, input(new Uint8Array(MAX_PDF_BYTES + 1))), PayloadTooLargeError);
    await assert.rejects(() => createDocumentWithFile(userId, input(pdfBytes("t"), { documentType: "payslip" })), ValidationError);
    await assert.rejects(() => createDocumentWithFile(userId, input(pdfBytes("t"), { documentType: "" })), ValidationError);
    await assert.rejects(() => createDocumentWithFile(userId, input(pdfBytes("t"), { contentType: "" })), ValidationError);
    assert.equal((await listDocumentSummaries(userId)).length, 0);
  });
});

test("an unknown assessment year is a validation error, not a database crash", async () => {
  await withUser("bad-ay", async (userId) => {
    await assert.rejects(
      () => createDocumentWithFile(userId, input(pdfBytes("ay"), { assessmentYearId: "00000000-0000-4000-8000-000000000000" })),
      ValidationError,
    );
    assert.equal((await listDocumentSummaries(userId)).length, 0);
  });
});
