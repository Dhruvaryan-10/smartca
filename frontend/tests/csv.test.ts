// CSV parser tests. Pure — no database, session, or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDelimiter, parseCsv } from "../lib/csv";

function fields(text: string, options?: Parameters<typeof parseCsv>[1]): string[][] {
  const result = parseCsv(text, options);
  assert.equal(result.ok, true, `expected ${JSON.stringify(text)} to parse, got ${JSON.stringify(result)}`);
  return result.ok ? result.records.map((r) => r.fields) : [];
}

test("parses plain rows and does not create an empty record for the trailing newline", () => {
  assert.deepEqual(fields("a,b,c\n1,2,3\n"), [["a", "b", "c"], ["1", "2", "3"]]);
  assert.deepEqual(fields("a,b,c\n1,2,3"), [["a", "b", "c"], ["1", "2", "3"]]);
});

test("handles CRLF, LF and lone CR line endings", () => {
  assert.deepEqual(fields("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(fields("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(fields("a,b\r1,2\r"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(fields("a,b\r\n1,2\n3,4\r5,6"), [["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
});

test("strips a UTF-8 byte-order mark", () => {
  assert.deepEqual(fields("﻿date,amount\n2026-03-05,100"), [["date", "amount"], ["2026-03-05", "100"]]);
});

test("quoted fields may contain the delimiter", () => {
  assert.deepEqual(fields('date,"Smith, John",100\n'), [["date", "Smith, John", "100"]]);
  assert.deepEqual(fields('"1,50,000.50",x'), [["1,50,000.50", "x"]]);
});

test("doubled quotes inside a quoted field are a literal quote", () => {
  assert.deepEqual(fields('"He said ""hi""",b'), [['He said "hi"', "b"]]);
  assert.deepEqual(fields('""""'), [['"']]);
  assert.deepEqual(fields('a,"",c'), [["a", "", "c"]]);
});

test("quoted fields may contain newlines, kept exactly as written", () => {
  assert.deepEqual(fields('a,"line one\nline two",c\n1,2,3'), [["a", "line one\nline two", "c"], ["1", "2", "3"]]);
  assert.deepEqual(fields('a,"one\r\ntwo",c'), [["a", "one\r\ntwo", "c"]]);
});

test("records report the physical line they start on, including after multi-line fields", () => {
  const result = parseCsv('h1,h2\n"a\nb",1\nx,2\n');
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.records.map((r) => r.line), [1, 2, 4]);
});

test("blank lines are skipped, but do not disturb line numbers", () => {
  const result = parseCsv("a,b\n\n1,2\n   \n3,4\n");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.records.map((r) => r.fields), [["a", "b"], ["1", "2"], ["   "], ["3", "4"]]);
    assert.deepEqual(result.records.map((r) => r.line), [1, 3, 4, 5]);
  }
});

test("ragged rows come back exactly as they are, for the caller to validate", () => {
  assert.deepEqual(fields("a,b,c\n1,2\n1,2,3,4\n,,\n"), [["a", "b", "c"], ["1", "2"], ["1", "2", "3", "4"], ["", "", ""]]);
});

test("empty fields and whitespace are preserved, not trimmed", () => {
  assert.deepEqual(fields(" a , ,c\n"), [[" a ", " ", "c"]]);
  assert.deepEqual(fields(",\n"), [["", ""]]);
});

test("empty input has no records", () => {
  assert.deepEqual(fields(""), []);
  assert.deepEqual(fields("\n\n"), []);
  assert.deepEqual(fields("﻿"), []);
});

test("supports semicolon, tab and pipe delimiters, and a comma is then ordinary text", () => {
  assert.deepEqual(fields("a;b;c\n1,5;2;3", { delimiter: ";" }), [["a", "b", "c"], ["1,5", "2", "3"]]);
  assert.deepEqual(fields("a\tb\n1\t2", { delimiter: "\t" }), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(fields("a|b\n1|2", { delimiter: "|" }), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(fields('a;"b;c";d', { delimiter: ";" }), [["a", "b;c", "d"]]);
});

test("an unterminated quoted field is an error that names the line it started on", () => {
  const result = parseCsv('a,b\n1,"never closed\n2,3\n');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "unterminated_quote");
    assert.equal(result.line, 2);
    assert.match(result.message, /quote/i);
  }
});

test("text after a closing quote is an error rather than being silently glued on", () => {
  const result = parseCsv('a,"b"c,d\n');
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.kind, "unexpected_quote");
    assert.equal(result.line, 1);
  }
});

test("a quote in the middle of an unquoted field is kept literally", () => {
  assert.deepEqual(fields('5" pipe,b\n'), [['5" pipe', "b"]]);
});

test("enforces a maximum number of records, counting the header", () => {
  const rows = ["h", ...Array.from({ length: 5 }, (_, i) => String(i))].join("\n");
  assert.equal(parseCsv(rows, { maxRecords: 6 }).ok, true);
  const over = parseCsv(rows, { maxRecords: 5 });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.kind, "too_many_records");
});

test("detectDelimiter suggests the delimiter that appears consistently across lines", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3\n4,5,6"), ",");
  assert.equal(detectDelimiter("a;b;c\n1;2;3\n4;5;6"), ";");
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(detectDelimiter("a|b|c\n1|2|3"), "|");
});

test("detectDelimiter ignores delimiters inside quotes and falls back to a comma", () => {
  assert.equal(detectDelimiter('"a;b;c",d\n"1;2;3",4'), ",");
  assert.equal(detectDelimiter("just one column\nno separators"), ",");
  assert.equal(detectDelimiter(""), ",");
  assert.equal(detectDelimiter("﻿a;b\n1;2"), ";");
});
