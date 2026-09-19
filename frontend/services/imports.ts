// CSV transaction import: a two-step, stateless flow.
//
//   previewCsv  parse + validate + report. WRITES NOTHING.
//   commitCsv   re-reads the submitted file and mapping from scratch,
//               re-validates every row, and imports all-or-nothing.
//
// The commit never trusts anything from the preview: it is given the file and
// the mapping again and derives everything itself. The CSV file is not kept;
// only the transactions and a small `import_batches` record (file name,
// counts, time) remain.
//
// Nothing is guessed. The amount layout, what a positive amount means, the
// date format and the default category all come from the mapping the person
// chose, and a mapping that leaves any of them open is refused. One invalid
// row means no rows are imported.
//
// Errors and logs never contain file content. Unexpected database errors are
// replaced by a generic one before they can be logged, because Drizzle errors
// embed the statement's parameters (the row values).
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { importBatches, transactions } from "@/db/schema";
import { detectDateFormats } from "@/lib/date-parse";
import type { DateFormatId } from "@/lib/date-parse";
import { detectDelimiter, parseCsv } from "@/lib/csv";
import type { CsvDelimiter, CsvRecord } from "@/lib/csv";
import {
  fingerprintForSlot,
  fingerprintRows,
  identityKey,
  suggestMapping,
  summarizeRows,
  validateCsvRows,
  validateMapping,
} from "@/lib/csv-import";
import type { CsvMapping, MappingSuggestion, ParsedRow, RowError, RowSummary } from "@/lib/csv-import";
import { assertDeclaredContentType, decodeCsvBytes, MAX_CSV_ROWS, sanitizeFilename } from "@/lib/file-validation";
import { insertImportedTransactions } from "./transactions";
import {
  ConflictError,
  NotAuthenticatedError,
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "./errors";

const CSV_CONTENT_TYPES = ["text/csv", "application/csv", "text/plain", "text/comma-separated-values", "application/vnd.ms-excel"];
const SAMPLE_ROWS = 10;
const PREVIEW_ROWS = 20;
const LOOKUP_CHUNK = 1000;
const DELIMITERS: CsvDelimiter[] = [",", ";", "\t", "|"];

export type CsvUpload = { filename: string; declaredContentType: string; bytes: Uint8Array };

/** A row of the file whose fingerprint this user already has: enough to recognise it. */
export type MatchedRow = {
  /** The physical line in the file (the header is line 1). */
  line: number;
  occurredOn: string;
  type: "income" | "expense";
  amountPaise: number;
  description: string | null;
};

export type CsvPreview = {
  filename: string;
  /** The delimiter used to read the file: the mapping's if one was given, otherwise the detected suggestion. */
  delimiter: CsvDelimiter;
  headers: string[];
  /** Data rows, not counting the header. */
  totalRows: number;
  /** The first rows exactly as they appear in the file. */
  sampleRows: string[][];
  /** Proposals only. Nothing here is applied without the person choosing it. */
  suggestion: MappingSuggestion & { delimiter: CsvDelimiter; dateFormat?: DateFormatId };
  /** Date formats under which every value in the date column reads as a real date. */
  detectedDateFormats: DateFormatId[];
  mapping:
    | null
    | { status: "incomplete"; problems: string[] }
    | {
        status: "checked";
        /** True only when there are rows and none has a problem. */
        valid: boolean;
        errorCount: number;
        /** At most 100. */
        errors: RowError[];
        /** Null unless valid. */
        summary: RowSummary | null;
        previewRows: ParsedRow[];
        /** Rows that match rows this user already imported. A commit skips them unless they are chosen by line number. */
        matchedRows: MatchedRow[];
        /** Equals `matchedRows.length`. */
        alreadyImportedCount: number;
        /** Rows a commit would import with no override: the rest of the file. */
        newRowCount: number;
      };
};

export type CsvImportSummary = {
  batchId: string;
  filename: string;
  /** Rows in the file. */
  rowCount: number;
  /** Includes the rows imported despite matching (`forcedCount`). */
  insertedCount: number;
  /** Matched rows that were not chosen, so were not imported. Listed in `skippedRows`. */
  skippedDuplicateCount: number;
  /** Matched rows the person chose to import anyway. */
  forcedCount: number;
  skippedRows: MatchedRow[];
  /** The following describe the rows actually inserted. */
  incomeCount: number;
  expenseCount: number;
  incomeTotalPaise: number;
  expenseTotalPaise: number;
  defaultCategoryCount: number;
};

function requireUserId(userId: string): string {
  if (typeof userId !== "string" || !userId.trim()) throw new NotAuthenticatedError();
  return userId;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------

function readCsv(upload: CsvUpload, delimiterFromMapping: unknown): { records: CsvRecord[]; delimiter: CsvDelimiter } {
  assertDeclaredContentType(upload.declaredContentType, CSV_CONTENT_TYPES);
  const text = decodeCsvBytes(upload.bytes);

  const delimiter = DELIMITERS.includes(delimiterFromMapping as CsvDelimiter)
    ? (delimiterFromMapping as CsvDelimiter)
    : detectDelimiter(text);

  // The header counts as one record.
  const parsed = parseCsv(text, { delimiter, maxRecords: MAX_CSV_ROWS + 1 });
  if (!parsed.ok) {
    if (parsed.kind === "too_many_records") {
      throw new UnprocessableContentError(
        `This file has more than ${MAX_CSV_ROWS.toLocaleString("en-IN")} rows. Split it and import the parts.`,
        "csv_too_many_rows",
      );
    }
    throw new UnprocessableContentError(parsed.message, "csv_parse_error", { line: parsed.line });
  }
  if (parsed.records.length === 0) throw new UnprocessableContentError("The file has no rows.", "csv_empty");
  return { records: parsed.records, delimiter };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const toMatchedRow = (row: ParsedRow): MatchedRow => ({
  line: row.line,
  occurredOn: row.occurredOn,
  type: row.type,
  amountPaise: row.amountPaise,
  description: row.description,
});

/** Which of these fingerprints has this user already imported? */
async function existingFingerprints(
  userId: string,
  fingerprints: string[],
  executor: Pick<typeof db, "select"> = db,
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < fingerprints.length; start += LOOKUP_CHUNK) {
    const chunk = fingerprints.slice(start, start + LOOKUP_CHUNK);
    const rows = await executor
      .select({ fingerprint: transactions.importFingerprint })
      .from(transactions)
      .where(and(eq(transactions.userId, userId), inArray(transactions.importFingerprint, chunk)));
    for (const { fingerprint } of rows) if (fingerprint) found.add(fingerprint);
  }
  return found;
}

// ---------------------------------------------------------------------
// Preview (writes nothing)
// ---------------------------------------------------------------------

export async function previewCsv(userId: string, upload: CsvUpload, mappingInput?: unknown): Promise<CsvPreview> {
  requireUserId(userId);
  const delimiterHint = isPlainObject(mappingInput) ? mappingInput.delimiter : undefined;
  const { records, delimiter } = readCsv(upload, delimiterHint);

  const headers = records[0].fields.map((h) => h.trim());
  const dataRecords = records.slice(1);
  const suggested = suggestMapping(headers);

  // Which column holds the dates: the person's choice if they made one, else the suggestion.
  const chosen = isPlainObject(mappingInput) && isPlainObject(mappingInput.columns) ? mappingInput.columns.date : undefined;
  const dateColumn = Number.isInteger(chosen) ? (chosen as number) : suggested.columns.date;
  const detectedDateFormats =
    dateColumn === undefined ? [] : detectDateFormats(dataRecords.map((r) => r.fields[dateColumn] ?? ""));

  const preview: CsvPreview = {
    filename: sanitizeFilename(upload.filename),
    delimiter,
    headers,
    totalRows: dataRecords.length,
    sampleRows: dataRecords.slice(0, SAMPLE_ROWS).map((r) => r.fields),
    suggestion: {
      ...suggested,
      delimiter,
      // Suggested only when exactly one format fits; otherwise the person decides.
      ...(detectedDateFormats.length === 1 ? { dateFormat: detectedDateFormats[0] } : {}),
    },
    detectedDateFormats,
    mapping: null,
  };

  if (mappingInput === undefined || mappingInput === null) return preview;

  const checked = validateMapping(mappingInput, headers.length);
  if (!checked.ok) return { ...preview, mapping: { status: "incomplete", problems: checked.problems } };

  const result = validateCsvRows(records, checked.mapping);
  const valid = result.errorCount === 0 && result.rows.length > 0;

  // Rows whose fingerprint this user already has. Nothing is decided here: the person sees them
  // and a commit skips them unless they are chosen by line number. Writes nothing.
  let matchedRows: MatchedRow[] = [];
  if (valid) {
    const fingerprinted = fingerprintRows(result.rows);
    const existing = await existingFingerprints(userId, fingerprinted.map((r) => r.fingerprint));
    matchedRows = fingerprinted.filter((r) => existing.has(r.fingerprint)).map(toMatchedRow);
  }

  return {
    ...preview,
    mapping: {
      status: "checked",
      valid,
      errorCount: result.errorCount,
      errors: result.errors,
      summary: valid ? summarizeRows(result.rows) : null,
      previewRows: valid ? result.rows.slice(0, PREVIEW_ROWS) : [],
      matchedRows,
      alreadyImportedCount: matchedRows.length,
      newRowCount: valid ? result.rows.length - matchedRows.length : 0,
    },
  };
}

// ---------------------------------------------------------------------
// Commit (all or nothing)
// ---------------------------------------------------------------------

const toImportedInput = (row: ParsedRow & { fingerprint: string }) => ({
  type: row.type,
  amountPaise: row.amountPaise,
  category: row.category,
  description: row.description,
  occurredOn: row.occurredOn,
  importFingerprint: row.fingerprint,
});

// How the override path looks for a free occurrence slot, and how often it retries after losing a race.
const SLOT_SCAN_CHUNK = 32;
const MAX_SLOT_SCAN = 100_000;
const MAX_OVERRIDE_ATTEMPTS = 10;

/**
 * `count` fingerprints for this identity, taking the lowest occurrence slots
 * the user does not already have. Deterministic for a given database state, and
 * read inside the import's transaction so its own inserts count as taken.
 */
async function freeSlotFingerprints(tx: Tx, userId: string, key: string, count: number): Promise<string[]> {
  const free: string[] = [];
  for (let start = 0; free.length < count; start += SLOT_SCAN_CHUNK) {
    if (start > MAX_SLOT_SCAN) throw new ConflictError("Too many identical transactions to import another. Nothing was imported.");
    const candidates = Array.from({ length: SLOT_SCAN_CHUNK }, (_, i) => fingerprintForSlot(key, start + i));
    const taken = await existingFingerprints(userId, candidates, tx);
    for (const fingerprint of candidates) {
      if (free.length < count && !taken.has(fingerprint)) free.push(fingerprint);
    }
  }
  return free;
}

/**
 * Insert rows the person chose to import although they match rows already
 * imported. Each takes the next free occurrence slot for its identity, so it
 * gets a real, deterministic fingerprint and the unique index on
 * (user, fingerprint) still covers it. If another import takes a chosen slot
 * first, the insert conflicts; the row is retried on the next free slot. A
 * chosen row is never dropped: if it cannot be placed, the whole import fails
 * and rolls back.
 */
async function insertChosenMatches(tx: Tx, userId: string, batchId: string, rows: ParsedRow[]): Promise<void> {
  let pending = rows;
  for (let attempt = 0; pending.length > 0 && attempt < MAX_OVERRIDE_ATTEMPTS; attempt++) {
    const byIdentity = new Map<string, ParsedRow[]>();
    for (const row of pending) {
      const key = identityKey(row);
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), row]);
    }

    const placed: Array<ParsedRow & { fingerprint: string }> = [];
    for (const [key, group] of byIdentity) {
      const fingerprints = await freeSlotFingerprints(tx, userId, key, group.length);
      group.forEach((row, i) => placed.push({ ...row, fingerprint: fingerprints[i] }));
    }

    const inserted = await insertImportedTransactions(userId, batchId, placed.map(toImportedInput), tx);
    pending = placed.filter((row) => !inserted.has(row.fingerprint));
  }
  if (pending.length > 0) {
    throw new ConflictError("Other imports were changing the same transactions at the same time. Nothing was imported. Try again.");
  }
}

/**
 * The transactional core, exported for tests. Creates the batch and inserts
 * every row inside ONE database transaction: if anything fails, nothing
 * remains, including the batch record.
 *
 * A row whose fingerprint the user already has is MATCHED, decided by the
 * unique index itself (so it is race-safe). A matched row is skipped unless its
 * line is in `includeLines`, in which case it is imported on the next free
 * occurrence slot. Every matched row is reported, never dropped silently.
 */
export async function importRows(
  userId: string,
  filename: string,
  rows: Array<ParsedRow & { fingerprint: string }>,
  options: { includeLines?: ReadonlySet<number> } = {},
): Promise<CsvImportSummary> {
  const includeLines = options.includeLines ?? new Set<number>();

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .insert(importBatches)
      .values({ userId, filename: sanitizeFilename(filename), rowCount: rows.length, insertedCount: 0, skippedDuplicateCount: 0 })
      .returning();

    const inserted = await insertImportedTransactions(userId, batch.id, rows.map(toImportedInput), tx);

    const matched = rows.filter((row) => !inserted.has(row.fingerprint));
    const chosen = matched.filter((row) => includeLines.has(row.line));
    const skipped = matched.filter((row) => !includeLines.has(row.line));
    await insertChosenMatches(tx, userId, batch.id, chosen);

    const chosenSet = new Set(chosen);
    const insertedRows = rows.filter((row) => inserted.has(row.fingerprint) || chosenSet.has(row));
    await tx
      .update(importBatches)
      .set({ insertedCount: insertedRows.length, skippedDuplicateCount: skipped.length })
      .where(eq(importBatches.id, batch.id));

    const summary = summarizeRows(insertedRows);
    return {
      batchId: batch.id,
      filename: batch.filename,
      rowCount: rows.length,
      insertedCount: insertedRows.length,
      skippedDuplicateCount: skipped.length,
      forcedCount: chosen.length,
      skippedRows: skipped.map(toMatchedRow),
      incomeCount: summary.incomeCount,
      expenseCount: summary.expenseCount,
      incomeTotalPaise: summary.incomeTotalPaise,
      expenseTotalPaise: summary.expenseTotalPaise,
      defaultCategoryCount: summary.defaultCategoryCount,
    };
  });
}

/** The file lines the person chose to import although they match earlier rows. Validated, never trusted. */
function parseIncludeLines(input: unknown): Set<number> {
  if (input === undefined || input === null) return new Set();
  if (!Array.isArray(input) || input.length > MAX_CSV_ROWS || !input.every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new ValidationError("includeLines must be a list of line numbers from the file.");
  }
  return new Set(input as number[]);
}

/**
 * Import a CSV. `options.includeLines` lists lines of the file whose rows match
 * earlier imports but should be imported anyway; without it they are skipped
 * (and reported). The file and mapping are re-read and re-validated here.
 */
export async function commitCsv(
  userId: string,
  upload: CsvUpload,
  mappingInput: unknown,
  options: { includeLines?: unknown } = {},
): Promise<CsvImportSummary> {
  requireUserId(userId);
  const includeLines = parseIncludeLines(options.includeLines);
  const delimiterHint = isPlainObject(mappingInput) ? mappingInput.delimiter : undefined;
  const { records } = readCsv(upload, delimiterHint);

  // Everything is derived again here. Nothing from a preview is consulted.
  const checked = validateMapping(mappingInput, records[0].fields.length);
  if (!checked.ok) {
    throw new UnprocessableContentError("The column mapping is incomplete.", "csv_mapping_invalid", { problems: checked.problems });
  }
  const mapping: CsvMapping = checked.mapping;

  const result = validateCsvRows(records, mapping);
  if (result.dataRowCount === 0) {
    throw new UnprocessableContentError("The file has a header but no data rows.", "csv_empty");
  }
  if (result.errorCount > 0) {
    const s = result.errorCount === 1 ? "" : "s";
    throw new UnprocessableContentError(
      `${result.errorCount} problem${s} found. Nothing was imported. Fix the file and try again.`,
      "csv_validation_failed",
      { errorCount: result.errorCount, errors: result.errors },
    );
  }

  try {
    return await importRows(userId, upload.filename, fingerprintRows(result.rows), { includeLines });
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
    // Drizzle errors carry the failed statement's parameters, which are the
    // row values. Never let them reach a log or a response.
    throw new Error("The import could not be completed. Nothing was imported.");
  }
}
