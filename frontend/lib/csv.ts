// A small RFC-4180 CSV parser: quoted fields, delimiters and newlines inside
// quotes, doubled quotes, a UTF-8 BOM, and CRLF / LF / lone-CR line endings.
// It only splits text into fields. It does not trim, interpret or validate
// values; that is the caller's job (lib/csv-import.ts). Ragged rows are
// returned as they are.
//
// Pure: no I/O, no framework imports.

export type CsvDelimiter = "," | ";" | "\t" | "|";

export type CsvRecord = {
  /** 1-based physical line the record starts on (a quoted field can span several lines). */
  line: number;
  fields: string[];
};

export type CsvParseFailure = {
  ok: false;
  kind: "unterminated_quote" | "unexpected_quote" | "too_many_records";
  line: number;
  message: string;
};

export type CsvParseResult = { ok: true; records: CsvRecord[] } | CsvParseFailure;

export type CsvParseOptions = {
  delimiter?: CsvDelimiter;
  /** Most records allowed, counting the header. Parsing stops with `too_many_records` beyond it. */
  maxRecords?: number;
};

const BOM = "﻿";

export function parseCsv(input: string, options: CsvParseOptions = {}): CsvParseResult {
  const delimiter = options.delimiter ?? ",";
  const maxRecords = options.maxRecords ?? Number.POSITIVE_INFINITY;
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const length = text.length;

  const records: CsvRecord[] = [];
  let i = 0;
  let line = 1;

  while (i < length) {
    const recordLine = line;
    const recordStart = i;
    const fields: string[] = [];

    // Read every field of one record.
    for (;;) {
      let value = "";

      if (text[i] === '"') {
        i++; // opening quote
        for (;;) {
          if (i >= length) {
            return { ok: false, kind: "unterminated_quote", line: recordLine, message: `A quoted value that starts on line ${recordLine} is never closed.` };
          }
          const c = text[i];
          if (c === '"') {
            if (text[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i++; // closing quote
            break;
          }
          if (c === "\r") {
            if (text[i + 1] === "\n") {
              value += "\r\n";
              i += 2;
            } else {
              value += c;
              i++;
            }
            line++;
            continue;
          }
          if (c === "\n") line++;
          value += c;
          i++;
        }
        // After a closing quote only a delimiter, a line break or the end may follow.
        const next = text[i];
        if (next !== undefined && next !== delimiter && next !== "\n" && next !== "\r") {
          return { ok: false, kind: "unexpected_quote", line, message: `Unexpected text after a closing quote on line ${line}.` };
        }
      } else {
        const start = i;
        while (i < length && text[i] !== delimiter && text[i] !== "\n" && text[i] !== "\r") i++;
        value = text.slice(start, i);
      }

      fields.push(value);

      if (i >= length) break;
      const c = text[i];
      if (c === delimiter) {
        i++;
        continue;
      }
      // Line break: end of record.
      if (c === "\r" && text[i + 1] === "\n") i += 2;
      else i++;
      line++;
      break;
    }

    // A line with no characters at all is a blank line, not a record.
    const isBlankLine = fields.length === 1 && fields[0] === "" && !text.slice(recordStart, i).replace(/[\r\n]/g, "");
    if (isBlankLine) continue;

    records.push({ line: recordLine, fields });
    if (records.length > maxRecords) {
      return { ok: false, kind: "too_many_records", line: recordLine, message: `The file has more than ${maxRecords} rows.` };
    }
  }

  return { ok: true, records };
}

const CANDIDATE_DELIMITERS: CsvDelimiter[] = [",", ";", "\t", "|"];

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let count = 0;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === delimiter && !inQuotes) count++;
  }
  return count;
}

/**
 * A SUGGESTION only: the delimiter that appears the same, non-zero number of
 * times on each of the first few lines. Falls back to a comma. The import
 * flow still shows it for the person to confirm.
 */
export function detectDelimiter(input: string): CsvDelimiter {
  const text = input.startsWith(BOM) ? input.slice(1) : input;
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "").slice(0, 5);
  if (lines.length === 0) return ",";

  let best: CsvDelimiter = ",";
  let bestScore = 0;
  for (const delimiter of CANDIDATE_DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, delimiter));
    const consistent = counts[0] > 0 && counts.every((c) => c === counts[0]);
    // Consistency across lines dominates; otherwise fall back to raw frequency.
    const score = consistent ? 1000 + counts[0] : counts.reduce((a, b) => a + b, 0);
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}
