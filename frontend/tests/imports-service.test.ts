// CSV import service tests. DB-backed; every test user is deleted afterwards.
//
// The contract: PREVIEW writes nothing and reports what would happen; COMMIT
// trusts nothing from the preview, re-reads and re-validates the file and
// mapping itself, and is all-or-nothing; re-importing a file adds nothing;
// legitimately repeated rows are kept; every read and write is per user.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { isUniqueViolation } from "../db/pg-errors";
import { importBatches, transactions } from "../db/schema";
import {
  NotAuthenticatedError,
  PayloadTooLargeError,
  UnprocessableContentError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "../services/errors";
import { commitCsv, importRows, previewCsv } from "../services/imports";
import { listTransactions } from "../services/transactions";
import { fingerprintForSlot, fingerprintRows, identityKey } from "../lib/csv-import";
import type { CsvMapping } from "../lib/csv-import";
import { MAX_CSV_BYTES, MAX_CSV_ROWS } from "../lib/file-validation";
import { deleteTestUser, makeTestUser } from "./helpers";

const enc = (s: string) => new TextEncoder().encode(s);
const upload = (text: string, filename = "statement.csv", declaredContentType = "text/csv") => ({
  filename,
  declaredContentType,
  bytes: enc(text),
});

const noColumns = { date: null, description: null, category: null, amount: null, debit: null, credit: null, type: null };
const signed = (overrides: Partial<CsvMapping> = {}): CsvMapping => ({
  delimiter: ",",
  dateFormat: "iso",
  amountMode: "signed",
  signedConvention: "positive_is_income",
  columns: { ...noColumns, date: 0, description: 1, amount: 2 },
  defaultCategory: "Uncategorized",
  ...overrides,
});

const CSV = "Date,Description,Amount\n2026-03-05,Salary,85000.00\n2026-03-06,Coffee,-3.50\n2026-03-07,Rent,-15000\n";

async function withUser<T>(label: string, fn: (userId: string) => Promise<T>): Promise<T> {
  const user = await makeTestUser(label);
  try {
    return await fn(user.id);
  } finally {
    await deleteTestUser(user.id);
  }
}

async function counts(userId: string) {
  const [t, b] = await Promise.all([
    db.select({ id: transactions.id }).from(transactions).where(eq(transactions.userId, userId)),
    db.select({ id: importBatches.id }).from(importBatches).where(eq(importBatches.userId, userId)),
  ]);
  return { transactions: t.length, batches: b.length };
}

// --- preview ----------------------------------------------------------------

test("preview without a mapping describes the file and suggests, but does not apply, a mapping", async () => {
  await withUser("preview-plain", async (userId) => {
    const preview = await previewCsv(userId, upload(CSV));
    assert.equal(preview.filename, "statement.csv");
    assert.equal(preview.delimiter, ",");
    assert.deepEqual(preview.headers, ["Date", "Description", "Amount"]);
    assert.equal(preview.totalRows, 3);
    assert.equal(preview.sampleRows.length, 3);
    assert.deepEqual(preview.sampleRows[0], ["2026-03-05", "Salary", "85000.00"]);
    assert.deepEqual(preview.suggestion.columns, { date: 0, description: 1, amount: 2 });
    assert.equal(preview.suggestion.dateFormat, "iso", "a suggestion only because exactly one format fits");
    assert.deepEqual(preview.detectedDateFormats, ["iso"]);
    assert.equal(preview.mapping, null, "no rows are interpreted until a mapping is chosen");
  });
});

test("the delimiter is detected as a suggestion, and a semicolon file previews correctly", async () => {
  await withUser("preview-semicolon", async (userId) => {
    const preview = await previewCsv(userId, upload("Date;Narration;Amount\n05/03/2026;Salary;\"85,000.00\"\n"));
    assert.equal(preview.delimiter, ";");
    assert.deepEqual(preview.headers, ["Date", "Narration", "Amount"]);
    assert.deepEqual(preview.suggestion.columns, { date: 0, description: 1, amount: 2 });
  });
});

test("an ambiguous date format is NOT suggested: the user must choose", async () => {
  await withUser("preview-ambiguous", async (userId) => {
    const preview = await previewCsv(userId, upload("Date,Description,Amount\n05/03/2026,a,1\n07/08/2026,b,2\n"));
    assert.deepEqual([...preview.detectedDateFormats].sort(), ["dd/mm/yyyy", "mm/dd/yyyy"]);
    assert.equal(preview.suggestion.dateFormat, undefined);
  });
});

test("preview WRITES NOTHING, with or without a mapping", async () => {
  await withUser("preview-writes-nothing", async (userId) => {
    const before = await counts(userId);
    await previewCsv(userId, upload(CSV));
    const checked = await previewCsv(userId, upload(CSV), signed());
    assert.equal(checked.mapping?.status, "checked");
    await previewCsv(userId, upload("Date,Description,Amount\nbad,x,y\n"), signed()).catch(() => undefined);
    assert.deepEqual(await counts(userId), before);
    assert.deepEqual(before, { transactions: 0, batches: 0 });
  });
});

test("preview with a complete mapping validates every row and summarises in exact paise", async () => {
  await withUser("preview-checked", async (userId) => {
    const preview = await previewCsv(userId, upload(CSV), signed());
    assert.equal(preview.mapping?.status, "checked");
    if (preview.mapping?.status !== "checked") return;
    assert.equal(preview.mapping.valid, true);
    assert.equal(preview.mapping.errorCount, 0);
    assert.deepEqual(preview.mapping.summary, {
      rowCount: 3,
      incomeCount: 1,
      expenseCount: 2,
      incomeTotalPaise: 8_500_000,
      expenseTotalPaise: 1_500_350,
      defaultCategoryCount: 3,
    });
    assert.equal(preview.mapping.previewRows.length, 3);
    assert.deepEqual(preview.mapping.previewRows[1], {
      line: 3,
      occurredOn: "2026-03-06",
      type: "expense",
      amountPaise: 350,
      description: "Coffee",
      category: "Uncategorized",
      usedDefaultCategory: true,
    });
    assert.equal(preview.mapping.alreadyImportedCount, 0);
    assert.equal(preview.mapping.newRowCount, 3);
  });
});

test("an incomplete or ambiguous mapping is reported as problems, not guessed", async () => {
  await withUser("preview-incomplete", async (userId) => {
    const incomplete = await previewCsv(userId, upload(CSV), { ...signed(), signedConvention: undefined });
    assert.equal(incomplete.mapping?.status, "incomplete");
    if (incomplete.mapping?.status === "incomplete") assert.match(incomplete.mapping.problems.join(" "), /positive/i);
  });
});

test("preview reports every bad row with its line number and says the file is not valid", async () => {
  await withUser("preview-errors", async (userId) => {
    const csv = "Date,Description,Amount\n2026-03-05,ok,100\n2026-02-30,bad date,100\n2026-03-07,bad amount,abc\n";
    const preview = await previewCsv(userId, upload(csv), signed());
    assert.equal(preview.mapping?.status, "checked");
    if (preview.mapping?.status !== "checked") return;
    assert.equal(preview.mapping.valid, false);
    assert.deepEqual(preview.mapping.errors.map((e) => e.line), [3, 4]);
    assert.equal(preview.mapping.summary, null, "no summary is offered for a file that cannot be imported");
  });
});

test("preview tells you how many rows were already imported, after a commit", async () => {
  await withUser("preview-dupes", async (userId) => {
    await commitCsv(userId, upload(CSV), signed());
    const preview = await previewCsv(userId, upload(CSV), signed());
    if (preview.mapping?.status !== "checked") throw new Error("expected a checked mapping");
    assert.equal(preview.mapping.alreadyImportedCount, 3);
    assert.equal(preview.mapping.newRowCount, 0);
  });
});

// --- commit -----------------------------------------------------------------

test("commit imports the rows exactly, in one batch, and reports a summary", async () => {
  await withUser("commit", async (userId) => {
    const summary = await commitCsv(userId, upload(CSV, "March statement.csv"), signed({ defaultCategory: "Misc" }));

    assert.equal(summary.filename, "March statement.csv");
    assert.equal(summary.rowCount, 3);
    assert.equal(summary.insertedCount, 3);
    assert.equal(summary.skippedDuplicateCount, 0);
    assert.equal(summary.incomeTotalPaise, 8_500_000);
    assert.equal(summary.expenseTotalPaise, 1_500_350);

    const rows = (await listTransactions(userId)).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
    assert.deepEqual(
      rows.map((r) => [r.occurredOn, r.type, r.amountPaise, r.description, r.category, r.source, r.importBatchId]),
      [
        ["2026-03-05", "income", 8_500_000, "Salary", "Misc", "csv_import", summary.batchId],
        ["2026-03-06", "expense", 350, "Coffee", "Misc", "csv_import", summary.batchId],
        ["2026-03-07", "expense", 1_500_000, "Rent", "Misc", "csv_import", summary.batchId],
      ],
    );

    const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, summary.batchId));
    assert.equal(batch.userId, userId);
    assert.equal(batch.filename, "March statement.csv");
    assert.deepEqual([batch.rowCount, batch.insertedCount, batch.skippedDuplicateCount], [3, 3, 0]);
  });
});

test("commit does NOT trust the preview: it works without one, and validates whatever it is sent", async () => {
  await withUser("commit-revalidates", async (userId) => {
    // A file that "previewed fine" earlier and was then edited to contain a bad row.
    const edited = "Date,Description,Amount\n2026-03-05,ok,100\n2026-03-06,tampered,abc\n";
    await assert.rejects(
      () => commitCsv(userId, upload(edited), signed()),
      (e: unknown) => e instanceof UnprocessableContentError && e.code === "csv_validation_failed",
    );
    assert.deepEqual(await counts(userId), { transactions: 0, batches: 0 });

    // An invalid mapping is refused too, whatever a client claims to have checked.
    await assert.rejects(
      () => commitCsv(userId, upload(CSV), { ...signed(), dateFormat: "auto" }),
      (e: unknown) => e instanceof UnprocessableContentError && e.code === "csv_mapping_invalid",
    );
    assert.deepEqual(await counts(userId), { transactions: 0, batches: 0 });
  });
});

test("one bad row means ZERO rows are imported, and the errors say which lines to fix", async () => {
  await withUser("commit-atomic-validation", async (userId) => {
    const csv = "Date,Description,Amount\n2026-03-05,good one,100\n2026-03-06,good two,200\n2026-13-01,bad date,300\n2026-03-08,good three,400\n";
    await assert.rejects(
      () => commitCsv(userId, upload(csv), signed()),
      (e: unknown) => {
        assert.ok(e instanceof UnprocessableContentError);
        assert.equal(e.code, "csv_validation_failed");
        const details = e.details as { errorCount: number; errors: Array<{ line: number }> };
        assert.equal(details.errorCount, 1);
        assert.deepEqual(details.errors.map((x) => x.line), [4]);
        return true;
      },
    );
    assert.deepEqual(await counts(userId), { transactions: 0, batches: 0 });
  });
});

test("a database failure part-way through rolls back everything, including the batch", async () => {
  await withUser("commit-atomic-db", async (userId) => {
    // 1,001 rows fill one full insert chunk and start a second; the last row's
    // description holds a NUL byte, which Postgres refuses, failing the second chunk
    // after the first has already been inserted.
    const rows = Array.from({ length: 1_001 }, (_, i) => ({
      line: i + 2,
      occurredOn: "2026-03-05",
      type: "expense" as const,
      amountPaise: 100 + i,
      description: i === 1_000 ? "bad\u0000byte" : `row ${i}`,
      category: "Uncategorized",
      usedDefaultCategory: true,
    }));
    await assert.rejects(() => importRows(userId, "big.csv", fingerprintRows(rows)));
    assert.deepEqual(await counts(userId), { transactions: 0, batches: 0 }, "not even the first chunk survived");
  });
});

// --- duplicates ---------------------------------------------------------------

test("re-importing the same file adds zero rows and reports them as skipped", async () => {
  await withUser("reimport", async (userId) => {
    const first = await commitCsv(userId, upload(CSV), signed());
    assert.equal(first.insertedCount, 3);

    const second = await commitCsv(userId, upload(CSV), signed());
    assert.equal(second.rowCount, 3);
    assert.equal(second.insertedCount, 0);
    assert.equal(second.skippedDuplicateCount, 3);
    assert.equal(second.incomeTotalPaise, 0);
    assert.equal((await listTransactions(userId)).length, 3);

    const batches = await db.select().from(importBatches).where(eq(importBatches.userId, userId));
    assert.deepEqual(batches.map((b) => b.skippedDuplicateCount).sort(), [0, 3]);
  });
});

test("the same file with a different category default is still recognised as already imported", async () => {
  await withUser("reimport-category", async (userId) => {
    await commitCsv(userId, upload(CSV), signed({ defaultCategory: "Food" }));
    const again = await commitCsv(userId, upload(CSV), signed({ defaultCategory: "Misc" }));
    assert.equal(again.insertedCount, 0);
  });
});

test("identical-looking rows in ONE file are all kept, and survive a re-import as duplicates of themselves", async () => {
  await withUser("legit-repeats", async (userId) => {
    const repeats = "Date,Description,Amount\n2026-03-05,Coffee,-3.50\n2026-03-05,Coffee,-3.50\n2026-03-05,Coffee,-3.50\n";
    const first = await commitCsv(userId, upload(repeats), signed());
    assert.equal(first.insertedCount, 3);
    assert.equal((await listTransactions(userId)).length, 3);

    const again = await commitCsv(userId, upload(repeats), signed());
    assert.equal(again.insertedCount, 0);
    assert.equal(again.skippedDuplicateCount, 3);
  });
});

test("an appended row that looks like an existing one is treated as new, and only that row is added", async () => {
  await withUser("appended", async (userId) => {
    const two = "Date,Description,Amount\n2026-03-05,Coffee,-3.50\n2026-03-05,Coffee,-3.50\n";
    await commitCsv(userId, upload(two), signed());
    const three = `${two}2026-03-05,Coffee,-3.50\n`;
    const result = await commitCsv(userId, upload(three), signed());
    assert.equal(result.insertedCount, 1);
    assert.equal(result.skippedDuplicateCount, 2);
    assert.equal((await listTransactions(userId)).length, 3);
  });
});

test("manual transactions are never treated as duplicates of imported ones", async () => {
  await withUser("manual-vs-import", async (userId) => {
    const { createTransaction } = await import("../services/transactions");
    await createTransaction(userId, { type: "expense", amountPaise: 350, category: "Food", description: "Coffee", occurredOn: "2026-03-06" });
    const result = await commitCsv(userId, upload(CSV), signed());
    assert.equal(result.insertedCount, 3, "a hand-entered row with the same values does not block the import");
    assert.equal((await listTransactions(userId)).length, 4);
  });
});

// --- matched rows: visible, skipped by default, importable on request ------------
//
// A row whose fingerprint the user already has is MATCHED. It is never dropped
// silently: the preview lists it, a commit skips it unless its line is chosen
// and reports it either way, and a chosen row takes the next free occurrence
// slot so the unique index still guards every row.

const HEAD = "Date,Description,Amount\n";
const COFFEE = "2026-03-05,Coffee,-3.50\n";
const COFFEE_KEY = identityKey({ occurredOn: "2026-03-05", type: "expense", amountPaise: 350, description: "Coffee" });
const coffeeRow = (line: number) => ({ line, occurredOn: "2026-03-05", type: "expense", amountPaise: 350, description: "Coffee" });

async function storedFingerprints(userId: string): Promise<string[]> {
  const rows = await db.select({ fingerprint: transactions.importFingerprint }).from(transactions).where(eq(transactions.userId, userId));
  return rows.map((r) => r.fingerprint as string);
}

function checkedPreview(preview: Awaited<ReturnType<typeof previewCsv>>) {
  if (preview.mapping?.status !== "checked") throw new Error("expected a checked mapping");
  return preview.mapping;
}

test("preview lists every matched row with what identifies it, and writes nothing", async () => {
  await withUser("matched-preview", async (userId) => {
    await commitCsv(userId, upload(CSV), signed());
    const before = await counts(userId);

    const checked = checkedPreview(await previewCsv(userId, upload(CSV), signed()));
    assert.deepEqual(checked.matchedRows, [
      { line: 2, occurredOn: "2026-03-05", type: "income", amountPaise: 8_500_000, description: "Salary" },
      { line: 3, occurredOn: "2026-03-06", type: "expense", amountPaise: 350, description: "Coffee" },
      { line: 4, occurredOn: "2026-03-07", type: "expense", amountPaise: 1_500_000, description: "Rent" },
    ]);
    assert.equal(checked.alreadyImportedCount, 3);
    assert.equal(checked.newRowCount, 0);
    assert.deepEqual(await counts(userId), before, "preview is stateless and writes nothing");
  });
});

test("same file twice: matched rows are skipped by default, and every skipped row is reported", async () => {
  await withUser("matched-default", async (userId) => {
    await commitCsv(userId, upload(CSV), signed());
    const again = await commitCsv(userId, upload(CSV), signed());

    assert.equal(again.insertedCount, 0);
    assert.equal(again.forcedCount, 0);
    assert.equal(again.skippedDuplicateCount, 3);
    assert.deepEqual(again.skippedRows.map((r) => r.line), [2, 3, 4]);
    assert.deepEqual(again.skippedRows[1], { line: 3, occurredOn: "2026-03-06", type: "expense", amountPaise: 350, description: "Coffee" });
    assert.equal((await listTransactions(userId)).length, 3);
  });
});

test("a legitimate identical row is visible in the preview and is imported only when its line is chosen", async () => {
  await withUser("matched-choose", async (userId) => {
    await commitCsv(userId, upload(HEAD + COFFEE), signed());

    // A different file with the same coffee (say, another account) plus a genuinely new row.
    const other = HEAD + COFFEE + "2026-03-06,Books,-20\n";
    const checked = checkedPreview(await previewCsv(userId, upload(other), signed()));
    assert.deepEqual(checked.matchedRows, [coffeeRow(2)]);
    assert.equal(checked.newRowCount, 1);

    // Default: the matched row is skipped, the new row is imported, and the skip is reported.
    const byDefault = await commitCsv(userId, upload(other), signed());
    assert.deepEqual([byDefault.insertedCount, byDefault.forcedCount, byDefault.skippedDuplicateCount], [1, 0, 1]);
    assert.deepEqual(byDefault.skippedRows, [coffeeRow(2)]);
    assert.equal((await listTransactions(userId)).length, 2);

    // Chosen: the same matched row is imported anyway.
    const chosen = await commitCsv(userId, upload(HEAD + COFFEE), signed(), { includeLines: [2] });
    assert.deepEqual([chosen.insertedCount, chosen.forcedCount, chosen.skippedDuplicateCount], [1, 1, 0]);
    assert.deepEqual(chosen.skippedRows, []);
    assert.equal((await listTransactions(userId)).length, 3);

    // It took a real occurrence slot: the second Coffee, distinct from the first.
    const prints = await storedFingerprints(userId);
    assert.ok(prints.includes(fingerprintForSlot(COFFEE_KEY, 0)));
    assert.ok(prints.includes(fingerprintForSlot(COFFEE_KEY, 1)));
    assert.equal(new Set(prints).size, prints.length);

    // The batch record tells the truth.
    const batches = await db.select().from(importBatches).where(eq(importBatches.userId, userId));
    assert.ok(batches.some((b) => b.insertedCount === 1 && b.skippedDuplicateCount === 0 && b.rowCount === 1));
  });
});

test("two identical rows in one file stay distinct, and each can be chosen individually", async () => {
  await withUser("matched-repeats", async (userId) => {
    const three = HEAD + COFFEE + COFFEE + COFFEE; // lines 2, 3, 4
    const first = await commitCsv(userId, upload(three), signed());
    assert.equal(first.insertedCount, 3);
    assert.equal(new Set(await storedFingerprints(userId)).size, 3, "all three were kept, each with its own occurrence");

    const checked = checkedPreview(await previewCsv(userId, upload(three), signed()));
    assert.deepEqual(checked.matchedRows.map((r) => r.line), [2, 3, 4]);

    // Choose only the middle one.
    const again = await commitCsv(userId, upload(three), signed(), { includeLines: [3] });
    assert.deepEqual([again.insertedCount, again.forcedCount, again.skippedDuplicateCount], [1, 1, 2]);
    assert.deepEqual(again.skippedRows.map((r) => r.line), [2, 4]);

    const prints = await storedFingerprints(userId);
    assert.equal(prints.length, 4);
    assert.deepEqual(new Set(prints), new Set([0, 1, 2, 3].map((slot) => fingerprintForSlot(COFFEE_KEY, slot))));
  });
});

test("a chosen row avoids the slots the same file's new rows take", async () => {
  await withUser("matched-slots", async (userId) => {
    await commitCsv(userId, upload(HEAD + COFFEE), signed()); // slot 0

    // Three coffees: line 2 matches slot 0; lines 3 and 4 are new and take slots 1 and 2.
    const three = HEAD + COFFEE + COFFEE + COFFEE;
    const result = await commitCsv(userId, upload(three), signed(), { includeLines: [2] });
    assert.deepEqual([result.insertedCount, result.forcedCount, result.skippedDuplicateCount], [3, 1, 0]);

    const prints = await storedFingerprints(userId);
    assert.equal(prints.length, 4);
    assert.deepEqual(new Set(prints), new Set([0, 1, 2, 3].map((slot) => fingerprintForSlot(COFFEE_KEY, slot))));
  });
});

test("choosing a line that is not a matched row changes nothing, and malformed choices are refused", async () => {
  await withUser("matched-validate", async (userId) => {
    const ok = await commitCsv(userId, upload(CSV), signed(), { includeLines: [3, 999] });
    assert.deepEqual([ok.insertedCount, ok.forcedCount, ok.skippedDuplicateCount], [3, 0, 0]);
  });

  await withUser("matched-validate-bad", async (userId) => {
    const tooMany = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => i + 1);
    for (const bad of ["2", { 0: 2 }, [0], [-1], [1.5], ["2"], [null], tooMany]) {
      await assert.rejects(() => commitCsv(userId, upload(CSV), signed(), { includeLines: bad }), ValidationError, JSON.stringify(bad).slice(0, 40));
    }
    assert.deepEqual(await counts(userId), { transactions: 0, batches: 0 }, "a refused choice imports nothing");
  });
});

test("forced import stays race-safe: concurrent chosen imports each get their own slot and none is dropped", async () => {
  await withUser("matched-race", async (userId) => {
    await commitCsv(userId, upload(HEAD + COFFEE), signed()); // slot 0

    const runs = await Promise.all(
      Array.from({ length: 4 }, () => commitCsv(userId, upload(HEAD + COFFEE), signed(), { includeLines: [2] })),
    );

    // Every chosen row was imported, exactly once each.
    for (const run of runs) assert.deepEqual([run.insertedCount, run.forcedCount, run.skippedDuplicateCount], [1, 1, 0]);
    const prints = await storedFingerprints(userId);
    assert.equal(prints.length, 5);
    assert.deepEqual(new Set(prints), new Set([0, 1, 2, 3, 4].map((slot) => fingerprintForSlot(COFFEE_KEY, slot))));

    // The unique index still refuses a repeated fingerprint outright.
    await assert.rejects(
      () =>
        db.insert(transactions).values({
          userId,
          type: "expense",
          amountPaise: 350,
          category: "Food",
          occurredOn: "2026-03-05",
          importFingerprint: fingerprintForSlot(COFFEE_KEY, 0),
        }),
      (error: unknown) => isUniqueViolation(error),
    );
  });
});

test("concurrent default imports of the same file import it once and report the rest as skipped", async () => {
  await withUser("matched-race-default", async (userId) => {
    const runs = await Promise.all(Array.from({ length: 3 }, () => commitCsv(userId, upload(CSV), signed())));

    assert.equal(runs.reduce((sum, r) => sum + r.insertedCount, 0), 3, "each row is imported exactly once");
    assert.equal(runs.reduce((sum, r) => sum + r.skippedDuplicateCount, 0), 6, "and every other copy is reported as skipped");
    assert.equal((await listTransactions(userId)).length, 3);
  });
});

// --- ownership ----------------------------------------------------------------

test("two users may import the same file independently, and never see each other's rows", async () => {
  const userA = await makeTestUser("import-a");
  const userB = await makeTestUser("import-b");
  try {
    const a = await commitCsv(userA.id, upload(CSV), signed());
    const preview = await previewCsv(userB.id, upload(CSV), signed());
    if (preview.mapping?.status !== "checked") throw new Error("expected checked");
    assert.equal(preview.mapping.alreadyImportedCount, 0, "A's import is invisible to B");

    const b = await commitCsv(userB.id, upload(CSV), signed());
    assert.equal(a.insertedCount, 3);
    assert.equal(b.insertedCount, 3);
    assert.notEqual(a.batchId, b.batchId);
    assert.equal((await listTransactions(userA.id)).length, 3);
    assert.equal((await listTransactions(userB.id)).length, 3);
    assert.ok((await listTransactions(userA.id)).every((t) => t.userId === userA.id));
  } finally {
    await deleteTestUser(userA.id);
    await deleteTestUser(userB.id);
  }
});

test("an unauthenticated caller is refused before anything is read", async () => {
  for (const missing of ["", "  ", undefined as unknown as string]) {
    await assert.rejects(() => previewCsv(missing, upload(CSV)), NotAuthenticatedError);
    await assert.rejects(() => commitCsv(missing, upload(CSV), signed()), NotAuthenticatedError);
  }
});

// --- the three amount layouts, end to end ---------------------------------------

test("debit/credit files import with the debit as an expense and the credit as income, in exact paise", async () => {
  await withUser("debit-credit", async (userId) => {
    const csv = "Date,Particulars,Withdrawal,Deposit\n05-Mar-2026,Rent,15000.50,\n06-Mar-2026,Salary,,85000\n07-Mar-2026,Refund,0.00,19.99\n";
    const mapping: CsvMapping = {
      delimiter: ",",
      dateFormat: "dd-mmm-yyyy",
      amountMode: "debit_credit",
      columns: { ...noColumns, date: 0, description: 1, debit: 2, credit: 3 },
      defaultCategory: "Uncategorized",
    };
    const summary = await commitCsv(userId, upload(csv), mapping);
    assert.equal(summary.insertedCount, 3);
    const rows = (await listTransactions(userId)).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
    assert.deepEqual(rows.map((r) => [r.type, r.amountPaise, r.occurredOn]), [
      ["expense", 1_500_050, "2026-03-05"],
      ["income", 8_500_000, "2026-03-06"],
      ["income", 1_999, "2026-03-07"],
    ]);
  });
});

test("an explicit type column and a category column import as written, with the default only where blank", async () => {
  await withUser("typed", async (userId) => {
    const csv = "Date,Description,Amount,Type,Category\n2026-03-05,Pay,1000,Credit,Salary\n2026-03-06,Shop,250.75,Debit,\n";
    const mapping: CsvMapping = {
      delimiter: ",",
      dateFormat: "iso",
      amountMode: "amount_with_type",
      columns: { ...noColumns, date: 0, description: 1, amount: 2, type: 3, category: 4 },
      defaultCategory: "Uncategorized",
    };
    const summary = await commitCsv(userId, upload(csv), mapping);
    assert.equal(summary.defaultCategoryCount, 1);
    const rows = (await listTransactions(userId)).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
    assert.deepEqual(rows.map((r) => [r.type, r.amountPaise, r.category]), [
      ["income", 100_000, "Salary"],
      ["expense", 25_075, "Uncategorized"],
    ]);
  });
});

test("day-first dates import as day-first only when that format was explicitly chosen", async () => {
  await withUser("dmy", async (userId) => {
    const csv = "Date,Description,Amount\n05/03/2026,x,100\n";
    await commitCsv(userId, upload(csv), signed({ dateFormat: "dd/mm/yyyy" }));
    assert.equal((await listTransactions(userId))[0].occurredOn, "2026-03-05");
  });
});

// --- limits and unsupported files ------------------------------------------------

test("a file over the row limit is refused, and nothing is imported", async () => {
  await withUser("row-limit", async (userId) => {
    const body = Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `2026-03-05,row ${i},${i + 1}`).join("\n");
    const csv = `Date,Description,Amount\n${body}\n`;
    await assert.rejects(
      () => commitCsv(userId, upload(csv), signed()),
      (e: unknown) => e instanceof UnprocessableContentError && e.code === "csv_too_many_rows",
    );
    await assert.rejects(() => previewCsv(userId, upload(csv)), (e: unknown) => e instanceof UnprocessableContentError && e.code === "csv_too_many_rows");
    assert.deepEqual(await counts(userId), { transactions: 0, batches: 0 });
  });
});

test("a file with exactly the maximum number of rows imports", async () => {
  await withUser("row-limit-ok", async (userId) => {
    const body = Array.from({ length: MAX_CSV_ROWS }, (_, i) => `2026-03-05,row ${i},${i + 1}`).join("\n");
    const summary = await commitCsv(userId, upload(`Date,Description,Amount\n${body}\n`), signed());
    assert.equal(summary.insertedCount, MAX_CSV_ROWS);
  });
});

test("oversized, binary, non-UTF-8, empty and header-only files are all refused cleanly", async () => {
  await withUser("bad-files", async (userId) => {
    await assert.rejects(() => previewCsv(userId, { filename: "x.csv", declaredContentType: "text/csv", bytes: new Uint8Array(MAX_CSV_BYTES + 1).fill(97) }), PayloadTooLargeError);
    await assert.rejects(() => previewCsv(userId, { filename: "x.csv", declaredContentType: "text/csv", bytes: new Uint8Array([97, 44, 0, 98]) }), UnsupportedMediaTypeError);
    await assert.rejects(() => previewCsv(userId, { filename: "x.csv", declaredContentType: "text/csv", bytes: new Uint8Array([100, 0xe9, 44, 97]) }), UnsupportedMediaTypeError);
    await assert.rejects(() => previewCsv(userId, { filename: "x.csv", declaredContentType: "image/png", bytes: enc(CSV) }), UnsupportedMediaTypeError);
    await assert.rejects(() => previewCsv(userId, upload("")), ValidationError);
    await assert.rejects(
      () => commitCsv(userId, upload("Date,Description,Amount\n"), signed()),
      (e: unknown) => e instanceof UnprocessableContentError && e.code === "csv_empty",
    );
    // A malformed quote is reported with its line, not swallowed.
    await assert.rejects(
      () => previewCsv(userId, upload('Date,Description,Amount\n2026-03-05,"never closed,1\n')),
      (e: unknown) => e instanceof UnprocessableContentError && e.code === "csv_parse_error",
    );
    assert.deepEqual(await counts(userId), { transactions: 0, batches: 0 });
  });
});

test("nothing from the file reaches the console, even when it is rejected", async () => {
  await withUser("csv-quiet", async (userId) => {
    const calls: string[] = [];
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    for (const level of Object.keys(originals) as Array<keyof typeof originals>) {
      console[level] = (...args: unknown[]) => void calls.push(args.map(String).join(" "));
    }
    try {
      await commitCsv(userId, upload("Date,Description,Amount\n2026-03-05,SECRET-PAYEE,98765.43\n"), signed());
      await commitCsv(userId, upload("Date,Description,Amount\n2026-99-99,SECRET-PAYEE,98765.43\n"), signed()).catch(() => undefined);
      await previewCsv(userId, upload("Date,Description,Amount\n2026-03-05,\"SECRET-PAYEE,98765.43\n")).catch(() => undefined);
    } finally {
      Object.assign(console, originals);
    }
    assert.equal(calls.some((c) => /SECRET-PAYEE|98765/.test(c)), false, calls.join(" | "));
  });
});
