// Form 16 field-extraction tests, on synthetic positioned text items.
// Pure — no database, session, PDF parser, or network.
//
// The layouts below are modelled on the prescribed Form 16 structure but are
// synthetic: no real person's data. They pin the trust rules:
//   - a field is FOUND only when exactly one distinct value was read;
//   - several distinct values make it AMBIGUOUS and none is chosen for you;
//   - nothing found means MISSING, never zero;
//   - every read value carries the line it came from as evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORM16_EXTRACTOR_VERSION,
  deriveSalaryIncome,
  extractForm16Fields,
  salaryConsistency,
} from "../lib/form16-extract";
import type { Form16Extraction, Form16Field, Form16FieldKey } from "../lib/form16-extract";
import type { PdfPage, PositionedItem } from "../lib/pdf-text";

const rupees = (r: number) => r * 100;

/** Build a page from rows of [x, text] cells, top to bottom, 14pt apart. */
function page(pageNumber: number, rows: Array<Array<[number, string]>>): PdfPage {
  const items: PositionedItem[] = [];
  rows.forEach((cells, row) => {
    for (const [x, text] of cells) items.push({ text, x, y: 760 - row * 14, width: text.length * 5, height: 10 });
  });
  return { page: pageNumber, items };
}

function field(extraction: Form16Extraction, key: Form16FieldKey): Form16Field {
  const found = extraction.fields.find((f) => f.key === key);
  assert.ok(found, `field ${key} is always present in the result`);
  return found;
}

const PART_A: Array<Array<[number, string]>> = [
  [[40, "FORM NO. 16"]],
  [[40, "PART A"], [120, "Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source on salary"]],
  [[40, "Name and address of the Employer"], [320, "Name and address of the Employee"]],
  [[40, "ACME SOFTWARE"], [110, "PRIVATE LIMITED"], [320, "ASHA RAO"]],
  [[40, "Assessment Year"], [140, "2026-27"], [260, "Period with the Employer"], [400, "01-Apr-2025"], [470, "31-Mar-2026"]],
  [[40, "Total (Rs.)"], [200, "1200000.00"], [300, "150000.00"], [400, "150000.00"]],
];

const PART_B: Array<Array<[number, string]>> = [
  [[40, "PART B (Annexure)"]],
  [[40, "1. Gross Salary"]],
  [[40, "(a) Salary as per provisions contained in section 17(1)"], [450, "1200000.00"]],
  [[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, "1200000.00"]],
  [[40, "2. Less: Allowances to the extent exempt under section 10"]],
  [[40, "(h) Total amount of exemption claimed under section 10 [2(a)+2(b)+2(c)+2(d)+2(e)+2(f)+2(g)]"], [450, "100000.00"]],
  [[40, "3. Total amount of salary received from current employer [1(d)-2(h)]"], [450, "1100000.00"]],
  [[40, "(a) Standard deduction under section 16(ia)"], [450, "75000.00"]],
  [[40, "(c) Tax on employment under section 16(iii)"], [450, "2400.00"]],
  [[40, "6. Income chargeable under the head 'Salaries' [(3+1(e))-5]"], [450, "1022600.00"]],
  [[40, "(a) Deduction in respect of life insurance premia, contributions to provident fund etc. under section 80C"], [400, "150000.00"], [450, "150000.00"], [500, "150000.00"]],
  [[40, "(f) Deduction in respect of health insurance premia under section 80D"], [400, "25000.00"], [450, "25000.00"], [500, "25000.00"]],
];

const FULL = [page(1, PART_A), page(2, PART_B)];

test("a complete Form 16 yields every field as found, with exact paise and evidence", () => {
  const result = extractForm16Fields(FULL);

  assert.equal(result.extractorVersion, FORM16_EXTRACTOR_VERSION);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.recognised, { form16: true, partA: true, partB: true });

  const expected: Array<[Form16FieldKey, number]> = [
    ["grossSalary", rupees(12_00_000)],
    ["section10Exemptions", rupees(1_00_000)],
    ["salaryFromCurrentEmployer", rupees(11_00_000)],
    ["standardDeduction", rupees(75_000)],
    ["professionalTax", rupees(2_400)],
    ["section80C", rupees(1_50_000)],
    ["section80D", rupees(25_000)],
  ];
  for (const [key, paise] of expected) {
    const f = field(result, key);
    assert.equal(f.status, "found", key);
    assert.equal(f.valuePaise, paise, key);
    assert.ok(f.evidence && f.evidence.page === 2 && f.evidence.text.length > 0, key);
    assert.equal(f.candidates.length, 1, key);
  }
  assert.match(field(result, "grossSalary").evidence!.text, /1200000\.00/);
});

test("text fields: assessment year and employer name are read, with evidence", () => {
  const result = extractForm16Fields(FULL);
  const ay = field(result, "assessmentYear");
  assert.equal(ay.status, "found");
  assert.equal(ay.value, "2026-27");
  assert.equal(ay.valuePaise, null);
  assert.equal(ay.evidence?.page, 1);

  const employer = field(result, "employerName");
  assert.equal(employer.status, "found");
  assert.equal(employer.value, "ACME SOFTWARE PRIVATE LIMITED", "the employee column beside it is not mixed in");
  assert.equal(employer.valuePaise, null);
});

test("assessment years written in longer forms are normalised", () => {
  for (const written of ["2026-2027", "2026 - 27", "2026-27"]) {
    const result = extractForm16Fields([page(1, [[[40, "Assessment Year"], [140, written]]])]);
    assert.equal(field(result, "assessmentYear").value, "2026-27", written);
  }
});

test("two different assessment years make the field ambiguous, and neither is chosen", () => {
  const result = extractForm16Fields([page(1, [[[40, "Assessment Year"], [140, "2026-27"]], [[40, "Assessment Year"], [140, "2025-26"]]])]);
  const ay = field(result, "assessmentYear");
  assert.equal(ay.status, "ambiguous");
  assert.equal(ay.value, null);
  assert.deepEqual(ay.candidates.map((c) => c.value).sort(), ["2025-26", "2026-27"]);
});

test("the same figure read from several places is still ONE value and stays found", () => {
  const rows: Array<Array<[number, string]>> = [
    [[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, "1200000.00"]],
    [[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, "12,00,000.00"]],
  ];
  const gross = field(extractForm16Fields([page(2, rows)]), "grossSalary");
  assert.equal(gross.status, "found");
  assert.equal(gross.valuePaise, rupees(12_00_000));
});

test("different figures for one field are ambiguous: every candidate is offered, none is picked", () => {
  const rows: Array<Array<[number, string]>> = [
    [[40, "(a) Deduction in respect of life insurance premia etc. under section 80C"], [400, "200000.00"], [450, "150000.00"], [500, "150000.00"]],
  ];
  const c80 = field(extractForm16Fields([page(2, rows)]), "section80C");
  assert.equal(c80.status, "ambiguous");
  assert.equal(c80.valuePaise, null);
  assert.equal(c80.value, null);
  // Rightmost column first (in Form 16 that is the deductible amount), then the others; no duplicates.
  assert.deepEqual(c80.candidates.map((c) => c.valuePaise), [rupees(1_50_000), rupees(2_00_000)]);
  assert.ok(c80.candidates.every((c) => c.page === 2 && c.text.includes("80C")));
});

test("two lines with different figures for the same label are ambiguous too", () => {
  const rows: Array<Array<[number, string]>> = [
    [[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, "1200000.00"]],
    [[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, "1250000.00"]],
  ];
  assert.equal(field(extractForm16Fields([page(2, rows)]), "grossSalary").status, "ambiguous");
});

test("fields that are not in the document are MISSING with no value; zero is never assumed", () => {
  const result = extractForm16Fields([page(2, [[[40, "PART B (Annexure)"]], [[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, "1200000.00"]]])]);
  for (const key of ["section10Exemptions", "section80C", "section80D", "standardDeduction", "professionalTax", "salaryFromCurrentEmployer"] as const) {
    const f = field(result, key);
    assert.equal(f.status, "missing", key);
    assert.equal(f.valuePaise, null, key);
    assert.equal(f.value, null, key);
    assert.equal(f.evidence, null, key);
    assert.deepEqual(f.candidates, [], key);
  }
});

test("a label with no amount beside it is missing, not zero", () => {
  const result = extractForm16Fields([page(2, [[[40, "(a) Standard deduction under section 16(ia)"]], [[40, "Some unrelated words follow here"]]])]);
  assert.equal(field(result, "standardDeduction").status, "missing");
});

test("an amount printed on the line below its label is read, and the evidence shows both lines", () => {
  const rows: Array<Array<[number, string]>> = [
    [[40, "(h) Total amount of exemption claimed under section 10"]],
    [[450, "100000.00"]],
  ];
  const f = field(extractForm16Fields([page(2, rows)]), "section10Exemptions");
  assert.equal(f.status, "found");
  assert.equal(f.valuePaise, rupees(1_00_000));
  assert.match(f.evidence!.text, /exemption claimed under section 10/);
  assert.match(f.evidence!.text, /100000\.00/);
});

test("section and clause numbers inside a label are never mistaken for amounts", () => {
  const rows: Array<Array<[number, string]>> = [
    [[40, "(h) Total amount of exemption claimed under section 10 [2(a)+2(b)+2(c)]"], [450, "0.00"]],
    [[40, "(a) Standard deduction under section 16(ia)"], [450, "75,000.00"]],
    [[40, "(a) life insurance premia etc. under section 80C"], [450, "1,50,000.00"]],
  ];
  const result = extractForm16Fields([page(2, rows)]);
  assert.equal(field(result, "section10Exemptions").valuePaise, 0, "an explicit 0.00 IS read as zero");
  assert.equal(field(result, "section10Exemptions").status, "found");
  assert.equal(field(result, "standardDeduction").valuePaise, rupees(75_000));
  assert.equal(field(result, "section80C").valuePaise, rupees(1_50_000));
});

test("80C is not confused with 80CCC, 80CCD or 80CCE, and 80D is not confused with 80DD or 80DDB", () => {
  const rows: Array<Array<[number, string]>> = [
    [[40, "(b) Deduction in respect of contribution to pension fund under section 80CCC"], [450, "5000.00"]],
    [[40, "(c) Deduction in respect of contribution by taxpayer to pension scheme under section 80CCD (1)"], [450, "6000.00"]],
    [[40, "(d) Deduction in respect of maintenance of a disabled dependant under section 80DD"], [450, "7000.00"]],
  ];
  const result = extractForm16Fields([page(2, rows)]);
  assert.equal(field(result, "section80C").status, "missing");
  assert.equal(field(result, "section80D").status, "missing");
});

test("amounts are exact paise across Indian and plain formats; negatives and junk are not amounts", () => {
  const cases: Array<[string, number]> = [
    ["12,00,000.00", 120_000_000],
    ["1200000", 120_000_000],
    ["1,234.10", 123_410],
    ["0.29", 29],
    ["75,000", 7_500_000],
  ];
  for (const [text, paise] of cases) {
    const f = field(extractForm16Fields([page(2, [[[40, "(a) Standard deduction under section 16(ia)"], [450, text]]])]), "standardDeduction");
    assert.equal(f.valuePaise, paise, text);
  }
  for (const junk of ["(1,000.00)", "-500.00", "abc", "12.345"]) {
    const f = field(extractForm16Fields([page(2, [[[40, "(a) Standard deduction under section 16(ia)"], [450, junk]]])]), "standardDeduction");
    assert.equal(f.status, "missing", junk);
  }
});

test("items on nearly the same baseline form one line; visibly separate baselines do not", () => {
  const p: PdfPage = {
    page: 1,
    items: [
      { text: "(a) Standard deduction under section 16(ia)", x: 40, y: 700, width: 200, height: 10 },
      { text: "75,000.00", x: 450, y: 701.4, width: 45, height: 10 }, // jitter within the same line
      { text: "(c) Tax on employment under section 16(iii)", x: 40, y: 640, width: 200, height: 10 },
      { text: "2,400.00", x: 450, y: 640, width: 40, height: 10 },
    ],
  };
  const result = extractForm16Fields([p]);
  assert.equal(field(result, "standardDeduction").valuePaise, rupees(75_000));
  assert.equal(field(result, "professionalTax").valuePaise, rupees(2_400));
});

test("evidence reports the page each value came from", () => {
  const result = extractForm16Fields([page(1, [[[40, "Assessment Year"], [140, "2026-27"]]]), page(3, [[[40, "(d) Total [1(a)+1(b)+1(c)]"], [450, "900000.00"]]])]);
  assert.equal(field(result, "assessmentYear").evidence?.page, 1);
  assert.equal(field(result, "grossSalary").evidence?.page, 3);
});

test("evidence text is trimmed to a sensible length", () => {
  const long = "(a) Standard deduction under section 16(ia) " + "x".repeat(600);
  const f = field(extractForm16Fields([page(2, [[[40, long], [900, "75,000.00"]]])]), "standardDeduction");
  assert.ok(f.evidence!.text.length <= 240);
});

test("fields SmartCA does not use are present but marked not used; the rest are marked used", () => {
  const result = extractForm16Fields(FULL);
  const usage = Object.fromEntries(result.fields.map((f) => [f.key, f.usage]));
  assert.deepEqual(usage, {
    assessmentYear: "used",
    employerName: "used",
    grossSalary: "used",
    section10Exemptions: "used",
    section80C: "used",
    salaryFromCurrentEmployer: "not_used",
    standardDeduction: "not_used",
    professionalTax: "not_used",
    section80D: "not_used",
    tdsDeducted: "not_used",
  });
  for (const f of result.fields.filter((x) => x.usage === "not_used")) {
    assert.ok(f.note && f.note.length > 0, `${f.key} explains why it is not used`);
  }
});

test("the TDS total row has several different figures, so it is ambiguous rather than guessed", () => {
  const tds = field(extractForm16Fields(FULL), "tdsDeducted");
  assert.equal(tds.status, "ambiguous");
  assert.equal(tds.valuePaise, null);
  assert.equal(tds.candidates.length, 2);
});

test("every field kind is right: money fields never carry text, text fields never carry paise", () => {
  for (const f of extractForm16Fields(FULL).fields) {
    if (f.kind === "money") assert.equal(f.value, null, f.key);
    else assert.equal(f.valuePaise, null, f.key);
  }
});

test("document recognition: Part A only, Part B only, and something that is not a Form 16", () => {
  assert.deepEqual(extractForm16Fields([page(1, PART_A)]).recognised, { form16: true, partA: true, partB: false });
  assert.deepEqual(extractForm16Fields([page(1, PART_B)]).recognised, { form16: true, partA: false, partB: true });
  const other = extractForm16Fields([page(1, [[[40, "Monthly statement of account"]], [[40, "Opening balance"], [300, "1,000.00"]]])]);
  assert.equal(other.recognised.form16, false);
  assert.ok(other.fields.every((f) => f.status === "missing"));
});

test("an empty document yields an all-missing result rather than an error", () => {
  const result = extractForm16Fields([]);
  assert.equal(result.pageCount, 0);
  assert.equal(result.fields.length, 10);
  assert.ok(result.fields.every((f) => f.status === "missing"));
});

test("the result is plain JSON (it is stored as jsonb) and deterministic", () => {
  const a = extractForm16Fields(FULL);
  const b = extractForm16Fields(FULL);
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

// --- derived salary and consistency ---------------------------------------

test("salary income used by SmartCA is gross salary minus Section 10 exemptions, in exact paise", () => {
  assert.equal(deriveSalaryIncome(rupees(12_00_000), rupees(1_00_000)), rupees(11_00_000));
  assert.equal(deriveSalaryIncome(rupees(12_00_000), 0), rupees(12_00_000));
  assert.equal(deriveSalaryIncome(120_000_050, 50), 120_000_000);
});

test("no salary income is derived from impossible inputs", () => {
  assert.equal(deriveSalaryIncome(rupees(1_00_000), rupees(2_00_000)), null, "exemptions above gross");
  assert.equal(deriveSalaryIncome(-1, 0), null);
  assert.equal(deriveSalaryIncome(100, -1), null);
  assert.equal(deriveSalaryIncome(1.5, 0), null);
  assert.equal(deriveSalaryIncome(Number.NaN, 0), null);
});

test("salaryConsistency compares the derived figure with what the Form 16 itself states", () => {
  assert.deepEqual(salaryConsistency(rupees(12_00_000), rupees(1_00_000), rupees(11_00_000)), { statedPaise: rupees(11_00_000), derivedPaise: rupees(11_00_000), matches: true });
  assert.deepEqual(salaryConsistency(rupees(12_00_000), rupees(50_000), rupees(11_00_000)), { statedPaise: rupees(11_00_000), derivedPaise: rupees(11_50_000), matches: false });
  assert.equal(salaryConsistency(rupees(12_00_000), rupees(1_00_000), null), null, "nothing to compare against");
  assert.equal(salaryConsistency(rupees(1_00_000), rupees(2_00_000), rupees(5)), null, "cannot derive");
});

test("real pdf.js output separates table cells with a wide whitespace item: the employer is still read", () => {
  // Captured shape from the actual parser: a " " item spans the gap between cells.
  const p: PdfPage = {
    page: 1,
    items: [
      { text: "Name and address of the Employer", x: 40, y: 732, width: 157.3, height: 10 },
      { text: " ", x: 197.3, y: 732, width: 122.7, height: 0 },
      { text: "Name and address of the Employee", x: 320, y: 732, width: 159.5, height: 10 },
      { text: "ACME REAL PRIVATE LIMITED", x: 40, y: 718, width: 141.1, height: 10 },
      { text: " ", x: 181.1, y: 718, width: 138.9, height: 0 },
      { text: "TEST EMPLOYEE", x: 320, y: 718, width: 83.4, height: 10 },
    ],
  };
  const employer = field(extractForm16Fields([p]), "employerName");
  assert.equal(employer.status, "found");
  assert.equal(employer.value, "ACME REAL PRIVATE LIMITED");
});

test("a narrow whitespace item is just a word space, not a cell boundary", () => {
  const p: PdfPage = {
    page: 1,
    items: [
      { text: "Name and address of the Employer", x: 40, y: 732, width: 157.3, height: 10 },
      { text: "ACME", x: 40, y: 718, width: 30, height: 10 },
      { text: " ", x: 70, y: 718, width: 3, height: 0 },
      { text: "WORKS LIMITED", x: 73, y: 718, width: 80, height: 10 },
    ],
  };
  assert.equal(field(extractForm16Fields([p]), "employerName").value, "ACME WORKS LIMITED");
});
