// CSV import logic tests. Pure — no database, session, or network.
//
// Expected values are written out by hand. The rules under test:
//   - amounts are exact integer paise (no floating point);
//   - nothing is guessed: how amounts map to income/expense, the date format
//     and the category default are all explicit choices;
//   - one bad row means the whole file is not importable;
//   - duplicate detection is deterministic and keeps legitimate repeats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseCsv } from "../lib/csv";
import {
  DEFAULT_CATEGORY,
  fingerprintForSlot,
  fingerprintRows,
  identityKey,
  suggestMapping,
  summarizeRows,
  validateCsvRows,
  validateMapping,
} from "../lib/csv-import";
import type { CsvMapping } from "../lib/csv-import";

const noColumns = { date: null, description: null, category: null, amount: null, debit: null, credit: null, type: null };

function signedMapping(overrides: Partial<CsvMapping> = {}): CsvMapping {
  return {
    delimiter: ",",
    dateFormat: "iso",
    amountMode: "signed",
    signedConvention: "positive_is_income",
    columns: { ...noColumns, date: 0, description: 1, amount: 2 },
    defaultCategory: "Uncategorized",
    ...overrides,
  };
}

function records(text: string) {
  const parsed = parseCsv(text);
  assert.equal(parsed.ok, true);
  return parsed.ok ? parsed.records : [];
}

function validate(text: string, mapping: CsvMapping) {
  return validateCsvRows(records(text), mapping);
}

const HEADER = "Date,Description,Amount\n";

// --- amounts: exact paise, signed ---------------------------------------

test("signed amounts are converted to exact paise, including values floating point gets wrong", () => {
  const cases: Array<[string, number]> = [
    ["1234.56", 123_456],
    ["1,234.56", 123_456],
    ["₹1,50,000.50", 15_000_050],
    ["0.29", 29],
    ["19.99", 1_999],
    ["4.35", 435],
    ["1.15", 115],
    ["100", 10_000],
    ["100.5", 10_050],
  ];
  for (const [cell, paise] of cases) {
    // A cell with a comma is quoted in a real export.
    const csvCell = cell.includes(",") ? `"${cell}"` : cell;
    const result = validate(`${HEADER}2026-03-05,x,${csvCell}\n`, signedMapping());
    assert.equal(result.errors.length, 0, cell);
    assert.equal(result.rows[0].amountPaise, paise, cell);
  }
});

test("a signed amount's sign is written many ways; all read the same", () => {
  for (const negative of ["-100", "−100", "(100.00)", "-₹100", "- 100"]) {
    const row = validate(`${HEADER}2026-03-05,x,${negative}\n`, signedMapping()).rows[0];
    assert.equal(row.type, "expense", negative);
    assert.equal(row.amountPaise, 10_000, negative);
  }
  for (const positive of ["100", "+100", "₹100.00"]) {
    const row = validate(`${HEADER}2026-03-05,x,${positive}\n`, signedMapping()).rows[0];
    assert.equal(row.type, "income", positive);
    assert.equal(row.amountPaise, 10_000, positive);
  }
});

test("the meaning of a positive amount is the explicit convention, in both directions", () => {
  const csv = `${HEADER}2026-03-05,in,100\n2026-03-06,out,-40\n`;
  const incomeFirst = validate(csv, signedMapping({ signedConvention: "positive_is_income" })).rows;
  assert.deepEqual(incomeFirst.map((r) => r.type), ["income", "expense"]);
  const expenseFirst = validate(csv, signedMapping({ signedConvention: "positive_is_expense" })).rows;
  assert.deepEqual(expenseFirst.map((r) => r.type), ["expense", "income"]);
  assert.deepEqual(expenseFirst.map((r) => r.amountPaise), [10_000, 4_000]);
});

test("unreadable, over-precise, oversized, empty or zero amounts are row errors, never guesses", () => {
  const bad = ["abc", "1.234", "12abc", "", "0", "0.00", "1e5", "99999999999999999"];
  for (const cell of bad) {
    const result = validate(`${HEADER}2026-03-05,x,${cell}\n`, signedMapping());
    assert.equal(result.rows.length, 0, JSON.stringify(cell));
    assert.equal(result.errors.length >= 1, true, JSON.stringify(cell));
    assert.equal(result.errors[0].line, 2);
  }
});

// --- amounts: debit / credit ------------------------------------------

function debitCreditMapping(): CsvMapping {
  return {
    delimiter: ",",
    dateFormat: "iso",
    amountMode: "debit_credit",
    columns: { ...noColumns, date: 0, description: 1, debit: 2, credit: 3 },
    defaultCategory: "Uncategorized",
  };
}
const DC_HEADER = "Date,Description,Debit,Credit\n";

test("debit/credit: a debit is an expense and a credit is income, in exact paise", () => {
  const result = validate(`${DC_HEADER}2026-03-05,rent,15000.50,\n2026-03-06,salary,,85000\n2026-03-07,refund,0.00,12.34\n`, debitCreditMapping());
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.rows.map((r) => [r.type, r.amountPaise]), [
    ["expense", 1_500_050],
    ["income", 8_500_000],
    ["income", 1_234],
  ]);
});

test("debit/credit: both filled, neither filled, or a negative are errors", () => {
  for (const row of ["2026-03-05,x,100,200", "2026-03-05,x,,", "2026-03-05,x,0,0", "2026-03-05,x,-100,", "2026-03-05,x,,-100", "2026-03-05,x,abc,"]) {
    const result = validate(`${DC_HEADER}${row}\n`, debitCreditMapping());
    assert.equal(result.rows.length, 0, row);
    assert.equal(result.errors.length >= 1, true, row);
  }
});

// --- amounts: explicit type column -------------------------------------

function typedMapping(): CsvMapping {
  return {
    delimiter: ",",
    dateFormat: "iso",
    amountMode: "amount_with_type",
    columns: { ...noColumns, date: 0, description: 1, amount: 2, type: 3 },
    defaultCategory: "Uncategorized",
  };
}
const TYPED_HEADER = "Date,Description,Amount,Type\n";

test("explicit type column: only the documented words are understood, case-insensitively", () => {
  const csv = `${TYPED_HEADER}2026-03-05,a,100,Income\n2026-03-05,b,100,CREDIT\n2026-03-05,c,100,cr\n2026-03-05,d,100,expense\n2026-03-05,e,100,Debit\n2026-03-05,f,100,dr\n`;
  const result = validate(csv, typedMapping());
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.rows.map((r) => r.type), ["income", "income", "income", "expense", "expense", "expense"]);
});

test("explicit type column: unknown words, blank types and signed amounts are errors, never guesses", () => {
  for (const row of ["2026-03-05,x,100,transfer", "2026-03-05,x,100,", "2026-03-05,x,-100,debit", "2026-03-05,x,0,debit", "2026-03-05,x,abc,debit"]) {
    const result = validate(`${TYPED_HEADER}${row}\n`, typedMapping());
    assert.equal(result.rows.length, 0, row);
    assert.equal(result.errors.length >= 1, true, row);
  }
});

// --- dates, category, description -----------------------------------------

test("dates use only the explicitly chosen format", () => {
  const dayFirst = validate(`${HEADER}05/03/2026,x,100\n`, signedMapping({ dateFormat: "dd/mm/yyyy" }));
  assert.equal(dayFirst.rows[0].occurredOn, "2026-03-05");
  const monthFirst = validate(`${HEADER}05/03/2026,x,100\n`, signedMapping({ dateFormat: "mm/dd/yyyy" }));
  assert.equal(monthFirst.rows[0].occurredOn, "2026-05-03");
  // ISO is not silently accepted when another format was chosen.
  const mismatch = validate(`${HEADER}2026-03-05,x,100\n`, signedMapping({ dateFormat: "dd/mm/yyyy" }));
  assert.equal(mismatch.rows.length, 0);
  assert.match(mismatch.errors[0].message, /date/i);
});

test("impossible or missing dates are row errors that name the line", () => {
  for (const cell of ["2026-02-30", "garbage 1", "", "2026-13-01"]) {
    const result = validate(`${HEADER}2026-03-05,ok,1\n${cell},bad,100\n`, signedMapping());
    assert.equal(result.errors.length, 1, JSON.stringify(cell));
    assert.equal(result.errors[0].line, 3, JSON.stringify(cell));
    assert.equal(result.errors[0].column, "Date");
  }
});

test("a missing category uses the visible default and is flagged; a present one is kept as written", () => {
  const mapping = signedMapping({ columns: { ...noColumns, date: 0, description: 1, amount: 2, category: 3 }, defaultCategory: "Misc" });
  const result = validate("Date,Description,Amount,Category\n2026-03-05,a,100,Groceries\n2026-03-06,b,100,\n2026-03-07,c,100,   \n", mapping);
  assert.deepEqual(result.rows.map((r) => [r.category, r.usedDefaultCategory]), [
    ["Groceries", false],
    ["Misc", true],
    ["Misc", true],
  ]);
  // With no category column at all, every row uses the default.
  const noColumn = validate(`${HEADER}2026-03-05,a,100\n`, signedMapping({ defaultCategory: "Misc" }));
  assert.deepEqual([noColumn.rows[0].category, noColumn.rows[0].usedDefaultCategory], ["Misc", true]);
});

test("descriptions are kept exactly (trimmed), blank ones are null, and over-long text is an error rather than truncated", () => {
  const ok = validate(`${HEADER}2026-03-05,"  Coffee, shop  ",100\n`, signedMapping());
  assert.equal(ok.rows[0].description, "Coffee, shop");
  const blank = validate(`${HEADER}2026-03-05,,100\n`, signedMapping());
  assert.equal(blank.rows[0].description, null);
  const long = validate(`${HEADER}2026-03-05,${"x".repeat(501)},100\n`, signedMapping());
  assert.equal(long.rows.length, 0);
  assert.equal(long.errors[0].column, "Description");
});

// --- whole-file behaviour -----------------------------------------------

test("ragged rows are errors that say what was expected", () => {
  const result = validate(`${HEADER}2026-03-05,x,100\n2026-03-06,short\n2026-03-07,a,1,extra\n`, signedMapping());
  assert.equal(result.errors.length, 2);
  assert.deepEqual(result.errors.map((e) => e.line), [3, 4]);
  assert.match(result.errors[0].message, /3 columns/);
});

test("every bad row is reported, with its own line number, so the whole file can be fixed at once", () => {
  const csv = `${HEADER}2026-03-05,ok,100\n2026-02-30,bad date,100\n2026-03-07,bad amount,abc\n2026-03-08,ok,5\n`;
  const result = validate(csv, signedMapping());
  assert.deepEqual(result.errors.map((e) => e.line), [3, 4]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.errorCount, 2);
});

test("error output is capped but the true count is kept", () => {
  const body = Array.from({ length: 250 }, () => "garbage,x,abc").join("\n");
  const result = validate(`${HEADER}${body}\n`, signedMapping());
  assert.equal(result.errorCount >= 250, true);
  assert.equal(result.errors.length, 100);
});

test("a file with a header and no data rows has nothing to import", () => {
  const result = validate(HEADER, signedMapping());
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.dataRowCount, 0);
});

test("summarizeRows counts and totals in exact paise", () => {
  const rows = validate(`${HEADER}2026-03-05,a,100.10\n2026-03-06,b,-40.05\n2026-03-07,c,0.10\n`, signedMapping()).rows;
  assert.deepEqual(summarizeRows(rows), {
    rowCount: 3,
    incomeCount: 2,
    expenseCount: 1,
    incomeTotalPaise: 10_020,
    expenseTotalPaise: 4_005,
    defaultCategoryCount: 3,
  });
});

// --- mapping validation --------------------------------------------------

test("validateMapping accepts a complete mapping and returns it normalised", () => {
  const result = validateMapping({ ...signedMapping(), defaultCategory: "  Uncategorized  ", extra: "ignored" }, 3);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.mapping.defaultCategory, "Uncategorized");
    assert.equal("extra" in result.mapping, false);
  }
});

test("validateMapping blocks anything missing or ambiguous, one clear problem at a time", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["not an object", "x", /mapping/i],
    ["no date column", { ...signedMapping(), columns: { ...noColumns, amount: 2 } }, /date/i],
    ["signed without a convention", { ...signedMapping(), signedConvention: undefined }, /positive/i],
    ["signed without an amount column", { ...signedMapping(), columns: { ...noColumns, date: 0 } }, /amount/i],
    ["debit/credit missing credit", { ...debitCreditMapping(), columns: { ...noColumns, date: 0, debit: 2 } }, /credit/i],
    ["typed without a type column", { ...typedMapping(), columns: { ...noColumns, date: 0, amount: 2 } }, /type/i],
    ["unknown amount mode", { ...signedMapping(), amountMode: "guess" }, /amount/i],
    ["unknown date format", { ...signedMapping(), dateFormat: "auto" }, /date format/i],
    ["missing date format", { ...signedMapping(), dateFormat: undefined }, /date format/i],
    ["bad delimiter", { ...signedMapping(), delimiter: "x" }, /delimiter/i],
    ["blank default category", { ...signedMapping(), defaultCategory: "   " }, /category/i],
    ["over-long default category", { ...signedMapping(), defaultCategory: "x".repeat(101) }, /category/i],
    ["column out of range", { ...signedMapping(), columns: { ...noColumns, date: 0, amount: 9 } }, /column/i],
    ["negative column", { ...signedMapping(), columns: { ...noColumns, date: -1, amount: 2 } }, /column/i],
    ["fractional column", { ...signedMapping(), columns: { ...noColumns, date: 0.5, amount: 2 } }, /column/i],
    ["one column used twice", { ...signedMapping(), columns: { ...noColumns, date: 0, amount: 0 } }, /once|twice|same/i],
  ];
  for (const [name, mapping, message] of cases) {
    const result = validateMapping(mapping, 3);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.match(result.problems.join(" "), message, name);
  }
});

test("DEFAULT_CATEGORY is the suggested default the UI shows, not one applied silently", () => {
  assert.equal(DEFAULT_CATEGORY, "Uncategorized");
});

// --- suggestions ----------------------------------------------------------

test("suggestMapping proposes a column only when exactly one header fits, and never a meaning for signed amounts", () => {
  const s = suggestMapping(["Txn Date", "Narration", "Amount", "Type"]);
  assert.equal(s.columns.date, 0);
  assert.equal(s.columns.description, 1);
  assert.equal(s.columns.amount, 2);
  assert.equal(s.columns.type, 3);
  assert.equal(s.amountMode, undefined, "amount vs amount+type is the user's call");
  assert.equal("signedConvention" in s, false);
});

test("suggestMapping recognises a debit/credit layout", () => {
  const s = suggestMapping(["Date", "Particulars", "Withdrawal Amt", "Deposit Amt", "Balance"]);
  assert.deepEqual([s.columns.date, s.columns.description, s.columns.debit, s.columns.credit], [0, 1, 2, 3]);
  assert.equal(s.amountMode, "debit_credit");
});

test("suggestMapping stays silent when headers are ambiguous or unrecognised", () => {
  const twoDates = suggestMapping(["Date", "Value Date", "Amount"]);
  assert.equal(twoDates.columns.date, undefined);
  const unknown = suggestMapping(["col1", "col2", "col3"]);
  assert.deepEqual(unknown.columns, {});
  assert.equal(suggestMapping([]).amountMode, undefined);
});

// --- fingerprints --------------------------------------------------------

function fp(csv: string) {
  return fingerprintRows(validate(csv, signedMapping()).rows).map((r) => r.fingerprint);
}

test("fingerprints are deterministic: the same file always produces the same ones", () => {
  const csv = `${HEADER}2026-03-05,coffee,-3.50\n2026-03-06,salary,1000\n`;
  assert.deepEqual(fp(csv), fp(csv));
  assert.equal(fp(csv).every((f) => /^[0-9a-f]{64}$/.test(f)), true);
});

test("identical-looking rows within one file get DIFFERENT fingerprints, so legitimate repeats are all kept", () => {
  const csv = `${HEADER}2026-03-05,coffee,-3.50\n2026-03-05,coffee,-3.50\n2026-03-05,coffee,-3.50\n`;
  const prints = fp(csv);
  assert.equal(new Set(prints).size, 3);
});

test("re-importing the same file matches row for row, and an appended identical row is treated as new", () => {
  const two = `${HEADER}2026-03-05,coffee,-3.50\n2026-03-05,coffee,-3.50\n`;
  const three = `${two}2026-03-05,coffee,-3.50\n`;
  const [a, b] = fp(two);
  const [x, y, z] = fp(three);
  assert.deepEqual([a, b], [x, y]);
  assert.notEqual(z, x);
  assert.notEqual(z, y);
});

test("any difference in date, type, amount or description changes the fingerprint", () => {
  const base = fp(`${HEADER}2026-03-05,coffee,-3.50\n`)[0];
  for (const variant of [
    "2026-03-06,coffee,-3.50",
    "2026-03-05,coffee,3.50",
    "2026-03-05,coffee,-3.51",
    "2026-03-05,tea,-3.50",
  ]) {
    assert.notEqual(fp(`${HEADER}${variant}\n`)[0], base, variant);
  }
});

test("description case and spacing do not change the fingerprint, and the category never does", () => {
  const base = fp(`${HEADER}2026-03-05,Coffee Shop,-3.50\n`)[0];
  assert.equal(fp(`${HEADER}2026-03-05,  coffee   SHOP ,-3.50\n`)[0], base);
  const withCategory = (defaultCategory: string) =>
    fingerprintRows(validate(`${HEADER}2026-03-05,Coffee Shop,-3.50\n`, signedMapping({ defaultCategory })).rows)[0].fingerprint;
  assert.equal(withCategory("Food"), withCategory("Misc"));
});

test("the fingerprint does not depend on how the file was formatted", () => {
  const isoRows = fp(`${HEADER}2026-03-05,coffee,-3.50\n`);
  const dmy = fingerprintRows(validate("Date,Description,Amount\n05/03/2026,coffee,\"-3.50\"\r\n", signedMapping({ dateFormat: "dd/mm/yyyy" })).rows).map((r) => r.fingerprint);
  assert.deepEqual(dmy, isoRows);
});

// An override takes the next free occurrence SLOT for its identity (see
// services/imports.ts). That only works, and already-imported rows only keep
// matching, if a slot's fingerprint is exactly what a file row of that
// occurrence has always had.
test("a file row's fingerprint is its identity's fingerprint for its occurrence slot, and the recipe is pinned", () => {
  const rows = validate(`${HEADER}2026-03-05,Coffee Shop,-3.50\n2026-03-05,coffee   shop,-3.50\n`, signedMapping()).rows;
  const prints = fingerprintRows(rows).map((r) => r.fingerprint);
  const key = identityKey(rows[0]);

  assert.equal(key, "2026-03-05|expense|350|coffee shop");
  assert.equal(identityKey(rows[1]), key, "case and spacing are not part of the identity");
  assert.deepEqual(prints, [fingerprintForSlot(key, 0), fingerprintForSlot(key, 1)]);
  // Pinned to the original recipe: changing it would stop matching every row already imported.
  assert.equal(prints[0], createHash("sha256").update("csv-v1|2026-03-05|expense|350|coffee shop|0").digest("hex"));
  assert.equal(prints[1], createHash("sha256").update("csv-v1|2026-03-05|expense|350|coffee shop|1").digest("hex"));
  assert.notEqual(fingerprintForSlot(key, 2), fingerprintForSlot(key, 1));
});
