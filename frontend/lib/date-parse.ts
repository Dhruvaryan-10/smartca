// Strict calendar-date parsing. Deliberately does NOT use `Date.parse` or
// `new Date(string)`: those accept nonsense ("garbage 1"), roll impossible
// days over ("2026-02-30" becomes 2 March), and read "05/03/2026" as 3 May in
// Node while Postgres reads it as 5 March. Dates here are calendar dates with
// no time zone, so they are handled as year/month/day integers and returned
// as "YYYY-MM-DD".
//
// ISO is always understood. Every other format must be chosen explicitly by
// the person importing the file, because "05/03/2026" is genuinely ambiguous.

export type DateFormatId = "iso" | "dd/mm/yyyy" | "dd-mm-yyyy" | "dd-mmm-yyyy" | "mm/dd/yyyy";

export const DATE_FORMATS: ReadonlyArray<{ id: DateFormatId; label: string; example: string }> = [
  { id: "iso", label: "YYYY-MM-DD", example: "2026-03-05" },
  { id: "dd/mm/yyyy", label: "DD/MM/YYYY (day first)", example: "05/03/2026" },
  { id: "dd-mm-yyyy", label: "DD-MM-YYYY (day first)", example: "05-03-2026" },
  { id: "dd-mmm-yyyy", label: "DD-Mon-YYYY", example: "05-Mar-2026" },
  { id: "mm/dd/yyyy", label: "MM/DD/YYYY (month first)", example: "03/05/2026" },
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/** Build "YYYY-MM-DD" if the parts form a real calendar date in range, else null. */
function toIso(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Exactly "YYYY-MM-DD", and a real date. Returns the same string, or null. */
export function parseIsoDate(text: string): string | null {
  if (typeof text !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  return match ? toIso(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

export function isValidIsoDate(text: string): boolean {
  return parseIsoDate(text) !== null;
}

export type DateParseResult = { ok: true; iso: string } | { ok: false; message: string };

const FORMAT_HINT: Record<DateFormatId, string> = {
  iso: "YYYY-MM-DD, for example 2026-03-05",
  "dd/mm/yyyy": "DD/MM/YYYY, for example 05/03/2026",
  "dd-mm-yyyy": "DD-MM-YYYY, for example 05-03-2026",
  "dd-mmm-yyyy": "DD-Mon-YYYY, for example 05-Mar-2026",
  "mm/dd/yyyy": "MM/DD/YYYY, for example 03/05/2026",
};

function attempt(text: string, format: DateFormatId): string | null {
  const value = text.trim();
  switch (format) {
    case "iso":
      return parseIsoDate(value);
    case "dd/mm/yyyy": {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
      return m ? toIso(Number(m[3]), Number(m[2]), Number(m[1])) : null;
    }
    case "dd-mm-yyyy": {
      const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(value);
      return m ? toIso(Number(m[3]), Number(m[2]), Number(m[1])) : null;
    }
    case "dd-mmm-yyyy": {
      const m = /^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/.exec(value);
      const month = m ? MONTHS.indexOf(m[2].toLowerCase()) + 1 : 0;
      return m && month > 0 ? toIso(Number(m[3]), month, Number(m[1])) : null;
    }
    case "mm/dd/yyyy": {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
      return m ? toIso(Number(m[3]), Number(m[1]), Number(m[2])) : null;
    }
  }
}

/** Parse under ONE explicitly chosen format. Never guesses another. */
export function parseDateWithFormat(text: string, format: DateFormatId): DateParseResult {
  const iso = typeof text === "string" ? attempt(text, format) : null;
  if (iso) return { ok: true, iso };
  return { ok: false, message: `Not a valid date in the format ${FORMAT_HINT[format]}.` };
}

/**
 * Which formats read EVERY non-blank value as a real date. Used to suggest a
 * choice: several answers, or none, means the person must decide.
 */
export function detectDateFormats(values: string[]): DateFormatId[] {
  const cells = values.map((v) => v.trim()).filter((v) => v !== "");
  if (cells.length === 0) return [];
  return DATE_FORMATS.map((f) => f.id).filter((id) => cells.every((cell) => attempt(cell, id) !== null));
}
