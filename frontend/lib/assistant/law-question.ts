// Whether a person's question is about Indian income-tax LAW, so the orchestrator retrieves official evidence for it before the
// model is first called (services/assistant/orchestrator.ts, `evidenceFor`). PURE: no imports beyond the section-reference reader.
//
// A real 7B model, asked "What is Section 80D?", often answered from memory without calling search_tax_law, or called it and then
// called it again without a question; the answer layer withheld every such answer. Fetching the evidence first, through the same
// tool, removes that dependence on the model's tool use. It errs towards fetching: evidence a question did not need costs one tool
// call and is public guidance; evidence it needed and did not get costs the answer.
import { extractSectionRefs } from "../rag/corpus";

/** Words that only a tax-law question uses (a section, a deduction, a return, a statement, a regime rule). Whole words, any case. */
const TAX_LAW_TERMS =
  /\b(?:sections?|deductions?|deductible|exempt(?:ion|ions|ed)?|rebate|regimes?|slabs?|surcharge|cess|hra|house rent allowance|tds|tcs|ais|tis|itr(?:-?\d)?|income[- ]tax return|form\s?(?:16a?|26\s?as|12bb|15g|15h|10e|10ba|67)|26\s?as|annual information statement|advance tax|self[- ]assessment tax|standard deduction|capital gains?|chapter vi-?a|income[- ]tax act|assessment year|ppf|elss|nps|80[a-z]{0,4}|24\s?\(b\))\b/i;

export function isTaxLawQuestion(question: string): boolean {
  if (typeof question !== "string" || question.trim() === "") return false;
  return extractSectionRefs(question).length > 0 || TAX_LAW_TERMS.test(question);
}
