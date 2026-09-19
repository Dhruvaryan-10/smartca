// Strict date parsing tests. Pure — no database, session, or network.
//
// The old check (`Date.parse`) accepted "2026-02-30" and "garbage 1" and read
// "05/03/2026" as 3 May in Node while Postgres read it as 5 March. These tests
// pin the replacement: real calendar dates only, and an explicit format for
// anything that is not ISO.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DATE_FORMATS, detectDateFormats, isValidIsoDate, parseDateWithFormat, parseIsoDate } from "../lib/date-parse";

test("parseIsoDate accepts real ISO calendar dates", () => {
  for (const good of ["2026-03-05", "2025-04-01", "2026-03-31", "2024-02-29", "2000-02-29", "1999-12-31", "2100-01-01"]) {
    assert.equal(parseIsoDate(good), good, good);
  }
});

test("parseIsoDate rejects dates that do not exist", () => {
  const bad = [
    "2026-02-30", // the case Date.parse rolled over to 2 March
    "2026-02-29", // 2026 is not a leap year
    "1900-02-29", // 1900 is not a leap year (divisible by 100, not 400)
    "2026-04-31",
    "2026-06-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "2026-01-32",
  ];
  for (const s of bad) assert.equal(parseIsoDate(s), null, s);
});

test("parseIsoDate rejects anything that is not exactly YYYY-MM-DD", () => {
  const bad = [
    "", "   ", "garbage 1", "2026", "2026-3-5", "26-03-05", "2026/03/05", "05/03/2026", "2026-03-05T00:00:00Z",
    "2026-03-05 ", "March 5, 2026", "20260305", "2026-03-05junk", "+2026-03-05", "1899-12-31", "2101-01-01",
  ];
  for (const s of bad) assert.equal(parseIsoDate(s), null, JSON.stringify(s));
  for (const notString of [null, undefined, 20260305, {}, []]) assert.equal(parseIsoDate(notString as unknown as string), null);
});

test("isValidIsoDate mirrors parseIsoDate", () => {
  assert.equal(isValidIsoDate("2026-03-05"), true);
  assert.equal(isValidIsoDate("2026-02-30"), false);
});

test("day-first slash dates need the day-first format, and read as 5 March", () => {
  assert.deepEqual(parseDateWithFormat("05/03/2026", "dd/mm/yyyy"), { ok: true, iso: "2026-03-05" });
  assert.deepEqual(parseDateWithFormat("5/3/2026", "dd/mm/yyyy"), { ok: true, iso: "2026-03-05" });
  assert.deepEqual(parseDateWithFormat("31/03/2026", "dd/mm/yyyy"), { ok: true, iso: "2026-03-31" });
});

test("the same text reads differently under the month-first format, which is why the choice must be explicit", () => {
  assert.deepEqual(parseDateWithFormat("05/03/2026", "mm/dd/yyyy"), { ok: true, iso: "2026-05-03" });
  assert.equal(parseDateWithFormat("31/03/2026", "mm/dd/yyyy").ok, false);
});

test("other supported formats", () => {
  assert.deepEqual(parseDateWithFormat("2026-03-05", "iso"), { ok: true, iso: "2026-03-05" });
  assert.deepEqual(parseDateWithFormat("05-03-2026", "dd-mm-yyyy"), { ok: true, iso: "2026-03-05" });
  assert.deepEqual(parseDateWithFormat("05-Mar-2026", "dd-mmm-yyyy"), { ok: true, iso: "2026-03-05" });
  assert.deepEqual(parseDateWithFormat("5 mar 2026", "dd-mmm-yyyy"), { ok: true, iso: "2026-03-05" });
  assert.deepEqual(parseDateWithFormat("  05/03/2026  ", "dd/mm/yyyy"), { ok: true, iso: "2026-03-05" });
});

test("every format rejects impossible dates, garbage, wrong separators and two-digit years", () => {
  const cases: Array<[string, (typeof DATE_FORMATS)[number]["id"]]> = [
    ["30/02/2026", "dd/mm/yyyy"],
    ["29/02/2026", "dd/mm/yyyy"],
    ["05.03.2026", "dd/mm/yyyy"],
    ["05-03-2026", "dd/mm/yyyy"],
    ["05/03/26", "dd/mm/yyyy"],
    ["garbage 1", "dd/mm/yyyy"],
    ["", "dd/mm/yyyy"],
    ["31-Feb-2026", "dd-mmm-yyyy"],
    ["05-Mrz-2026", "dd-mmm-yyyy"],
    ["2026-02-30", "iso"],
    ["05/03/2026", "iso"],
    ["13/13/2026", "mm/dd/yyyy"],
    ["05-03-2026", "dd/mm/yyyy"],
  ];
  for (const [text, format] of cases) {
    const result = parseDateWithFormat(text, format);
    assert.equal(result.ok, false, `${JSON.stringify(text)} as ${format}`);
    if (!result.ok) assert.match(result.message, /\S/);
  }
});

test("detectDateFormats lists only the formats under which EVERY value parses", () => {
  assert.deepEqual(detectDateFormats(["2026-03-05", "2026-04-01"]), ["iso"]);
  // A day above 12 rules out month-first: unambiguous.
  assert.deepEqual(detectDateFormats(["31/03/2026", "05/04/2026"]), ["dd/mm/yyyy"]);
  // Every day is 12 or less: both readings fit, so the user has to choose.
  assert.deepEqual(detectDateFormats(["05/03/2026", "07/08/2026"]).sort(), ["dd/mm/yyyy", "mm/dd/yyyy"]);
  assert.deepEqual(detectDateFormats(["05-Mar-2026", "01-Apr-2026"]), ["dd-mmm-yyyy"]);
});

test("detectDateFormats ignores blank cells and finds nothing for mixed or invalid data", () => {
  assert.deepEqual(detectDateFormats(["2026-03-05", "", "  "]), ["iso"]);
  assert.deepEqual(detectDateFormats(["2026-03-05", "05/03/2026"]), []);
  assert.deepEqual(detectDateFormats(["garbage"]), []);
  assert.deepEqual(detectDateFormats([]), []);
  assert.deepEqual(detectDateFormats(["", " "]), []);
});

test("every advertised format has an id, a label and an example that parses under itself", () => {
  for (const format of DATE_FORMATS) {
    assert.ok(format.id && format.label && format.example);
    assert.equal(parseDateWithFormat(format.example, format.id).ok, true, format.id);
  }
});
