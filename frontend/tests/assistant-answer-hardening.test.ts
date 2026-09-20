// Phase 6 hardening of the answer layer (lib/assistant/answer.ts). PURE: no database, no model, no network, no DATABASE_URL.
//
//   B2   a negation cannot bypass an authority, deadline or law-claim check (it must sit next to the claim it denies)
//   B3   a money amount is recognised in the ways people write Indian amounts, and is compared only with figures that were
//        ALREADY present in a tool result, the person's own words, or a cited quote. The answer layer never computes one.
//   B3b  an implicit regime recommendation is withheld, unless the person supplied that conclusion themselves
//
// Every rule here fails when its check is removed: the mutation checks that prove it are recorded in the phase report.
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnswer } from "../lib/assistant/answer";
import type { Answer, ToolRecord } from "../lib/assistant/answer";
import { calcRecord, calcResult, compareRecord, compareResult, evidence, evidenceId, inr, searchRecord, simulateRecord } from "./helpers-answer";

const FRONTEND = path.resolve(__dirname, "..");
const answer = (text: string, toolRecords: ToolRecord[] = [], userMessages?: string[]): Answer => buildAnswer({ text, toolRecords, ...(userMessages ? { userMessages } : {}) });
const blocking = (a: Answer) => [...new Set(a.violations.filter((v) => v.severity === "blocking").map((v) => v.code))].sort();
const codes = (a: Answer) => [...new Set(a.violations.map((v) => v.code))].sort();
const cite = `[${evidenceId(1)}]`;
const guidance = [searchRecord([evidence(1)])];
const OLD = calcResult("old");
const CMP = compareResult();

// --- B2: a negation must be attached to the claim it denies ------------------------------------------------------------

test("B2: a negation elsewhere in the sentence cannot license a statute or circular claim", () => {
  for (const text of [
    `This is not guidance, the statute says the rebate applies ${cite}.`,
    `This is not guidance so the statute says the rebate applies ${cite}.`,
    `It is not guidance and the Income-tax Act says the rebate applies ${cite}.`,
    `Not that it matters, but the Income-tax Act provides a rebate ${cite}.`,
    `I do not doubt it, according to the Act the rebate applies ${cite}.`,
    `This is not a circular; the CBDT circular states the rebate applies ${cite}.`,
    `The rebate is not disputed, as per the circular the limit is ₹60,000 ${cite}.`,
    // No clause break, but the negation is too far from the claim to be attached to it (more than six words between).
    `I am not going to pretend it is obvious to anyone that the statute says the rebate applies ${cite}.`,
  ]) {
    const a = answer(text, guidance);
    assert.ok(blocking(a).includes("authority_upgrade"), text);
    assert.equal(a.state, "withheld", text);
    assert.equal(a.text, null, text);
  }
});

test("B2: an honest disclaimer, where the negation sits next to what it denies, is still released", () => {
  for (const text of [
    `This is official guidance, not statute text ${cite}.`,
    `This is official guidance, not the text of the Act, so I cannot say what the Act says ${cite}.`,
    "I can't tell you what the circular says: there is no circular in my sources.",
    "I can't tell you what the Act says; I only have official guidance.",
    "I have no statute text to cite.",
    `The evidence is official guidance, not the statute ${cite}.`,
  ]) {
    const a = answer(text, guidance);
    assert.equal(blocking(a).includes("authority_upgrade"), false, text);
    assert.equal(a.state, "answered", text);
  }
});

test("B2: with real statute or circular evidence the claim is licensed by the evidence, not by a negation", () => {
  const statute = [searchRecord([evidence(1, { tier: "statute" })])];
  assert.equal(blocking(answer(`This is not guidance, the statute says the rebate applies ${cite}.`, statute)).includes("authority_upgrade"), false);
  const circular = [searchRecord([evidence(1, { tier: "notification_circular" })])];
  assert.equal(blocking(answer(`The CBDT circular states the rebate applies ${cite}.`, circular)).includes("authority_upgrade"), false);
});

test("B2: a negation elsewhere cannot license a deadline; a refusal next to the date can", () => {
  for (const text of [
    "This is not a deadline for you, but you must file by 31 July.",
    "I cannot be certain, but the due date is 31 July.",
    "It is not certain and the last date is 15 September.",
    "Nothing is confirmed; the filing date is 15 Dec 2026.",
  ]) {
    const a = answer(text);
    assert.ok(blocking(a).includes("unsupported_deadline"), text);
    assert.equal(a.state, "withheld", text);
  }
  for (const text of ["I cannot confirm that 31 July is the deadline.", "There is no source for the due date, so I will not name one.", "I can't state the filing deadline: I have no source for deadlines."]) {
    assert.equal(blocking(answer(text)).includes("unsupported_deadline"), false, text);
  }
});

test("B2: a negation elsewhere cannot license a law claim without evidence; an honest 'I could not find it' can", () => {
  for (const text of [
    "This does not apply to everyone, but Section 80C allows a deduction of up to the limit.",
    "I am not a lawyer and section 87A provides a rebate.",
    "Not all cases qualify, however section 87A gives a rebate.",
  ]) {
    const a = answer(text, [searchRefusalNone()]);
    assert.ok(blocking(a).includes("law_claim_without_evidence"), text);
  }
  for (const text of ["I could not find anything about section 87A limit in my sources.", "I can't say what section 87A provides: I have no evidence for it."]) {
    assert.equal(blocking(answer(text, [searchRefusalNone()])).includes("law_claim_without_evidence"), false, text);
  }
  // With evidence but no citation it is a recorded warning, and a negation elsewhere does not remove it.
  assert.ok(codes(answer("This is not guidance, but section 87A provides a rebate.", guidance)).includes("uncited_law_claim"));
});

function searchRefusalNone(): ToolRecord {
  return { round: 1, callId: "srch1", tool: "search_tax_law", result: { status: "refused", tool: "search_tax_law", reason: "no_matching_passages", message: "No usable evidence.", detail: { assessmentYear: "2026-27", corpusVersion: "ay-2026-27-v1", sectionRefs: [] } } };
}

// --- B3: money amounts, compared only with figures already present -------------------------------------------------------

/** Every way the tests write ₹1,50,000: the 80C amount in the calculation's own input echo. */
const FORMS_OF_150000 = [
  "₹1,50,000", "Rs. 1,50,000", "Rs 1,50,000", "INR 1,50,000", "1,50,000 rupees", "150000 rupees", "₹150000", "₹1.5 lakh", "1.5 lakh rupees", "1.5 lakhs",
  "one lakh fifty thousand rupees", "1 lakh fifty thousand rupees", "1 lakh 50 thousand rupees", "a lakh and fifty thousand rupees", "₹0.015 crore",
];
const FORMS_OF_1500000 = ["₹15,00,000", "₹15 lakh", "15 lakh rupees", "₹0.15 crore", "fifteen lakh rupees", "1500000 rupees", "Rs. 15,00,000"];
const NOT_150000 = [
  "₹1,50,001", "Rs. 1,49,999", "INR 1,50,100", "1,50,001 rupees", "150001 rupees", "₹1.51 lakh", "1.4 lakh rupees", "one lakh forty thousand rupees",
  "1 lakh fifty thousand and one rupees", "₹0.016 crore", "₹1.5 crore",
];

test("B3: an amount the tool returned is recognised in every common Indian form, and released", () => {
  for (const form of FORMS_OF_150000) {
    const a = answer(`Under the old regime your Section 80C deduction is ${form}.`, [calcRecord("old")]);
    assert.deepEqual(blocking(a), [], form);
  }
  for (const form of FORMS_OF_1500000) {
    const a = answer(`Your salary is ${form}.`, [calcRecord("old")]);
    assert.deepEqual(blocking(a), [], form);
  }
});

test("B3: the same forms, one rupee or one lakh away from any figure a tool returned, are withheld", () => {
  for (const form of NOT_150000) {
    const a = answer(`Under the old regime your Section 80C deduction is ${form}.`, [calcRecord("old")]);
    assert.ok(blocking(a).includes("ungrounded_figure"), form);
    assert.equal(a.state, "withheld", form);
  }
});

const SMALL_FORMS_OF_4500 = [
  "₹4,500", "Rs. 4,500", "Rs 4500", "INR 4,500", "4,500 rupees", "4500 rupees", "4,500 Rs", "4,500", "4500", "four thousand five hundred rupees",
  "four thousand five hundred", "4.5 thousand", "₹4.5 thousand",
];

test("B3: an amount of a few thousand rupees is no longer invisible: with no source it is withheld in every form", () => {
  for (const form of SMALL_FORMS_OF_4500) {
    const a = answer(`Under the old regime your cess is ${form}.`, [calcRecord("old")]);
    assert.ok(blocking(a).includes("ungrounded_figure"), form);
  }
});

test("B3: a small amount is recognised by its 'rupees' or Rs suffix alone, in digits or in words", () => {
  const known = numbersIn(calcRecord("old").result);
  for (const [form, paise] of [["500 rupees", 50_000], ["25 rupees", 2_500], ["500 Rs", 50_000], ["five hundred rupees", 50_000], ["twenty five rupees", 2_500], ["a hundred rupees", 10_000]] as const) {
    assert.equal(known.has(paise), false, `the test's own premise: ${form} is not a value the tool returned`);
    const a = answer(`Under the old regime your cess is ${form}.`, [calcRecord("old")]);
    assert.ok(blocking(a).includes("ungrounded_figure"), form);
  }
  assert.deepEqual(blocking(answer("You paid ₹500.", [], ["I paid five hundred rupees."])), [], "and by value, in another form, when the person said it");
});

test("B3: a small amount the person stated, or a cited quote contains, may be repeated in any of those forms (matched by value, not by spelling)", () => {
  for (const form of SMALL_FORMS_OF_4500) {
    assert.deepEqual(blocking(answer(`You paid ${form}.`, [], ["Last month I paid four thousand five hundred rupees for the course."])), [], `person: ${form}`);
    const quoted = [searchRecord([evidence(1, { quote: "The annual fee is ₹ 4,500 for the course" })])];
    assert.deepEqual(blocking(answer(`The fee is ${form} ${cite}.`, quoted)), [], `quote: ${form}`);
  }
  assert.ok(blocking(answer("You paid ₹4,500.", [], ["I paid ₹4,400 last month."])).includes("ungrounded_figure"), "a different figure is not licensed");
});

test("B3: words that are not money are not read as money: counts, years, ages, percentages, sections and small numbers", () => {
  for (const text of [
    "You have 3 regimes to compare.", "That covers 12 months.", "Senior citizens are 60 years or older.", "For AY 2026-27 and FY 2025-26.",
    "The 2026 assessment year applies.", "In 2025 the rules were different.", "See section 80C and Form 16.", "The cess is 4% and the surcharge is 10 percent.",
    "There are two regimes, twelve months and sixty years.", "You have 1,200 transactions in 3 categories.", "12 of 15 items matched.", "The limit rose by 1,000% in ten years.",
  ]) {
    assert.equal(blocking(answer(text)).includes("ungrounded_figure"), false, text);
  }
});

// Written amounts and the paise they mean. The test asserts that none of them is a value the tool returned: they are ROUNDED or
// neighbouring versions of ₹2,10,600, so releasing one would be the layer accepting a figure no tool produced.
const ROUNDED: Array<[string, number]> = [
  ["about ₹2.1 lakh", 21_000_000], ["approximately ₹2,11,000", 21_100_000], ["roughly 2.2 lakh rupees", 22_000_000], ["₹0.021 crore", 21_000_000],
  ["two lakh ten thousand rupees", 21_000_000], ["₹2,10,000", 21_000_000], ["₹2,10,601", 21_060_100], ["Rs. 2.11 lakh", 21_100_000],
];

test("B3: an unsupported ROUNDED figure is withheld: 2.1 lakh is not ₹2,10,600, however close it is", () => {
  const total = OLD.totalTaxPaise;
  assert.equal(total, 21_060_000, "the fixture's old-regime tax is ₹2,10,600");
  const known = numbersIn(calcRecord("old").result);
  for (const [rounded, paise] of ROUNDED) {
    assert.equal(known.has(paise), false, `the test's own premise: ${rounded} is not a value the tool returned`);
    const a = answer(`Under the old regime your total tax is ${rounded}.`, [calcRecord("old")]);
    assert.ok(blocking(a).includes("ungrounded_figure"), rounded);
    assert.equal(a.state, "withheld", rounded);
    assert.deepEqual((a.facts.taxValues[0].payload as { result: { totalTaxPaise: number } }).result.totalTaxPaise, total, "the tool's value is untouched");
  }
  for (const exact of ["₹2,10,600", "2.106 lakh rupees", "two lakh ten thousand six hundred rupees", "Rs. 2,10,600", "210600 rupees"]) {
    assert.deepEqual(blocking(answer(`Under the old regime your total tax is ${exact}.`, [calcRecord("old")])), [], exact);
  }
});

// --- B3: the answer layer is not a tax calculator --------------------------------------------------------------------------

/** Every number in a value, except under the keys in `skip` (a provenance counter such as `round` is metadata, not a figure). */
const numbersIn = (value: unknown, into = new Set<number>(), skip: readonly string[] = []): Set<number> => {
  if (typeof value === "number") into.add(value);
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, into, skip));
  else if (value !== null && typeof value === "object") Object.entries(value).forEach(([key, v]) => { if (!skip.includes(key)) numbersIn(v, into, skip); });
  return into;
};

test("B3: a figure DERIVED from tool figures (a sum, a difference, a share) is withheld: the layer never computes it for you", () => {
  const record = calcRecord("old");
  const known = numbersIn(record.result);
  const salary = 150_000_000;
  const tax = OLD.totalTaxPaise;
  const derived: Array<[string, number]> = [
    ["take-home (salary minus tax)", salary - tax], ["tax plus 80C", tax + 15_000_000], ["half the tax", tax / 2], ["a seventh of the salary", Math.round(salary / 7)],
    ["tax plus taxable income", tax + OLD.taxableIncomePaise], ["salary plus tax", salary + tax],
  ];
  for (const [label, paise] of derived) {
    assert.equal(known.has(paise), false, `the test's own premise: ${label} is not in the tool result`);
    const a = answer(`Under the old regime your ${label} is ${inr(paise)}.`, [record]);
    assert.ok(blocking(a).includes("ungrounded_figure"), label);
    assert.equal(a.text, null, label);
  }
  // A comparison's own difference IS a tool figure; the average or sum of its two totals is not.
  const numbers = CMP.numbers as { oldTotalTaxPaise: number; newTotalTaxPaise: number; differencePaise: number };
  assert.deepEqual(blocking(answer(`Under the old regime the tax is ${inr(numbers.oldTotalTaxPaise)}, under the new regime ${inr(numbers.newTotalTaxPaise)}; the difference is ${inr(numbers.differencePaise)}.`, [compareRecord()])), []);
  const sum = numbers.oldTotalTaxPaise + numbers.newTotalTaxPaise;
  assert.equal(numbersIn(compareRecord().result).has(sum), false);
  assert.ok(blocking(answer(`Under the old and new regime together the tax is ${inr(sum)}.`, [compareRecord()])).includes("ungrounded_figure"));
  assert.ok(blocking(answer(`On average across both, the old regime and new regime tax is ${inr(Math.round(sum / 2))}.`, [compareRecord()])).includes("ungrounded_figure"));
});

test("B3: the facts carry no number that was not already in a tool result: nothing the layer does adds a value", () => {
  const records = [calcRecord("old"), compareRecord(), simulateRecord({ deductionRupees: 0 }, {}), searchRecord([evidence(1)])];
  const known = new Set<number>();
  records.forEach((r) => numbersIn(r.result, known));
  const texts = [
    `Under the old regime your tax is ${inr(OLD.totalTaxPaise)} ${cite}.`, "Under the old regime your tax is about 2.1 lakh.", "Half of it is ₹1,05,300.",
    "You have 4,500 rupees left and 3 regimes.", "one lakh twenty thousand rupees", "Choose the new regime.",
  ];
  for (const text of texts) {
    const a = answer(text, records, ["My salary is 15 lakh"]);
    for (const n of numbersIn(a.facts, new Set<number>(), ["round"])) assert.ok(known.has(n), `${text}: ${n} appears in the facts but in no tool result`);
  }
});

test("B3: the answer layer's source does arithmetic on no money value: only unit conversion of a written amount", () => {
  const source = fs.readFileSync(path.join(FRONTEND, "lib/assistant/answer.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.doesNotMatch(source, /Paise\b\s*[-+*/](?!=)\s*[\w(]|[\w)]\s*[-+*/]\s*[\w.]*Paise\b/, "no addition, subtraction, multiplication or division of a paise value");
  assert.doesNotMatch(source, /calculateTax|compareRegimes|scenarioDelta|tax-engine|parseTaxRequest/, "and no tax engine");
  assert.doesNotMatch(source, /Math\.(?:floor|ceil|trunc|max|min|pow)\b/, "no rounding to a nicer number: the only rounding is Math.round of a written amount to exact paise");
});

// --- B3b: an implicit regime recommendation ----------------------------------------------------------------------------------

test("B3b: choosing, preferring or 'saving money' with a regime is withheld in its usual forms", () => {
  const records = [compareRecord()];
  for (const text of [
    "Choose the new regime.", "You should choose the new regime.", "The new regime is better.", "New is better for you.", "Choosing new saves you money.",
    "Choosing the new regime would save you tax.", "The old regime is cheaper for you.", "Old is the better option.", "The new regime is more beneficial.",
    "You would save money under the new regime.", "The new regime saves you tax.", "The new regime works out cheaper.", "Opting for the old regime is advantageous.",
    "The old regime is preferable here.", "Going with the new regime pays off.",
    "The new regime is not costly and saves you tax.", // a negation before a clause break does not deny what follows it
  ]) {
    const a = answer(text, records);
    assert.ok(blocking(a).includes("regime_recommendation"), text);
    assert.equal(a.state, "withheld", text);
    assert.equal(a.text, null, text);
  }
});

test("B3b: neutral, factual comparison language is released", () => {
  const n = CMP.numbers as { oldTotalTaxPaise: number; newTotalTaxPaise: number; differencePaise: number };
  for (const text of [
    "The comparison shows a lower tax under the new regime than under the old regime.",
    `Under the old regime the computed tax is ${inr(n.oldTotalTaxPaise)} and under the new regime it is ${inr(n.newTotalTaxPaise)}; the difference is ${inr(n.differencePaise)}.`,
    "This does not say which regime is better, and I can't recommend one.", "Both regimes were computed on the same income; the new regime has no Chapter VI-A deductions.",
    "The tool does not choose a regime for anyone, so the decision is yours.", "The new regime is not better or worse: it is a different set of rules.", "I don't recommend one regime over the other.",
  ]) {
    assert.equal(blocking(answer(text, [compareRecord()])).includes("regime_recommendation"), false, text);
  }
});

test("B3b: a conclusion the PERSON supplied may be repeated; a question they asked, or anything else, may not", () => {
  const records = [compareRecord()];
  assert.equal(blocking(answer("You told me you want to choose the new regime, so here are its figures.", records, ["I have decided to choose the new regime."])).includes("regime_recommendation"), false);
  assert.equal(blocking(answer("You said the new regime is better for you.", records, ["I think the new regime is better for me."])).includes("regime_recommendation"), false);
  assert.ok(blocking(answer("Yes, choose the new regime.", records, ["Should I choose the new regime?"])).includes("regime_recommendation"), "a question is not a conclusion");
  assert.ok(blocking(answer("The old regime is better.", records, ["I have decided to choose the new regime."])).includes("regime_recommendation"), "a different conclusion is not licensed");
});
