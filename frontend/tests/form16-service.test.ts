// Form 16 service tests: upload, extraction, review and confirmation, end to
// end through REAL PDFs (built in tests/helpers-pdf.ts) and the real parser.
// DB-backed; every test user is deleted afterwards.
//
// The trust boundary under test: extracted values are NOT trusted. Only what
// the user confirmed may reach the Tax workspace, and it is exactly what they
// confirmed, edits included.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { eq } from "drizzle-orm";
import { respondToError } from "../app/api/_lib/respond-error";
import { db } from "../db/client";
import { documentExtractions, documentFiles, documents } from "../db/schema";
import {
  ConflictError,
  NotFoundError,
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "../services/errors";
import { UnsupportedAssessmentYearError } from "../tax-engine";
import { deleteDocument, getDocumentSummary, listDocumentSummaries } from "../services/documents";
import { confirmForm16, getForm16Detail, listConfirmedForm16, uploadForm16 } from "../services/form16";
import { getTaxWorkspace } from "../services/tax";
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from "../lib/file-validation";
import { deleteTestUser, getSeededAssessmentYearId, makeTestUser } from "./helpers";
import { buildPdf, linesToPlacements } from "./helpers-pdf";

const rupees = (r: number) => r * 100;

async function withUser<T>(label: string, fn: (userId: string) => Promise<T>): Promise<T> {
  const user = await makeTestUser(label);
  try {
    return await fn(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}

/** A synthetic Form 16 (no real person): Part A on page 1, Part B on page 2. `marker` makes the bytes unique. */
function form16Pdf(marker = "one", overrides: { gross?: string; exemptions?: string } = {}): Uint8Array {
  const partA: Array<Array<[number, string]>> = [
    [[40, "FORM NO. 16"]],
    [[40, "PART A"], [120, "Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source on salary"]],
    [[40, "Name and address of the Employer"], [320, "Name and address of the Employee"]],
    [[40, `ACME ${marker.toUpperCase()} PRIVATE LIMITED`], [320, "TEST EMPLOYEE"]],
    [[40, "Assessment Year"], [140, "2026-27"]],
  ];
  const partB: Array<Array<[number, string]>> = [
    [[40, "PART B (Annexure)"]],
    [[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, overrides.gross ?? "1200000.00"]],
    [[40, "(h) Total amount of exemption claimed under section 10 [2(a)+2(b)]"], [450, overrides.exemptions ?? "100000.00"]],
    [[40, "3. Total amount of salary received from current employer [1(d)-2(h)]"], [450, "1100000.00"]],
    [[40, "(a) Standard deduction under section 16(ia)"], [450, "75000.00"]],
    [[40, "(a) life insurance premia, provident fund etc. under section 80C"], [400, "150000.00"], [450, "150000.00"], [500, "150000.00"]],
  ];
  return buildPdf([linesToPlacements(partA), linesToPlacements(partB)]);
}

const upload = (userId: string, bytes: Uint8Array, filename = "Form 16.pdf", declaredContentType = "application/pdf") =>
  uploadForm16(userId, { filename, declaredContentType, bytes });

const confirmBody = (overrides: Record<string, unknown> = {}) => ({
  assessmentYear: "2026-27",
  employerName: "ACME ONE PRIVATE LIMITED",
  grossSalaryPaise: rupees(12_00_000),
  section10ExemptionsPaise: rupees(1_00_000),
  section80CPaise: rupees(1_50_000),
  ...overrides,
});

async function countRowsFor(userId: string) {
  const docs = await db.select({ id: documents.id }).from(documents).where(eq(documents.userId, userId));
  const extractions = await db.select({ id: documentExtractions.id }).from(documentExtractions).where(eq(documentExtractions.userId, userId));
  const files = await Promise.all(docs.map((d) => db.select().from(documentFiles).where(eq(documentFiles.documentId, d.id))));
  return { documents: docs.length, extractions: extractions.length, files: files.flat().length };
}

// --- upload and extraction -----------------------------------------------

test("uploading a text Form 16 stores the file and an extraction that awaits review, with nothing confirmed", async () => {
  await withUser("upload", async (userId) => {
    const bytes = form16Pdf("one");
    const summary = await upload(userId, bytes);

    assert.equal(summary.filename, "Form 16.pdf");
    assert.equal(summary.documentType, "form16");
    assert.equal(summary.contentType, "application/pdf");
    assert.equal(summary.reviewState, "needs_review");
    assert.equal(summary.processingStatus, "extracted");
    assert.equal(summary.confirmedAt, null);
    assert.equal(summary.sizeBytes, bytes.length);

    const detail = await getForm16Detail(userId, summary.id);
    assert.equal(detail.extraction.status, "needs_review");
    assert.equal(detail.extraction.confirmed, null, "nothing is confirmed by extraction");
    assert.equal(detail.extraction.failureMessage, null);
    assert.equal(detail.extraction.extractorVersion, "form16-text-v1");

    const field = (key: string) => detail.extraction.extracted.fields.find((f) => f.key === key)!;
    assert.equal(field("grossSalary").status, "found");
    assert.equal(field("grossSalary").valuePaise, rupees(12_00_000));
    assert.equal(field("section10Exemptions").valuePaise, rupees(1_00_000));
    assert.equal(field("assessmentYear").value, "2026-27");
    assert.equal(field("employerName").value, "ACME ONE PRIVATE LIMITED");
    assert.equal(field("grossSalary").evidence?.page, 2);
    assert.deepEqual(detail.supportedAssessmentYears, ["2026-27"]);
  });
});

test("a valid text PDF that is not a Form 16 is kept but marked failed, and cannot be confirmed", async () => {
  await withUser("not-form16", async (userId) => {
    const other = buildPdf([linesToPlacements([[[40, "Monthly statement of account for a savings account, page one"]], [[40, "Opening balance"], [300, "1,000.00"]]])]);
    const summary = await upload(userId, other);
    assert.equal(summary.reviewState, "failed");
    assert.equal(summary.processingStatus, "failed");

    const detail = await getForm16Detail(userId, summary.id);
    assert.equal(detail.extraction.status, "failed");
    assert.match(detail.extraction.failureMessage ?? "", /Form 16/);
    await assert.rejects(() => confirmForm16(userId, summary.id, confirmBody()), ValidationError);
  });
});

test("every unsupported file is refused with the right error and leaves NOTHING stored", async () => {
  await withUser("reject", async (userId) => {
    const rejections: Array<[string, () => Promise<unknown>, (e: unknown) => boolean]> = [
      ["not a PDF", () => upload(userId, new TextEncoder().encode("date,amount\n2026-03-05,100\n")), (e) => e instanceof UnsupportedMediaTypeError],
      ["wrong declared type", () => upload(userId, form16Pdf("t1"), "x.pdf", "image/png"), (e) => e instanceof UnsupportedMediaTypeError],
      ["empty", () => upload(userId, new Uint8Array(0)), (e) => e instanceof ValidationError],
      ["oversized", () => upload(userId, Object.assign(new Uint8Array(MAX_PDF_BYTES + 1), { 0: 0x25, 1: 0x50, 2: 0x44, 3: 0x46, 4: 0x2d })), (e) => e instanceof PayloadTooLargeError],
      ["truncated", () => upload(userId, form16Pdf("t2").slice(0, 400)), (e) => e instanceof UnprocessableContentError && e.code === "pdf_corrupt"],
      ["scanned", () => upload(userId, buildPdf([[], []])), (e) => e instanceof UnprocessableContentError && e.code === "pdf_scanned"],
      ["password-protected", () => upload(userId, buildPdf([linesToPlacements([[[50, "Gross Salary"], [400, "12,00,000.00"]]])], { encrypted: true })), (e) => e instanceof UnprocessableContentError && e.code === "pdf_encrypted"],
      ["too many pages", () => upload(userId, buildPdf(Array.from({ length: MAX_PDF_PAGES + 1 }, () => linesToPlacements([[[50, "A page with enough text to count"]]])))), (e) => e instanceof UnprocessableContentError && e.code === "pdf_too_many_pages"],
    ];
    for (const [name, run, expected] of rejections) {
      await assert.rejects(run, (e: unknown) => expected(e), name);
    }
    assert.deepEqual(await countRowsFor(userId), { documents: 0, extractions: 0, files: 0 });
  });
});

test("uploading the same file again is a conflict, even under another name, and adds nothing", async () => {
  await withUser("dupe", async (userId) => {
    const bytes = form16Pdf("dupe");
    await upload(userId, bytes);
    await assert.rejects(() => upload(userId, bytes, "copy of Form 16.pdf"), ConflictError);
    assert.deepEqual(await countRowsFor(userId), { documents: 1, extractions: 1, files: 1 });
  });
});

test("error messages never contain anything from the document", async () => {
  await withUser("content-free", async (userId) => {
    const scanned = buildPdf([[], []]);
    const encrypted = buildPdf([linesToPlacements([[[50, "SECRET-EMPLOYER Gross Salary"], [400, "98,76,543.21"]]])], { encrypted: true });
    for (const bytes of [scanned, encrypted, form16Pdf("cf").slice(0, 300)]) {
      await assert.rejects(
        () => upload(userId, bytes),
        (e: unknown) => {
          const text = `${(e as Error).message} ${JSON.stringify(e)}`;
          assert.equal(/SECRET-EMPLOYER|98,76,543|9876543|Exception|stack/i.test(text), false);
          return true;
        },
      );
    }
  });
});

test("nothing from a document reaches the console during upload, review or confirmation", async () => {
  await withUser("no-logs", async (userId) => {
    const calls: string[] = [];
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const level of Object.keys(originals) as Array<keyof typeof originals>) {
      console[level] = (...args: unknown[]) => void calls.push(args.map(String).join(" "));
    }
    try {
      const summary = await upload(userId, form16Pdf("quiet"));
      await getForm16Detail(userId, summary.id);
      await confirmForm16(userId, summary.id, confirmBody());
      await upload(userId, buildPdf([[], []])).catch(() => undefined);
    } finally {
      Object.assign(console, originals);
    }
    assert.equal(calls.some((c) => /ACME|12,00,000|1200000|TEST EMPLOYEE/i.test(c)), false, calls.join(" | "));
  });
});

// --- ownership ---------------------------------------------------------------

test("another user can neither see, review, confirm nor delete a Form 16", async () => {
  const userA = await makeTestUser("f16-a");
  const userB = await makeTestUser("f16-b");
  try {
    const doc = await upload(userA.id, form16Pdf("owned"));
    await assert.rejects(() => getForm16Detail(userB.id, doc.id), NotFoundError);
    await assert.rejects(() => confirmForm16(userB.id, doc.id, confirmBody()), NotFoundError);
    await assert.rejects(() => deleteDocument(userB.id, doc.id), NotFoundError);
    assert.equal((await listDocumentSummaries(userB.id)).length, 0);

    // A's document is untouched by B's attempts.
    const still = await getDocumentSummary(userA.id, doc.id);
    assert.equal(still?.reviewState, "needs_review");
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("the same Form 16 may be uploaded by two users independently", async () => {
  const userA = await makeTestUser("same-f16-a");
  const userB = await makeTestUser("same-f16-b");
  try {
    const bytes = form16Pdf("shared");
    const a = await upload(userA.id, bytes);
    const b = await upload(userB.id, bytes);
    assert.notEqual(a.id, b.id);
    await confirmForm16(userA.id, a.id, confirmBody());
    assert.equal((await getDocumentSummary(userB.id, b.id))?.reviewState, "needs_review", "A confirming does not confirm B's copy");
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

// --- confirmation --------------------------------------------------------------

test("confirming records exactly what the user confirmed, with the salary derived on the server", async () => {
  await withUser("confirm", async (userId) => {
    const ayId = await getSeededAssessmentYearId();
    const doc = await upload(userId, form16Pdf("confirm"));

    // The client tries to assert a derived figure; it is ignored.
    const confirmed = await confirmForm16(userId, doc.id, { ...confirmBody(), salaryIncomePaise: 1, schemaVersion: 99 });
    assert.deepEqual(confirmed, {
      schemaVersion: 1,
      extractorVersion: "form16-text-v1",
      assessmentYear: "2026-27",
      employerName: "ACME ONE PRIVATE LIMITED",
      grossSalaryPaise: rupees(12_00_000),
      section10ExemptionsPaise: rupees(1_00_000),
      salaryIncomePaise: rupees(11_00_000),
      section80CPaise: rupees(1_50_000),
    });

    const summary = await getDocumentSummary(userId, doc.id);
    assert.equal(summary?.reviewState, "confirmed");
    assert.ok(summary?.confirmedAt);
    assert.equal(summary?.assessmentYear, "2026-27");
    const [row] = await db.select().from(documents).where(eq(documents.id, doc.id));
    assert.equal(row.assessmentYearId, ayId);

    const detail = await getForm16Detail(userId, doc.id);
    assert.deepEqual(detail.extraction.confirmed, confirmed);
    // The extracted values are still there, unchanged, next to what was confirmed.
    assert.equal(detail.extraction.extracted.fields.find((f) => f.key === "grossSalary")?.valuePaise, rupees(12_00_000));
  });
});

test("confirming values the user EDITED stores the edits, not the extraction", async () => {
  await withUser("edit", async (userId) => {
    const doc = await upload(userId, form16Pdf("edit"));
    const confirmed = await confirmForm16(
      userId,
      doc.id,
      confirmBody({ grossSalaryPaise: rupees(13_00_000), section10ExemptionsPaise: rupees(50_000), section80CPaise: null, employerName: "  Edited Employer  " }),
    );
    assert.equal(confirmed.grossSalaryPaise, rupees(13_00_000));
    assert.equal(confirmed.salaryIncomePaise, rupees(12_50_000));
    assert.equal(confirmed.section80CPaise, null);
    assert.equal(confirmed.employerName, "Edited Employer");
  });
});

test("an optional 80C and employer name may be left out", async () => {
  await withUser("optional", async (userId) => {
    const doc = await upload(userId, form16Pdf("optional"));
    const confirmed = await confirmForm16(userId, doc.id, { assessmentYear: "2026-27", grossSalaryPaise: rupees(9_00_000), section10ExemptionsPaise: 0 });
    assert.equal(confirmed.employerName, null);
    assert.equal(confirmed.section80CPaise, null);
    assert.equal(confirmed.salaryIncomePaise, rupees(9_00_000));
  });
});

test("a confirmed document can be corrected by confirming again", async () => {
  await withUser("reconfirm", async (userId) => {
    const doc = await upload(userId, form16Pdf("reconfirm"));
    await confirmForm16(userId, doc.id, confirmBody());
    const second = await confirmForm16(userId, doc.id, confirmBody({ grossSalaryPaise: rupees(14_00_000) }));
    assert.equal(second.salaryIncomePaise, rupees(13_00_000));
    assert.equal((await getForm16Detail(userId, doc.id)).extraction.confirmed?.grossSalaryPaise, rupees(14_00_000));
    assert.equal((await getDocumentSummary(userId, doc.id))?.reviewState, "confirmed");
  });
});

test("confirmation refuses impossible or malformed values and leaves the document unconfirmed", async () => {
  await withUser("confirm-bad", async (userId) => {
    const doc = await upload(userId, form16Pdf("bad"));
    const bad: Array<[string, unknown]> = [
      ["exemptions above gross", confirmBody({ section10ExemptionsPaise: rupees(13_00_000) })],
      ["negative gross", confirmBody({ grossSalaryPaise: -1 })],
      ["zero gross", confirmBody({ grossSalaryPaise: 0 })],
      ["fractional paise", confirmBody({ grossSalaryPaise: 1.5 })],
      ["gross as a string", confirmBody({ grossSalaryPaise: "1200000" })],
      ["NaN", confirmBody({ grossSalaryPaise: Number.NaN })],
      ["absurdly large", confirmBody({ grossSalaryPaise: 10 ** 15 })],
      ["negative exemptions", confirmBody({ section10ExemptionsPaise: -1 })],
      ["missing gross", confirmBody({ grossSalaryPaise: undefined })],
      ["missing exemptions (zero must be stated, not assumed)", confirmBody({ section10ExemptionsPaise: undefined })],
      ["negative 80C", confirmBody({ section80CPaise: -5 })],
      ["over-long employer", confirmBody({ employerName: "x".repeat(101) })],
      ["not an object", "x"],
      ["null", null],
    ];
    for (const [name, body] of bad) {
      await assert.rejects(() => confirmForm16(userId, doc.id, body), ValidationError, name);
    }
    await assert.rejects(() => confirmForm16(userId, doc.id, confirmBody({ assessmentYear: "2031-32" })), UnsupportedAssessmentYearError);
    await assert.rejects(() => confirmForm16(userId, doc.id, confirmBody({ assessmentYear: "next year" })), ValidationError);
    assert.equal((await getDocumentSummary(userId, doc.id))?.reviewState, "needs_review");
  });
});

// --- only confirmed values reach the tax service --------------------------

test("the Tax workspace exposes NOTHING from a Form 16 until it is confirmed", async () => {
  await withUser("workspace-unconfirmed", async (userId) => {
    await upload(userId, form16Pdf("ws1"));
    assert.deepEqual(await listConfirmedForm16(userId, "2026-27"), []);
    assert.deepEqual((await getTaxWorkspace(userId)).form16Suggestions, []);
  });
});

test("after confirmation the workspace offers exactly the confirmed values, as a suggestion", async () => {
  await withUser("workspace-confirmed", async (userId) => {
    const doc = await upload(userId, form16Pdf("ws2"));
    await confirmForm16(userId, doc.id, confirmBody({ grossSalaryPaise: rupees(13_00_000), section10ExemptionsPaise: rupees(50_000) }));

    const { form16Suggestions } = await getTaxWorkspace(userId);
    assert.equal(form16Suggestions.length, 1);
    const [suggestion] = form16Suggestions;
    assert.equal(suggestion.documentId, doc.id);
    assert.equal(suggestion.filename, "Form 16.pdf");
    assert.equal(suggestion.employerName, "ACME ONE PRIVATE LIMITED");
    assert.equal(suggestion.grossSalaryPaise, rupees(13_00_000), "the user's edit, not the extracted 12,00,000");
    assert.equal(suggestion.section10ExemptionsPaise, rupees(50_000));
    assert.equal(suggestion.salaryIncomePaise, rupees(12_50_000));
    assert.equal(suggestion.section80CPaise, rupees(1_50_000));
    assert.ok(suggestion.confirmedAt);
    // Nothing else leaks: no evidence, no extraction, no storage details.
    assert.deepEqual(Object.keys(suggestion).sort(), ["confirmedAt", "documentId", "employerName", "filename", "grossSalaryPaise", "salaryIncomePaise", "section10ExemptionsPaise", "section80CPaise"]);
  });
});

test("suggestions are private to the user, limited to the assessment year, and disappear with the document", async () => {
  const userA = await makeTestUser("sugg-a");
  const userB = await makeTestUser("sugg-b");
  try {
    const doc = await upload(userA.id, form16Pdf("sugg"));
    await confirmForm16(userA.id, doc.id, confirmBody());

    assert.equal((await getTaxWorkspace(userA.id)).form16Suggestions.length, 1);
    assert.deepEqual((await getTaxWorkspace(userB.id)).form16Suggestions, []);
    assert.equal((await listConfirmedForm16(userA.id, "2025-26")).length, 0, "another year sees none");

    await deleteDocument(userA.id, doc.id);
    assert.deepEqual((await getTaxWorkspace(userA.id)).form16Suggestions, []);
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("a confirmed row that is not in the expected shape is ignored rather than trusted", async () => {
  await withUser("corrupt-confirmed", async (userId) => {
    const doc = await upload(userId, form16Pdf("corrupt"));
    await db
      .update(documentExtractions)
      .set({ status: "confirmed", confirmedAt: new Date(), confirmed: { schemaVersion: 99, salaryIncomePaise: 1 } })
      .where(eq(documentExtractions.documentId, doc.id));
    assert.deepEqual(await listConfirmedForm16(userId, "2026-27"), []);
  });
});

test("a needs_review row is never offered even if a confirmed value somehow exists on it", async () => {
  await withUser("status-gate", async (userId) => {
    const doc = await upload(userId, form16Pdf("gate"));
    await confirmForm16(userId, doc.id, confirmBody());
    // Force the status back: only status = confirmed counts.
    await db.update(documentExtractions).set({ status: "needs_review" }).where(eq(documentExtractions.documentId, doc.id));
    assert.deepEqual(await listConfirmedForm16(userId, "2026-27"), []);
  });
});

// --- error logging -----------------------------------------------------------

test("a failed confirmation write never puts the confirmed values into the logged or returned error", async () => {
  await withUser("confirm-log", async (userId) => {
    const summary = await upload(userId, form16Pdf("log"));
    const secret = { employer: "SECRET-EMPLOYER-QWERTY", gross: 987_654_321, exemptions: 123_456_789, section80C: 55_555_555 };
    const sensitive = [secret.employer, String(secret.gross), String(secret.exemptions), String(secret.section80C)];
    const body = confirmBody({
      employerName: secret.employer,
      grossSalaryPaise: secret.gross,
      section10ExemptionsPaise: secret.exemptions,
      section80CPaise: secret.section80C,
    });

    // Make the confirmation write fail the way a real database failure does: a REAL Drizzle query
    // error, carrying the statement's bound parameters, thrown from inside the transaction. The
    // failing statement is the service's own update (same table, same values), pointed at an id
    // Postgres rejects.
    let rawMessage = "";
    const realTransaction = db.transaction;
    (db as unknown as { transaction: unknown }).transaction = async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        update: (table: typeof documentExtractions) => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              try {
                await db.update(table).set(values).where(eq(documentExtractions.documentId, "not-a-uuid"));
              } catch (error) {
                rawMessage = (error as Error).message;
                throw error;
              }
            },
          }),
        }),
      });

    const logged: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    let thrown: unknown;
    let response: Response;
    try {
      thrown = await confirmForm16(userId, summary.id, body).then(
        () => undefined,
        (error: unknown) => error,
      );
      response = respondToError(thrown); // exactly what the route does with it (and what logs it)
    } finally {
      console.error = originalConsoleError;
      (db as unknown as { transaction: unknown }).transaction = realTransaction;
    }

    // Control: the raw database error really does carry the values, so this test can fail.
    for (const value of sensitive) assert.ok(rawMessage.includes(value), `the raw error should contain ${value}`);

    // The API behaves as before: an unexpected failure is a plain 500.
    assert.ok(thrown instanceof Error);
    assert.equal(response.status, 500);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, { error: "Internal server error" });

    // Nothing sensitive in what was thrown, logged or returned, including any nested cause.
    const everything = inspect([thrown, logged, responseBody], { depth: 20, breakLength: Infinity });
    for (const value of sensitive) assert.ok(!everything.includes(value), `${value} must not appear in the error, the log or the response`);
    assert.doesNotMatch(everything, /params:|Failed query/);
    assert.equal((thrown as Error & { cause?: unknown }).cause, undefined, "the raw driver error must not be attached as a cause");

    // Developers still get a logged error, with the database error code to go on.
    assert.equal(logged.length, 1);
    assert.match(everything, /could not be saved/);
    assert.match(everything, /22P02/);

    // And nothing was confirmed.
    const detail = await getForm16Detail(userId, summary.id);
    assert.equal(detail.extraction.status, "needs_review");
    assert.equal(detail.extraction.confirmed, null);
  });
});
