// Deterministic Form 16 field extraction from positioned PDF text.
//
// No AI, no OCR. It groups text items into lines by their positions, finds a
// field by its printed LABEL, and reads the amount printed after it. Every
// value it returns is a CANDIDATE for the person to review: nothing extracted
// is trusted, and nothing here feeds a tax figure.
//
// Trust rules (pinned by tests/form16-extract.test.ts):
//   - FOUND only when exactly one distinct value was read;
//   - AMBIGUOUS when several distinct values were read: all are listed with
//     their evidence and none is chosen;
//   - MISSING when nothing was read: never defaulted to zero;
//   - each value carries the page and the line it came from.
//
// The label wording follows the prescribed Form 16 layout, but payroll
// software varies in table structure and wording, so extraction can and will
// miss fields on some documents. That is why review is mandatory.
//
// Pure: no I/O, no framework, no database.
import { parseRupeesToPaise } from "./money-input";
import type { PdfPage, PositionedItem } from "./pdf-text";

export const FORM16_EXTRACTOR_VERSION = "form16-text-v1";

export type Form16FieldKey =
  | "assessmentYear"
  | "employerName"
  | "grossSalary"
  | "section10Exemptions"
  | "salaryFromCurrentEmployer"
  | "standardDeduction"
  | "professionalTax"
  | "section80C"
  | "section80D"
  | "tdsDeducted";

export type Form16FieldStatus = "found" | "ambiguous" | "missing";

export type Form16Candidate = {
  /** Text fields only. */
  value: string | null;
  /** Money fields only, in exact integer paise. */
  valuePaise: number | null;
  page: number;
  text: string;
};

export type Form16Field = {
  key: Form16FieldKey;
  label: string;
  kind: "money" | "text";
  /** "used": a confirmed value may reach the Tax workspace or label it. "not_used": shown for transparency only. */
  usage: "used" | "not_used";
  status: Form16FieldStatus;
  /** Set only for a FOUND text field. */
  value: string | null;
  /** Set only for a FOUND money field. */
  valuePaise: number | null;
  evidence: { page: number; text: string } | null;
  /** One entry when found, every distinct reading when ambiguous, none when missing. */
  candidates: Form16Candidate[];
  /** Why a not-used field is not used. */
  note?: string;
};

export type Form16Extraction = {
  extractorVersion: string;
  pageCount: number;
  recognised: { form16: boolean; partA: boolean; partB: boolean };
  fields: Form16Field[];
};

/** What the person confirmed. The only Form 16 data any calculation may read. */
export type Form16Confirmed = {
  schemaVersion: 1;
  extractorVersion: string;
  assessmentYear: string;
  employerName: string | null;
  grossSalaryPaise: number;
  section10ExemptionsPaise: number;
  /** gross salary minus Section 10 exemptions, derived on the server. */
  salaryIncomePaise: number;
  section80CPaise: number | null;
};

// ---------------------------------------------------------------------
// Derived salary
// ---------------------------------------------------------------------

/**
 * The salary figure SmartCA can use: gross salary minus the Section 10
 * exemptions, in exact paise. Null for anything impossible. The tax engine
 * does not model exemptions such as HRA, so it needs salary net of them.
 */
export function deriveSalaryIncome(grossSalaryPaise: number, section10ExemptionsPaise: number): number | null {
  if (!Number.isSafeInteger(grossSalaryPaise) || !Number.isSafeInteger(section10ExemptionsPaise)) return null;
  if (grossSalaryPaise < 0 || section10ExemptionsPaise < 0 || section10ExemptionsPaise > grossSalaryPaise) return null;
  return grossSalaryPaise - section10ExemptionsPaise;
}

/**
 * Compare the derived figure with the "salary received from current employer"
 * the Form 16 itself states (its item 3 is exactly gross minus exemptions).
 * A mismatch is a hint that a value was misread. Null when there is nothing to compare.
 */
export function salaryConsistency(
  grossSalaryPaise: number,
  section10ExemptionsPaise: number,
  statedPaise: number | null,
): { statedPaise: number; derivedPaise: number; matches: boolean } | null {
  const derivedPaise = deriveSalaryIncome(grossSalaryPaise, section10ExemptionsPaise);
  if (derivedPaise === null || statedPaise === null) return null;
  return { statedPaise, derivedPaise, matches: statedPaise === derivedPaise };
}

// ---------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------

type Line = { page: number; y: number; items: PositionedItem[]; text: string };

/** Items closer than this (in points) vertically belong to the same printed line. */
const SAME_LINE_TOLERANCE = 3;
/** A horizontal gap wider than this starts a new table cell. */
const CELL_GAP = 30;
/** How far below a label its amount may sit and still count as belonging to it. */
const NEXT_LINE_REACH = 30;
const MAX_EVIDENCE_LENGTH = 240;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function buildLines(pages: PdfPage[]): Line[] {
  const lines: Line[] = [];
  for (const { page, items } of pages) {
    const ordered = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    let current: PositionedItem[] = [];
    let referenceY = 0;
    const flush = () => {
      if (current.length === 0) return;
      const byX = [...current].sort((a, b) => a.x - b.x);
      lines.push({ page, y: referenceY, items: byX, text: collapse(byX.map((i) => i.text).join(" ")) });
      current = [];
    };
    for (const item of ordered) {
      if (current.length > 0 && Math.abs(item.y - referenceY) > SAME_LINE_TOLERANCE) flush();
      if (current.length === 0) referenceY = item.y;
      current.push(item);
    }
    flush();
  }
  return lines;
}

/** Split a line into table cells wherever there is a wide horizontal gap. */
function cellsOf(line: Line): string[] {
  const cells: string[] = [];
  let current: PositionedItem[] = [];
  const flush = () => {
    if (current.length > 0) cells.push(collapse(current.map((i) => i.text).join(" ")));
    current = [];
  };
  for (const item of line.items) {
    // pdf.js prints the space between table cells as a whitespace-only item
    // as wide as the gap. A wide one is a cell boundary; a narrow one is
    // just a word space.
    if (item.text.trim() === "") {
      if (item.width > CELL_GAP) flush();
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && item.x - (previous.x + previous.width) > CELL_GAP) flush();
    current.push(item);
  }
  flush();
  return cells.filter((c) => c !== "");
}

// ---------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------

/** A token that is plainly an amount: digits with optional grouping and at most two decimals. */
const AMOUNT_TOKEN = /^\d[\d,]*(?:\.\d{1,2})?$/;

function tokenToPaise(rawToken: string): number | null {
  const token = rawToken.replace(/^(?:₹|Rs\.?)/i, "").replace(/[.,;]$/, "");
  if (!AMOUNT_TOKEN.test(token)) return null;
  const parsed = parseRupeesToPaise(token);
  return parsed.ok ? parsed.paise : null;
}

/** Every amount in the text, left to right. Anything that is not plainly an amount is skipped. */
function amountsIn(text: string): number[] {
  const found: number[] = [];
  for (const token of text.split(/\s+/)) {
    const paise = tokenToPaise(token);
    if (paise !== null) found.push(paise);
  }
  return found;
}

/** True when the line is nothing but amounts (a value printed on its own row). */
function isAmountsOnly(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => tokenToPaise(t) !== null);
}

// ---------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------

type MoneyDefinition = {
  key: Form16FieldKey;
  label: string;
  usage: "used" | "not_used";
  note?: string;
  labels: RegExp[];
};

// Optional trailing "[2(a)+2(b)...]" formula that Form 16 prints inside a label.
const FORMULA = String.raw`(?:\s*\[[^\]]*\])?`;

const MONEY_FIELDS: MoneyDefinition[] = [
  {
    key: "grossSalary",
    label: "Gross salary",
    usage: "used",
    labels: [
      new RegExp(String.raw`total\s*\[\s*1\s*\(a\)\s*\+\s*1\s*\(b\)[^\]]*\]`, "i"),
      new RegExp(String.raw`gross salary\s*(?:total|\(d\)\s*total)`, "i"),
    ],
  },
  {
    key: "section10Exemptions",
    label: "Exemptions under Section 10",
    usage: "used",
    labels: [
      new RegExp(String.raw`total amount of exemption claimed under section 10${FORMULA}`, "i"),
      new RegExp(String.raw`total exemptions? (?:claimed )?under section 10${FORMULA}`, "i"),
    ],
  },
  {
    key: "salaryFromCurrentEmployer",
    label: "Salary received from current employer",
    usage: "not_used",
    note: "Used only to cross-check gross salary minus exemptions. SmartCA calculates the salary figure itself.",
    labels: [new RegExp(String.raw`total amount of salary received from current employer${FORMULA}`, "i")],
  },
  {
    key: "standardDeduction",
    label: "Standard deduction, Section 16(ia)",
    usage: "not_used",
    note: "SmartCA applies the standard deduction itself, per regime, so the employer's figure is not used.",
    labels: [new RegExp(String.raw`standard deduction under (?:section )?16\s*\(ia\)`, "i")],
  },
  {
    key: "professionalTax",
    label: "Tax on employment, Section 16(iii)",
    usage: "not_used",
    note: "Professional tax is not modelled by SmartCA, so it does not change the result.",
    labels: [new RegExp(String.raw`tax on employment under (?:section )?16\s*\(iii\)`, "i")],
  },
  {
    key: "section80C",
    label: "Section 80C deduction",
    usage: "used",
    labels: [new RegExp(String.raw`(?:under section|u\/s|section)\s*80C(?![A-Za-z0-9])`, "i")],
  },
  {
    key: "section80D",
    label: "Section 80D deduction",
    usage: "not_used",
    note: "SmartCA needs 80D split between self/family and parents, which a Form 16 does not do, so enter it in the Tax workspace.",
    labels: [new RegExp(String.raw`(?:under section|u\/s|section)\s*80D(?![A-Za-z0-9])`, "i")],
  },
  {
    key: "tdsDeducted",
    label: "Tax deducted at source (total)",
    usage: "not_used",
    note: "SmartCA does not reconcile TDS: the Tax workspace shows tax liability before TDS.",
    labels: [/total\s*\(rs\.?\)/i],
  },
];

// ---------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------

function trimEvidence(text: string): string {
  const t = collapse(text);
  return t.length <= MAX_EVIDENCE_LENGTH ? t : t.slice(0, MAX_EVIDENCE_LENGTH);
}

function missingField(base: Pick<Form16Field, "key" | "label" | "kind" | "usage" | "note">): Form16Field {
  return { ...base, status: "missing", value: null, valuePaise: null, evidence: null, candidates: [] };
}

function moneyField(def: MoneyDefinition, lines: Line[]): Form16Field {
  const base = { key: def.key, label: def.label, kind: "money" as const, usage: def.usage, ...(def.note ? { note: def.note } : {}) };
  const candidates: Form16Candidate[] = [];

  lines.forEach((line, index) => {
    for (const pattern of def.labels) {
      const match = pattern.exec(line.text);
      if (!match) continue;

      let amounts = amountsIn(line.text.slice(match.index + match[0].length));
      let evidenceText = line.text;
      if (amounts.length === 0) {
        // The amount may be printed on its own line just below the label.
        const next = lines[index + 1];
        if (next && next.page === line.page && line.y - next.y <= NEXT_LINE_REACH && isAmountsOnly(next.text)) {
          amounts = amountsIn(next.text);
          evidenceText = `${line.text} ${next.text}`;
        }
      }
      // Rightmost first: in a Form 16 table the last column is the final figure.
      for (const paise of [...amounts].reverse()) {
        candidates.push({ value: null, valuePaise: paise, page: line.page, text: trimEvidence(evidenceText) });
      }
      break; // one label pattern per line is enough
    }
  });

  return resolve(base, candidates, (c) => String(c.valuePaise));
}

/** Apply the trust rules to a set of readings. */
function resolve(
  base: Pick<Form16Field, "key" | "label" | "kind" | "usage" | "note">,
  candidates: Form16Candidate[],
  identity: (c: Form16Candidate) => string,
): Form16Field {
  const distinct: Form16Candidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = identity(candidate);
    if (!seen.has(id)) {
      seen.add(id);
      distinct.push(candidate);
    }
  }

  if (distinct.length === 0) return missingField(base);
  if (distinct.length > 1) {
    return { ...base, status: "ambiguous", value: null, valuePaise: null, evidence: { page: distinct[0].page, text: distinct[0].text }, candidates: distinct };
  }
  const [only] = distinct;
  return {
    ...base,
    status: "found",
    value: only.value,
    valuePaise: only.valuePaise,
    evidence: { page: only.page, text: only.text },
    candidates: [only],
  };
}

// --- text fields ---------------------------------------------------------

const ASSESSMENT_YEAR = /assessment\s*year\D{0,20}?(20\d{2})\s*[-–/]\s*(?:20)?(\d{2})\b/i;

function assessmentYearField(lines: Line[]): Form16Field {
  const base = { key: "assessmentYear" as const, label: "Assessment year", kind: "text" as const, usage: "used" as const };
  const candidates: Form16Candidate[] = [];
  for (const line of lines) {
    const match = ASSESSMENT_YEAR.exec(line.text);
    if (!match) continue;
    const startYear = Number(match[1]);
    // "2026-27" is only an assessment year if the second part follows the first.
    if (match[2] !== String((startYear + 1) % 100).padStart(2, "0")) continue;
    candidates.push({ value: `${match[1]}-${match[2]}`, valuePaise: null, page: line.page, text: trimEvidence(line.text) });
  }
  return resolve(base, candidates, (c) => c.value ?? "");
}

const EMPLOYER_LABEL = /name and address of the employer/i;
const EMPLOYEE_LABEL = /name and address of the employee.*$/i;
const LABEL_WORDS = /name and address|employer|employee|\bpan\b|\btan\b|deductor|deductee/i;
const PAN_LIKE = /^[A-Z]{5}\d{4}[A-Z]$/;

function looksLikeName(text: string): boolean {
  const t = collapse(text);
  return t.length >= 3 && t.length <= 100 && /[A-Za-z]{3,}/.test(t) && !LABEL_WORDS.test(t) && !PAN_LIKE.test(t) && amountsIn(t).length === 0;
}

function employerNameField(lines: Line[]): Form16Field {
  const base = { key: "employerName" as const, label: "Employer name", kind: "text" as const, usage: "used" as const };
  const candidates: Form16Candidate[] = [];

  lines.forEach((line, index) => {
    const match = EMPLOYER_LABEL.exec(line.text);
    if (!match) return;

    // On the same line, after the label (and before any employee column)?
    const sameLine = collapse(line.text.slice(match.index + match[0].length).replace(EMPLOYEE_LABEL, ""));
    if (looksLikeName(sameLine)) {
      candidates.push({ value: sameLine, valuePaise: null, page: line.page, text: trimEvidence(line.text) });
      return;
    }
    // Otherwise the name sits in the leftmost cell of the next line (the employee is beside it).
    const next = lines[index + 1];
    if (!next || next.page !== line.page || line.y - next.y > NEXT_LINE_REACH) return;
    const [firstCell] = cellsOf(next);
    if (firstCell && looksLikeName(firstCell)) {
      candidates.push({ value: firstCell, valuePaise: null, page: line.page, text: trimEvidence(`${line.text} / ${firstCell}`) });
    }
  });

  return resolve(base, candidates, (c) => (c.value ?? "").toLowerCase());
}

// --- document recognition -------------------------------------------------

function recognise(lines: Line[]): Form16Extraction["recognised"] {
  const any = (pattern: RegExp) => lines.some((l) => pattern.test(l.text));
  const partA = any(/\bpart\s*a\b/i) || any(/certificate under section 203/i);
  const partB = any(/\bpart\s*b\b/i) || any(/details of salary paid/i);
  const mention = any(/\bform\s*(?:no\.?\s*)?16\b/i);
  return { form16: mention || partA || partB, partA, partB };
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

const FIELD_ORDER: Form16FieldKey[] = [
  "assessmentYear",
  "employerName",
  "grossSalary",
  "section10Exemptions",
  "section80C",
  "salaryFromCurrentEmployer",
  "standardDeduction",
  "professionalTax",
  "section80D",
  "tdsDeducted",
];

export function extractForm16Fields(pages: PdfPage[]): Form16Extraction {
  const lines = buildLines(pages);

  const byKey = new Map<Form16FieldKey, Form16Field>();
  byKey.set("assessmentYear", assessmentYearField(lines));
  byKey.set("employerName", employerNameField(lines));
  for (const def of MONEY_FIELDS) byKey.set(def.key, moneyField(def, lines));

  return {
    extractorVersion: FORM16_EXTRACTOR_VERSION,
    pageCount: pages.length,
    recognised: recognise(lines),
    fields: FIELD_ORDER.map((key) => byKey.get(key)!),
  };
}
