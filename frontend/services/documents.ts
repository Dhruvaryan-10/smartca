// User-scoped document storage: metadata in `documents`, file bytes in the
// separate `document_files` table, review state in `document_extractions`.
//
// Storage decisions (Phase 4):
//   - Bytes live in Postgres (bytea) in their own table and are only ever
//     selected by getDocumentFile. `documents` has no content column, so no
//     listing can carry file data.
//   - `storageRef` is an opaque reference ("pg:document_files:<id>"), never a
//     filesystem path. Nothing here builds a path from a file name.
//   - The server computes size and SHA-256 from the bytes it received; callers
//     cannot assert them. A unique (user, sha256) index stops the same file
//     being stored twice.
//   - Deleting a document cascades to its bytes and its extraction.
//
// Every function takes an explicit `userId` (from services/session.ts) and
// filters by it in the query, so another user's document is indistinguishable
// from one that does not exist.
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { assessmentYears, documentExtractions, documentFiles, documents } from "@/db/schema";
import { isForeignKeyViolation, isUniqueViolation } from "@/db/pg-errors";
import { MAX_PDF_BYTES, sanitizeFilename, sha256Hex } from "@/lib/file-validation";
import { ConflictError, NotFoundError, PayloadTooLargeError, ValidationError } from "./errors";

export const SUPPORTED_DOCUMENT_TYPES = ["form16"] as const;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id can never match a row; treating it as "not found" avoids a database error. */
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_SHAPE.test(value);

function assertSupportedType(documentType: unknown): asserts documentType is string {
  if (typeof documentType !== "string" || !(SUPPORTED_DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    throw new ValidationError(`documentType must be one of: ${SUPPORTED_DOCUMENT_TYPES.join(", ")}.`);
  }
}

// ---------------------------------------------------------------------
// Metadata-only creation (kept for tests and scripts)
// ---------------------------------------------------------------------

export type NewDocumentInput = {
  assessmentYearId?: string | null;
  documentType: string;
  filename: string;
  storageRef: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

function assertValidInput(input: NewDocumentInput) {
  assertSupportedType(input.documentType);
  if (!input.filename || !input.filename.trim()) throw new ValidationError("filename is required.");
  if (!input.storageRef || !input.storageRef.trim()) throw new ValidationError("storageRef is required.");
  if (!input.contentType || !input.contentType.trim()) throw new ValidationError("contentType is required.");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) throw new ValidationError("sizeBytes must be a non-negative integer.");
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) throw new ValidationError("sha256 must be a 64-character hex digest.");
}

/** Internal listing of full rows. The API uses `listDocumentSummaries`, which omits storageRef. */
export async function listDocuments(userId: string) {
  return db.select().from(documents).where(eq(documents.userId, userId));
}

export async function createDocument(userId: string, input: NewDocumentInput) {
  assertValidInput(input);
  try {
    const [row] = await db
      .insert(documents)
      .values({
        userId,
        assessmentYearId: input.assessmentYearId ?? null,
        documentType: input.documentType,
        filename: sanitizeFilename(input.filename),
        storageRef: input.storageRef,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        sha256: input.sha256,
      })
      .returning();
    return row;
  } catch (err) {
    throw mapInsertError(err);
  }
}

function mapInsertError(err: unknown): unknown {
  if (isUniqueViolation(err)) return new ConflictError("This file has already been uploaded.");
  if (isForeignKeyViolation(err)) return new ValidationError("Unknown assessment year.");
  return err;
}

// ---------------------------------------------------------------------
// Upload: metadata + bytes, together or not at all
// ---------------------------------------------------------------------

export type NewDocumentFileInput = {
  documentType: string;
  filename: string;
  /** Decided by the server from the file's real bytes, never from the browser. */
  contentType: string;
  bytes: Uint8Array;
  assessmentYearId?: string | null;
  /** Defaults to "uploaded". The Form 16 flow stores the final status in the same transaction. */
  processingStatus?: "uploaded" | "extracted" | "failed";
};

type InsertExecutor = Pick<typeof db, "insert">;

/**
 * Store a document and its bytes in one transaction. Size and hash come from
 * the bytes themselves. Throws ConflictError if this user already stored the
 * same file.
 */
export async function createDocumentWithFile(userId: string, input: NewDocumentFileInput, executor?: InsertExecutor) {
  assertSupportedType(input.documentType);
  if (!input.contentType || !input.contentType.trim()) throw new ValidationError("contentType is required.");
  if (input.bytes.length === 0) throw new ValidationError("The file is empty.");
  if (input.bytes.length > MAX_PDF_BYTES) throw new PayloadTooLargeError("This file is larger than the limit.");

  const id = randomUUID();
  const write = async (tx: InsertExecutor) => {
    const [row] = await tx
      .insert(documents)
      .values({
        id,
        userId,
        assessmentYearId: input.assessmentYearId ?? null,
        documentType: input.documentType,
        filename: sanitizeFilename(input.filename),
        storageRef: `pg:document_files:${id}`,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
        sha256: sha256Hex(input.bytes),
        processingStatus: input.processingStatus ?? "uploaded",
      })
      .returning();
    await tx.insert(documentFiles).values({ documentId: id, content: Buffer.from(input.bytes) });
    return row;
  };

  try {
    return executor ? await write(executor) : await db.transaction(write);
  } catch (err) {
    throw mapInsertError(err);
  }
}

export async function findDocumentIdByHash(userId: string, sha256: string): Promise<string | null> {
  const [row] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), eq(documents.sha256, sha256)));
  return row?.id ?? null;
}

// ---------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------

export async function getDocument(userId: string, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)));
  return row ?? null;
}

/** The stored bytes, only for the owner. */
export async function getDocumentFile(
  userId: string,
  id: string,
): Promise<{ filename: string; contentType: string; bytes: Buffer } | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select({ filename: documents.filename, contentType: documents.contentType, bytes: documentFiles.content })
    .from(documents)
    .innerJoin(documentFiles, eq(documentFiles.documentId, documents.id))
    .where(and(eq(documents.id, id), eq(documents.userId, userId)));
  return row ?? null;
}

export type ReviewState = "processing" | "needs_review" | "confirmed" | "failed";

/** What the Vault shows. Deliberately has no storageRef and no file content. */
export type DocumentSummary = {
  id: string;
  filename: string;
  documentType: string;
  contentType: string;
  sizeBytes: number;
  /** ISO timestamp. */
  uploadedAt: string;
  processingStatus: "uploaded" | "processing" | "extracted" | "failed";
  /** Where the document is in extract -> review -> confirm; null until an extraction exists. */
  reviewState: ReviewState | null;
  /** e.g. "2026-27", once a confirmation has linked the document to a year. */
  assessmentYear: string | null;
  confirmedAt: string | null;
};

const summaryColumns = {
  id: documents.id,
  filename: documents.filename,
  documentType: documents.documentType,
  contentType: documents.contentType,
  sizeBytes: documents.sizeBytes,
  createdAt: documents.createdAt,
  processingStatus: documents.processingStatus,
  reviewState: documentExtractions.status,
  confirmedAt: documentExtractions.confirmedAt,
  assessmentYear: assessmentYears.label,
};

function toSummary(row: {
  id: string;
  filename: string;
  documentType: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  processingStatus: DocumentSummary["processingStatus"];
  reviewState: ReviewState | null;
  confirmedAt: Date | null;
  assessmentYear: string | null;
}): DocumentSummary {
  return {
    id: row.id,
    filename: row.filename,
    documentType: row.documentType,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.createdAt.toISOString(),
    processingStatus: row.processingStatus,
    reviewState: row.reviewState,
    assessmentYear: row.assessmentYear,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
  };
}

function summaryQuery(userId: string) {
  return db
    .select(summaryColumns)
    .from(documents)
    .leftJoin(
      documentExtractions,
      and(eq(documentExtractions.documentId, documents.id), eq(documentExtractions.userId, userId)),
    )
    .leftJoin(assessmentYears, eq(assessmentYears.id, documents.assessmentYearId));
}

export async function listDocumentSummaries(userId: string): Promise<DocumentSummary[]> {
  const rows = await summaryQuery(userId).where(eq(documents.userId, userId)).orderBy(desc(documents.createdAt));
  return rows.map(toSummary);
}

export async function getDocumentSummary(userId: string, id: string): Promise<DocumentSummary | null> {
  if (!isUuid(id)) return null;
  const [row] = await summaryQuery(userId).where(and(eq(documents.id, id), eq(documents.userId, userId)));
  return row ? toSummary(row) : null;
}

// ---------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------

/** Deletes the row; the database cascade removes the bytes and the extraction with it. */
export async function deleteDocument(userId: string, id: string): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError("Document not found.");
  const [row] = await db
    .delete(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)))
    .returning({ id: documents.id });
  if (!row) throw new NotFoundError("Document not found.");
}
