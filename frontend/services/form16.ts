// Form 16 flow: upload -> validate -> extract -> review -> confirm.
//
// THE TRUST BOUNDARY. What the parser read is an untrusted CANDIDATE and is
// stored as `extracted`. Nothing calculates from it. Only when the person
// reviews the values (editing any they like) and confirms them are they
// written to `confirmed`, and `confirmed` is the only thing any other part of
// the app may read (listConfirmedForm16, used by the Tax workspace as an
// explicit "use these" suggestion). The salary figure derived from them is
// computed here on the server from the confirmed numbers, never accepted from
// the client, and the deterministic tax engine is untouched.
//
// Supported input: digital (text) PDFs only. Scanned, password-protected,
// truncated, oversized, over-long or non-PDF uploads are refused up front and
// store nothing. Errors and logs never contain document content.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { pgErrorCode } from "@/db/pg-errors";
import { assessmentYears, documentExtractions, documents } from "@/db/schema";
import { assertDeclaredContentType, checkPdfBytes, sha256Hex } from "@/lib/file-validation";
import { deriveSalaryIncome, extractForm16Fields } from "@/lib/form16-extract";
import type { Form16Confirmed, Form16Extraction } from "@/lib/form16-extract";
import { MAX_MONEY_PAISE } from "@/lib/money-input";
import { readPdfText } from "@/lib/pdf-text";
import { getSupportedAssessmentYearLabels, UnsupportedAssessmentYearError } from "@/tax-engine";
import { createDocumentWithFile, findDocumentIdByHash, getDocumentSummary } from "./documents";
import type { DocumentSummary, ReviewState } from "./documents";
import {
  ConflictError,
  NotAuthenticatedError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "./errors";

const NOT_A_FORM16_MESSAGE =
  "SmartCA couldn’t recognise this as a Form 16, so there is nothing to review. You can download or delete it.";
const MAX_EMPLOYER_NAME_LENGTH = 100;

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || !userId.trim()) throw new NotAuthenticatedError();
  return userId;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------
// Upload and extraction
// ---------------------------------------------------------------------

export type Form16UploadInput = {
  filename: string;
  declaredContentType: string;
  bytes: Uint8Array;
};

/**
 * Validate, read and store a Form 16. Anything unsupported is refused BEFORE
 * anything is stored. A readable PDF that is not a Form 16 is kept but marked
 * failed, so the person can still download or delete it.
 */
export async function uploadForm16(userId: string, file: Form16UploadInput): Promise<DocumentSummary> {
  requireUserId(userId);
  assertDeclaredContentType(file.declaredContentType, ["application/pdf"]);
  checkPdfBytes(file.bytes);
  if (await findDocumentIdByHash(userId, sha256Hex(file.bytes))) {
    throw new ConflictError("This file has already been uploaded.");
  }

  let extraction: Form16Extraction;
  try {
    const { pages } = await readPdfText(file.bytes);
    extraction = extractForm16Fields(pages);
  } catch (error) {
    // Known refusals carry their own content-free messages. Anything else is
    // reduced to a generic message: raw parser text is never passed on.
    if (
      error instanceof UnprocessableContentError ||
      error instanceof PayloadTooLargeError ||
      error instanceof UnsupportedMediaTypeError ||
      error instanceof ValidationError
    ) {
      throw error;
    }
    throw new UnprocessableContentError("This PDF couldn’t be processed. It may be damaged. Download it again and retry.", "pdf_corrupt");
  }

  const usable = extraction.recognised.form16 || extraction.fields.some((f) => f.status !== "missing");

  let document: Awaited<ReturnType<typeof createDocumentWithFile>>;
  try {
    document = await db.transaction(async (tx) => {
      const stored = await createDocumentWithFile(
        userId,
        {
          documentType: "form16",
          filename: file.filename,
          contentType: "application/pdf",
          bytes: file.bytes,
          processingStatus: usable ? "extracted" : "failed",
        },
        tx,
      );
      await tx.insert(documentExtractions).values({
        documentId: stored.id,
        userId,
        extractorVersion: extraction.extractorVersion,
        status: usable ? "needs_review" : "failed",
        extracted: extraction,
        failureMessage: usable ? null : NOT_A_FORM16_MESSAGE,
      });
      return stored;
    });
  } catch (error) {
    if (
      error instanceof ConflictError ||
      error instanceof PayloadTooLargeError ||
      error instanceof UnprocessableContentError ||
      error instanceof UnsupportedMediaTypeError ||
      error instanceof ValidationError
    ) {
      throw error;
    }
    // A database error here would carry the statement's parameters (the file
    // bytes and extracted values). Never let it reach a log or a response.
    throw new Error("The document could not be stored.");
  }

  const summary = await getDocumentSummary(userId, document.id);
  if (!summary) throw new NotFoundError("Document not found.");
  return summary;
}

// ---------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------

export type Form16Detail = {
  document: DocumentSummary;
  extraction: {
    status: ReviewState;
    extractorVersion: string;
    /** What the parser read. Untrusted. */
    extracted: Form16Extraction;
    /** What the user confirmed; null until they do. */
    confirmed: Form16Confirmed | null;
    failureMessage: string | null;
  };
  supportedAssessmentYears: string[];
};

/** Read stored confirmed data back, refusing anything that is not exactly the shape this service writes. */
function readConfirmed(data: unknown): Form16Confirmed | null {
  if (!isPlainObject(data) || data.schemaVersion !== 1) return null;
  const isMoney = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  if (
    typeof data.extractorVersion !== "string" ||
    typeof data.assessmentYear !== "string" ||
    !(data.employerName === null || typeof data.employerName === "string") ||
    !isMoney(data.grossSalaryPaise) ||
    !isMoney(data.section10ExemptionsPaise) ||
    !isMoney(data.salaryIncomePaise) ||
    !(data.section80CPaise === null || isMoney(data.section80CPaise))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    extractorVersion: data.extractorVersion,
    assessmentYear: data.assessmentYear,
    employerName: data.employerName,
    grossSalaryPaise: data.grossSalaryPaise,
    section10ExemptionsPaise: data.section10ExemptionsPaise,
    salaryIncomePaise: data.salaryIncomePaise,
    section80CPaise: data.section80CPaise,
  };
}

export async function getForm16Detail(userId: string, documentId: string): Promise<Form16Detail> {
  requireUserId(userId);
  const document = await getDocumentSummary(userId, documentId);
  if (!document) throw new NotFoundError("Document not found.");

  const [row] = await db
    .select()
    .from(documentExtractions)
    .where(and(eq(documentExtractions.documentId, documentId), eq(documentExtractions.userId, userId)));
  if (!row) throw new NotFoundError("Document not found.");

  return {
    document,
    extraction: {
      status: row.status,
      extractorVersion: row.extractorVersion,
      extracted: row.extracted as Form16Extraction,
      confirmed: readConfirmed(row.confirmed),
      failureMessage: row.failureMessage,
    },
    supportedAssessmentYears: getSupportedAssessmentYearLabels(),
  };
}

// ---------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------

type ConfirmInput = {
  assessmentYear: string;
  employerName: string | null;
  grossSalaryPaise: number;
  section10ExemptionsPaise: number;
  section80CPaise: number | null;
};

function readMoney(container: Record<string, unknown>, key: string, { required }: { required: boolean }): number | null {
  const value = container[key];
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${key} is required.`);
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY_PAISE) {
    throw new ValidationError(`${key} must be a whole number of paise between 0 and ${MAX_MONEY_PAISE}.`);
  }
  return value;
}

/** Reads a fixed allow-list of fields; anything else the client sends (derived values, versions) is ignored. */
function parseConfirmBody(body: unknown): ConfirmInput {
  if (!isPlainObject(body)) throw new ValidationError("The request body must be a JSON object.");

  const assessmentYear = body.assessmentYear;
  if (typeof assessmentYear !== "string" || !/^\d{4}-\d{2}$/.test(assessmentYear)) {
    throw new ValidationError('assessmentYear is required, for example "2026-27".');
  }
  if (!getSupportedAssessmentYearLabels().includes(assessmentYear)) throw new UnsupportedAssessmentYearError(assessmentYear);

  const grossSalaryPaise = readMoney(body, "grossSalaryPaise", { required: true })!;
  if (grossSalaryPaise === 0) throw new ValidationError("Gross salary must be greater than zero.");
  const section10ExemptionsPaise = readMoney(body, "section10ExemptionsPaise", { required: true })!;
  if (section10ExemptionsPaise > grossSalaryPaise) {
    throw new ValidationError("Exemptions under Section 10 can’t be more than the gross salary.");
  }
  const section80CPaise = readMoney(body, "section80CPaise", { required: false });

  let employerName: string | null = null;
  if (body.employerName !== undefined && body.employerName !== null) {
    if (typeof body.employerName !== "string") throw new ValidationError("employerName must be text.");
    const cleaned = body.employerName.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
    if (cleaned.length > MAX_EMPLOYER_NAME_LENGTH) {
      throw new ValidationError(`employerName must be at most ${MAX_EMPLOYER_NAME_LENGTH} characters.`);
    }
    employerName = cleaned === "" ? null : cleaned;
  }

  return { assessmentYear, employerName, grossSalaryPaise, section10ExemptionsPaise, section80CPaise };
}

/**
 * Record what the user confirmed. The salary income is derived here, on the
 * server, from the confirmed gross salary and exemptions.
 */
export async function confirmForm16(userId: string, documentId: string, body: unknown): Promise<Form16Confirmed> {
  requireUserId(userId);
  const input = parseConfirmBody(body);

  const [row] = await db
    .select()
    .from(documentExtractions)
    .where(and(eq(documentExtractions.documentId, documentId), eq(documentExtractions.userId, userId)));
  if (!row) throw new NotFoundError("Document not found.");
  if (row.status !== "needs_review" && row.status !== "confirmed") {
    throw new ValidationError("This document couldn’t be read, so there is nothing to confirm.");
  }

  const salaryIncomePaise = deriveSalaryIncome(input.grossSalaryPaise, input.section10ExemptionsPaise);
  if (salaryIncomePaise === null) throw new ValidationError("The salary figures don’t add up.");

  const confirmed: Form16Confirmed = {
    schemaVersion: 1,
    extractorVersion: row.extractorVersion,
    assessmentYear: input.assessmentYear,
    employerName: input.employerName,
    grossSalaryPaise: input.grossSalaryPaise,
    section10ExemptionsPaise: input.section10ExemptionsPaise,
    salaryIncomePaise,
    section80CPaise: input.section80CPaise,
  };

  const [year] = await db.select({ id: assessmentYears.id }).from(assessmentYears).where(eq(assessmentYears.label, input.assessmentYear));

  try {
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx
        .update(documentExtractions)
        .set({ confirmed, confirmedAt: now, status: "confirmed", updatedAt: now })
        .where(and(eq(documentExtractions.documentId, documentId), eq(documentExtractions.userId, userId)));
      await tx
        .update(documents)
        .set({ assessmentYearId: year?.id ?? null, updatedAt: now })
        .where(and(eq(documents.id, documentId), eq(documents.userId, userId)));
    });
  } catch (error) {
    throw unsavedConfirmationError(error);
  }

  return confirmed;
}

/**
 * A database error from the confirmation write carries the statement's bound
 * parameters, which are the confirmed salary figures and employer name, and
 * the route logs unexpected errors. So it is replaced by a generic error (still
 * a plain 500 to the client) that keeps only the database's error code for
 * debugging. The raw error is deliberately not attached as a `cause`: logging
 * would print it.
 */
function unsavedConfirmationError(error: unknown): Error {
  const code = pgErrorCode(error);
  const detail = code && /^[0-9A-Za-z_]{1,32}$/.test(code) ? ` (database error ${code})` : "";
  return new Error(`The confirmation could not be saved${detail}.`);
}

// ---------------------------------------------------------------------
// What the Tax workspace may read
// ---------------------------------------------------------------------

/** A confirmed Form 16, offered to the Tax workspace as a suggestion. Nothing else about the document is exposed. */
export type Form16Suggestion = {
  documentId: string;
  filename: string;
  employerName: string | null;
  confirmedAt: string;
  grossSalaryPaise: number;
  section10ExemptionsPaise: number;
  salaryIncomePaise: number;
  section80CPaise: number | null;
};

/**
 * The user's CONFIRMED Form 16 values for an assessment year, newest first.
 * Reads only rows whose status is confirmed and only the `confirmed` column,
 * never `extracted`. A confirmed value that is not in the expected shape is
 * skipped rather than trusted.
 */
export async function listConfirmedForm16(userId: string, assessmentYearLabel: string): Promise<Form16Suggestion[]> {
  requireUserId(userId);
  const rows = await db
    .select({
      documentId: documents.id,
      filename: documents.filename,
      confirmed: documentExtractions.confirmed,
      confirmedAt: documentExtractions.confirmedAt,
    })
    .from(documentExtractions)
    .innerJoin(documents, and(eq(documents.id, documentExtractions.documentId), eq(documents.userId, userId)))
    .where(and(eq(documentExtractions.userId, userId), eq(documentExtractions.status, "confirmed")))
    .orderBy(desc(documentExtractions.confirmedAt));

  const suggestions: Form16Suggestion[] = [];
  for (const row of rows) {
    const confirmed = readConfirmed(row.confirmed);
    if (!confirmed || !row.confirmedAt || confirmed.assessmentYear !== assessmentYearLabel) continue;
    suggestions.push({
      documentId: row.documentId,
      filename: row.filename,
      employerName: confirmed.employerName,
      confirmedAt: row.confirmedAt.toISOString(),
      grossSalaryPaise: confirmed.grossSalaryPaise,
      section10ExemptionsPaise: confirmed.section10ExemptionsPaise,
      salaryIncomePaise: confirmed.salaryIncomePaise,
      section80CPaise: confirmed.section80CPaise,
    });
  }
  return suggestions;
}
