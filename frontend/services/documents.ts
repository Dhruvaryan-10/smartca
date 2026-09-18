// User-scoped data access for document metadata rows (Form 16 etc.).
// Phase 1B scope: metadata/ownership only — no upload handling, no
// storage backend, no PDF/AI extraction. That's explicitly deferred;
// storageRef here is just an opaque string placeholder.
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { documents } from "@/db/schema";
import { NotFoundError, ValidationError } from "./errors";

export type NewDocumentInput = {
  assessmentYearId?: string | null;
  documentType: string;
  filename: string;
  storageRef: string;
};

function assertValidInput(input: NewDocumentInput) {
  if (!input.documentType || !input.documentType.trim()) {
    throw new ValidationError("documentType is required.");
  }
  if (!input.filename || !input.filename.trim()) {
    throw new ValidationError("filename is required.");
  }
  if (!input.storageRef || !input.storageRef.trim()) {
    throw new ValidationError("storageRef is required.");
  }
}

export async function listDocuments(userId: string) {
  return db.select().from(documents).where(eq(documents.userId, userId));
}

export async function createDocument(userId: string, input: NewDocumentInput) {
  assertValidInput(input);
  const [row] = await db
    .insert(documents)
    .values({
      userId,
      assessmentYearId: input.assessmentYearId ?? null,
      documentType: input.documentType,
      filename: input.filename,
      storageRef: input.storageRef,
    })
    .returning();
  return row;
}

export async function getDocument(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)));
  return row ?? null;
}

export async function deleteDocument(userId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(documents)
    .where(and(eq(documents.id, id), eq(documents.userId, userId)))
    .returning({ id: documents.id });
  if (!row) throw new NotFoundError("Document not found.");
}
