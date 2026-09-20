// The answer layer: it takes what the orchestrator produced (the model's final text, and the full results of the tools it
// called) and decides what may be released as an answer. PURE and provider-neutral: this file has no imports at all, so it
// has no database client, no session, no network, no provider name and no credential, and a test pins that.
//
//   model text + tool results (server-side) + the person's own words  ->  buildAnswer  ->  a frozen, typed Answer
//
// The invariant that everything else serves: TOOL FACTS and MODEL TEXT are different things. Facts (`facts`) are built only
// from validated tool results, copied verbatim and frozen; the model's text (`text`) is a separate field with origin
// "model". Nothing in the text can create, change or remove a fact. A text that breaks a safety rule is not released
// (`state: "withheld"`, `text: null`) but the facts still stand.
//
// What it does NOT do: any tax arithmetic (it READS an amount the text states, in the forms people write Indian amounts, and
// compares it by value with figures that were already present in a tool result, the person's words or a cited quote; the only
// arithmetic is placing that written amount on the rupee scale, and it never adds, subtracts, rounds or derives a figure), any
// authorization (it has no user), any retrieval, or any tool execution. It also cannot judge whether a sentence is TRUE: its
// checks are structural and phrase-based, deterministic, and deliberately conservative (see the limits in each check; where a
// call must fall one way it falls on withholding). They make an unsupported claim hard to release; they do not prove a released
// answer correct.

// ---------------------------------------------------------------------
// Vocabulary and contract
// ---------------------------------------------------------------------

export const ANSWER_TOOL_NAMES = [
  "search_tax_law",
  "query_transactions",
  "get_financial_summary",
  "calculate_tax",
  "compare_tax_regimes",
  "simulate_tax",
] as const;
export type AnswerToolName = (typeof ANSWER_TOOL_NAMES)[number];

export type AuthorityTier = "statute" | "notification_circular" | "official_guidance";
const TIER_RANK: Record<AuthorityTier, number> = { statute: 3, notification_circular: 2, official_guidance: 1 };
const isTier = (v: unknown): v is AuthorityTier => v === "statute" || v === "notification_circular" || v === "official_guidance";

export const MAX_ANSWER_CHARS = 20_000;
export const GUIDANCE_NOTICE = "The cited evidence is official guidance, not statute or circular text.";

/**
 * blocking: the text is not released. warning: recorded, the text is released.
 */
export const ANSWER_VIOLATION_CODES = [
  "invalid_tool_record",
  "invalid_tool_result",
  "conflicting_tool_results",
  "empty_text",
  "text_too_long",
  "impersonated_tool_output",
  "malformed_citation",
  "invented_evidence_id",
  "ungrounded_figure",
  "regime_unattributed",
  "regime_recommendation",
  "unsupported_deadline",
  "authority_upgrade",
  "law_claim_without_evidence",
  "uncited_law_claim",
] as const;
export type ViolationCode = (typeof ANSWER_VIOLATION_CODES)[number];
export type Violation = { code: ViolationCode; severity: "blocking" | "warning"; detail: string };

/**
 * answered               the text is released and no blocking rule was broken.
 * insufficient_evidence  tax-law retrieval refused and no evidence exists: no law claim is supported.
 * unsupported            an engine calculation was refused and no calculation succeeded.
 * withheld               the text broke a blocking rule; it is not released. The facts still stand.
 */
export type AnswerState = "answered" | "insufficient_evidence" | "unsupported" | "withheld";

type Provenance = { origin: "tool"; tool: AnswerToolName; callId: string; round: number };

export type EvidenceFact = Provenance & {
  kind: "evidence";
  evidenceId: string;
  sourceKey: string;
  title: string;
  publisher: string;
  url: string;
  authorityTier: AuthorityTier;
  sectionRef: string | null;
  quote: string;
  assessmentYear: string;
  effectiveFrom: string | null;
  retrievedAt: string;
  corpusVersion: string;
  verificationStatus: string;
};

/** A typed refusal exactly as the tool gave it: never worked around, never softened. */
export type RefusalFact = Provenance & { kind: "refusal"; reason: string; message: string; detail: Record<string, unknown> | null };

/** The engine's own result, verbatim. `payload` is the tool result content untouched; nothing here is computed. */
export type TaxValueFact = Provenance & {
  kind: "tax_value";
  shape: "single_regime" | "regime_comparison" | "scenario";
  assessmentYear: string;
  engineVersion: string | null;
  rulesVersion: string | null;
  payload: unknown;
  /** The tool's own notice (for a comparison: that it is not a recommendation), verbatim. */
  notice: string | null;
};

/** Deterministic ledger figures. Free text (descriptions, sources, category names) is never carried: see `omittedTextFields`. */
export type LedgerFact = Provenance & {
  kind: "ledger";
  shape: "transactions" | "summary";
  payload: Record<string, unknown>;
  omittedTextFields: string[];
  /** The tool's own notice that ledger text is data, never instructions, verbatim; null when the tool carried none. */
  notice: string | null;
};

export type Citation = { evidenceId: string; evidence: EvidenceFact };

export type Answer = {
  state: AnswerState;
  /** The model's explanation, or null when withheld. It is never the source of a figure, a citation or an authority. */
  text: { origin: "model"; content: string } | null;
  /** The evidence the text cites, resolved from the tools' evidence (never from the text), in order of first citation. */
  citations: Citation[];
  facts: { evidence: EvidenceFact[]; taxValues: TaxValueFact[]; ledger: LedgerFact[]; refusals: RefusalFact[] };
  /** Notices the tools carried (a comparison is not a recommendation; ledger text is data) and the guidance-only notice. */
  notices: string[];
  /** The highest authority the evidence actually has. Never upgraded. */
  authority: { highestTier: AuthorityTier | null; guidanceOnly: boolean };
  violations: Violation[];
};

export type ToolRecord = { round: number; callId: string; tool: string; result: unknown };
export type AnswerInput = {
  /** The model's final text. */
  text: string;
  /** The full result of every tool call in the run (see the orchestrator's onToolResult). */
  toolRecords: readonly ToolRecord[];
  /** The person's own words: a figure they stated may be repeated. */
  userMessages?: readonly string[];
};

export class AnswerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnswerInputError";
  }
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isPaise = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const clone = <T>(v: T): T => structuredClone(v);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as object)) deepFreeze(inner);
  }
  return value;
}

/** JSON with keys sorted at every level: a stable key for "the same thing". */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (isObj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

class Invalid extends Error {}
const invalid: (message: string) => never = (message) => {
  throw new Invalid(message);
};

// ---------------------------------------------------------------------
// Tool results -> facts (validated, copied, frozen later)
// ---------------------------------------------------------------------

const EVIDENCE_ID = /^ev_[0-9a-f]{16}$/;
const EVIDENCE_TEXT_FIELDS = ["evidenceId", "sourceKey", "title", "publisher", "url", "quote", "assessmentYear", "retrievedAt", "corpusVersion", "verificationStatus"] as const;

function readEvidence(raw: unknown, at: string, meta: { callId: string; round: number }): EvidenceFact {
  const e = isObj(raw) ? raw : invalid(`${at} is not an object.`);
  for (const field of EVIDENCE_TEXT_FIELDS) if (!isText(e[field])) invalid(`${at}.${field} must be text.`);
  if (!EVIDENCE_ID.test(e.evidenceId as string)) invalid(`${at}.evidenceId is not a well-formed evidence id.`);
  if (!isTier(e.authorityTier)) invalid(`${at}.authorityTier is not a known authority tier.`);
  if (e.sectionRef !== null && typeof e.sectionRef !== "string") invalid(`${at}.sectionRef must be text or null.`);
  if (e.effectiveFrom !== null && typeof e.effectiveFrom !== "string") invalid(`${at}.effectiveFrom must be text or null.`);
  return {
    origin: "tool", kind: "evidence", tool: "search_tax_law", callId: meta.callId, round: meta.round,
    evidenceId: e.evidenceId as string, sourceKey: e.sourceKey as string, title: e.title as string, publisher: e.publisher as string, url: e.url as string,
    authorityTier: e.authorityTier as AuthorityTier, sectionRef: e.sectionRef as string | null, quote: e.quote as string, assessmentYear: e.assessmentYear as string,
    effectiveFrom: e.effectiveFrom as string | null, retrievedAt: e.retrievedAt as string, corpusVersion: e.corpusVersion as string,
    verificationStatus: e.verificationStatus as string,
  };
}

type TaxResultLite = { regime: "old" | "new"; year: string; ageCategory: string; gross: number; deductions: string; total: number; taxable: number; engine: string; rules: string };

/** The shape of an engine result. It checks that the paise are exact integers and the identifying fields agree; it computes nothing. */
function checkTaxResult(raw: unknown, at: string): TaxResultLite {
  const r = isObj(raw) ? raw : invalid(`${at} is not an object.`);
  if (r.regime !== "old" && r.regime !== "new") invalid(`${at}.regime is not old or new.`);
  for (const field of ["engineVersion", "rulesVersion", "assessmentYearLabel", "ageCategory"] as const) if (!isText(r[field])) invalid(`${at}.${field} is missing.`);
  for (const field of ["grossTotalIncomePaise", "totalDeductionsPaise", "taxableIncomePaise", "taxBeforeRebatePaise", "rebatePaise", "surchargePaise", "cessPaise", "totalTaxPaise"] as const) {
    if (!isCount(r[field])) invalid(`${at}.${field} must be a whole, non-negative number of paise.`);
  }
  if (!Array.isArray(r.deductionAdjustments)) invalid(`${at}.deductionAdjustments is missing.`);
  if (!isObj(r.tree) || !isObj(r.taxableIncomeTree)) invalid(`${at} has no computation trees.`);
  return {
    regime: r.regime as "old" | "new", year: r.assessmentYearLabel as string, ageCategory: r.ageCategory as string, gross: r.grossTotalIncomePaise as number,
    deductions: canon(r.deductionAdjustments), total: r.totalTaxPaise as number, taxable: r.taxableIncomePaise as number, engine: r.engineVersion as string, rules: r.rulesVersion as string,
  };
}

type Parsed =
  | { kind: "evidence"; facts: EvidenceFact[] }
  | { kind: "tax"; fact: TaxValueFact; results: TaxResultLite[]; scenarioKeys: Array<{ key: string; value: string }>; refusals: RefusalFact[] }
  | { kind: "ledger"; fact: LedgerFact };

function parseOk(tool: AnswerToolName, result: unknown, meta: { callId: string; round: number }): Parsed {
  const r = isObj(result) ? result : invalid("The result is not an object.");
  const provenance = { origin: "tool" as const, tool, callId: meta.callId, round: meta.round };

  if (tool === "search_tax_law") {
    if (!Array.isArray(r.evidence)) invalid("The evidence is not a list.");
    return { kind: "evidence", facts: (r.evidence as unknown[]).map((item, i) => readEvidence(item, `evidence[${i}]`, meta)) };
  }

  if (tool === "calculate_tax") {
    const lite = checkTaxResult(r.result, "result");
    if (r.regime !== lite.regime) invalid("The regime asked for and the regime computed differ.");
    if (r.assessmentYear !== lite.year) invalid("The assessment year asked for and the one computed differ.");
    if (!isObj(r.input)) invalid("The validated input is missing.");
    const fact: TaxValueFact = { ...provenance, kind: "tax_value", shape: "single_regime", assessmentYear: lite.year, engineVersion: lite.engine, rulesVersion: lite.rules, payload: clone(r), notice: null };
    return { kind: "tax", fact, results: [lite], scenarioKeys: [{ key: `${lite.year}|${lite.regime}|${canon(r.input)}`, value: canon([lite.total, lite.taxable, lite.engine, lite.rules]) }], refusals: [] };
  }

  if (tool === "compare_tax_regimes") {
    if (!isText(r.notice)) invalid("The comparison has no notice: it must carry that it is not a recommendation.");
    const year = (isObj(r.assessmentYear) && isText(r.assessmentYear.label) ? r.assessmentYear.label : invalid("The assessment year is missing.")) as string;
    const c = isObj(r.comparison) ? r.comparison : invalid("The comparison is missing.");
    const results: TaxResultLite[] = [];
    const refusals: RefusalFact[] = [];
    for (const regime of ["old", "new"] as const) {
      const outcome = isObj(c[regime]) ? (c[regime] as Obj) : invalid(`The ${regime} regime outcome is missing.`);
      if (outcome.status === "ok") {
        const lite = checkTaxResult(outcome.result, `comparison.${regime}.result`);
        if (lite.regime !== regime) invalid(`comparison.${regime} holds a ${lite.regime}-regime result.`);
        if (lite.year !== year) invalid(`comparison.${regime} is for a different assessment year.`);
        results.push(lite);
      } else if (outcome.status === "refused" && isObj(outcome.refusal) && isText(outcome.refusal.message) && isText(outcome.refusal.kind)) {
        refusals.push({ ...provenance, kind: "refusal", reason: outcome.refusal.kind as string, message: outcome.refusal.message as string, detail: { regime } });
      } else invalid(`The ${regime} regime outcome is neither a result nor a refusal.`);
    }
    // The numbers summarise the two results; they must be the same figures, or the comparison is not trustworthy.
    const oldResult = results.find((x) => x.regime === "old");
    const newResult = results.find((x) => x.regime === "new");
    if (c.numbers === null) {
      if (oldResult && newResult) invalid("Both regimes have results but the comparison numbers are missing.");
    } else {
      const n = isObj(c.numbers) ? c.numbers : invalid("The comparison numbers are malformed.");
      if (!oldResult || !newResult) invalid("Comparison numbers exist although a regime has no result.");
      for (const field of ["oldTotalTaxPaise", "newTotalTaxPaise", "differencePaise"] as const) if (!isCount(n[field])) invalid(`comparison.numbers.${field} must be a whole number of paise.`);
      if (n.oldTotalTaxPaise !== oldResult?.total || n.newTotalTaxPaise !== newResult?.total) invalid("The comparison numbers do not match the results they summarise.");
      if (n.lowerTaxRegime !== "old" && n.lowerTaxRegime !== "new" && n.lowerTaxRegime !== "equal") invalid("comparison.numbers.lowerTaxRegime is not old, new or equal.");
    }
    const first = results[0];
    const fact: TaxValueFact = {
      ...provenance, kind: "tax_value", shape: "regime_comparison", assessmentYear: year, engineVersion: first?.engine ?? null, rulesVersion: first?.rules ?? null,
      payload: clone(r), notice: r.notice as string,
    };
    return { kind: "tax", fact, results, scenarioKeys: [], refusals };
  }

  if (tool === "simulate_tax") {
    if (r.regime !== "old" && r.regime !== "new") invalid("The regime is missing.");
    const d = isObj(r.delta) ? r.delta : invalid("The delta is missing.");
    for (const field of ["assessmentYearLabel", "engineVersion", "rulesVersion"] as const) if (!isText(d[field])) invalid(`delta.${field} is missing.`);
    if (d.regime !== r.regime) invalid("The delta is for a different regime.");
    const base = isObj(d.base) ? d.base : invalid("delta.base is missing.");
    const scenario = isObj(d.scenario) ? d.scenario : invalid("delta.scenario is missing.");
    for (const [name, side] of [["base", base], ["scenario", scenario]] as const) {
      for (const field of ["totalTaxPaise", "taxableIncomePaise"] as const) if (!isCount(side[field])) invalid(`delta.${name}.${field} must be a whole, non-negative number of paise.`);
    }
    const change = isObj(d.change) ? d.change : invalid("delta.change is missing.");
    for (const field of ["totalTaxPaise", "taxableIncomePaise", "totalDeductionsPaise", "rebatePaise", "surchargePaise", "cessPaise"] as const) if (!isPaise(change[field])) invalid(`delta.change.${field} must be a whole number of paise.`);
    const baseInput = isObj(r.base) && isObj(r.base.input) ? r.base.input : invalid("base.input is missing.");
    const scenarioInput = isObj(r.scenario) && isObj(r.scenario.input) ? r.scenario.input : invalid("scenario.input is missing.");
    const year = d.assessmentYearLabel as string;
    const engine = d.engineVersion as string;
    const rules = d.rulesVersion as string;
    const fact: TaxValueFact = { ...provenance, kind: "tax_value", shape: "scenario", assessmentYear: year, engineVersion: engine, rulesVersion: rules, payload: clone(r), notice: null };
    const results: TaxResultLite[] = [];
    // The two totals, for the tax-total checks. Only the totals and versions are known, so the keys are the request inputs.
    return {
      kind: "tax", fact, results, refusals: [],
      scenarioKeys: [
        { key: `${year}|${r.regime}|${canon(baseInput)}`, value: canon([base.totalTaxPaise, base.taxableIncomePaise, engine, rules]) },
        { key: `${year}|${r.regime}|${canon(scenarioInput)}`, value: canon([scenario.totalTaxPaise, scenario.taxableIncomePaise, engine, rules]) },
      ],
    };
  }

  if (tool === "query_transactions") {
    const totals = isObj(r.totals) ? r.totals : invalid("The totals are missing.");
    if (!isCount(totals.incomePaise) || !isCount(totals.expensePaise)) invalid("The totals must be whole numbers of paise.");
    for (const field of ["matched", "returned"] as const) if (!isCount(r[field])) invalid(`${field} must be a count.`);
    if (!isObj(r.filter) || !Array.isArray(r.transactions)) invalid("The filter or the rows are missing.");
    const payload = clone({
      filter: r.filter, descriptionsIncluded: r.descriptionsIncluded, matched: r.matched, returned: r.returned, truncated: r.truncated,
      fieldsTruncated: r.fieldsTruncated, totals: r.totals,
    }) as Obj;
    return { kind: "ledger", fact: { ...provenance, kind: "ledger", shape: "transactions", payload, omittedTextFields: ["transactions[].description", "transactions[].category", "transactions[].source"], notice: isText(r.dataNotice) ? r.dataNotice : null } };
  }

  // get_financial_summary
  for (const field of ["incomePaise", "expensePaise"] as const) if (!isCount(r[field])) invalid(`${field} must be a whole, non-negative number of paise.`);
  if (!isPaise(r.savingsPaise) || !isCount(r.transactionCount) || !isObj(r.period) || !Array.isArray(r.categories)) invalid("The summary is malformed.");
  const categories = (r.categories as unknown[]).map((c) => {
    const cat = isObj(c) ? c : invalid("A category row is malformed.");
    if (!isCount(cat.totalPaise)) invalid("A category total must be whole paise.");
    // The name is user text: it is left out. Only the deterministic figures stay.
    return { totalPaise: cat.totalPaise, sharePercent: cat.sharePercent, isRemainder: cat.isRemainder };
  });
  const payload = clone({
    period: r.period, periodIsDefault: r.periodIsDefault, transactionCount: r.transactionCount, incomePaise: r.incomePaise, expensePaise: r.expensePaise,
    savingsPaise: r.savingsPaise, savingsRatePercent: r.savingsRatePercent, range: r.range, months: r.months, monthsTruncated: r.monthsTruncated, categories,
  }) as Obj;
  return { kind: "ledger", fact: { ...provenance, kind: "ledger", shape: "summary", payload, omittedTextFields: ["categories[].category"], notice: null } };
}

/** Every paise value anywhere in a validated result (a key ending in "Paise"), plus its size when negative. */
function collectPaise(value: unknown, into: Set<number>): void {
  if (Array.isArray(value)) for (const item of value) collectPaise(item, into);
  else if (isObj(value)) {
    for (const [key, inner] of Object.entries(value)) {
      if (key.endsWith("Paise") && isPaise(inner)) {
        into.add(inner);
        into.add(Math.abs(inner));
      } else collectPaise(inner, into);
    }
  }
}

// ---------------------------------------------------------------------
// Reading figures out of text
// ---------------------------------------------------------------------

type Figure = { text: string; paise: number; material: boolean };

// A written amount is READ the way a person writes it and then compared with figures that are already present (a tool result,
// the person's own words, a cited quote). It is never used to compute anything: the only arithmetic is placing a written
// amount's own words on the rupee scale ("1.2 lakh" is 120,000; "one lakh twenty thousand" is 120,000), and no figure is ever
// derived from another one. Forms read: digits with an optional ₹ / Rs / INR marker or a "rupees" suffix, a lakh / crore /
// thousand magnitude, and amounts written in words. A bare number is an amount when it is written with digit groups (4,500) or
// has four or more digits, unless it is a year, a percentage, a count ("1,200 transactions") or part of a code ("80C").
const UNIT_WORDS = new Map<string, number>(Object.entries({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}));
const TENS_WORDS = new Map<string, number>(Object.entries({ twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }));
const MAGNITUDES = new Map<string, number>(Object.entries({ thousand: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000, cr: 10_000_000 }));
const PIECE = /(₹|\bRs\b\.?|\bINR\b)|(\d[\d,]*(?:\.\d+)?)|([A-Za-z]+)/gi;
const COUNT_NOUN = /^(?:transactions?|rows?|entries|entry|records?|items?|days?|months?|years?|categories|category|times|people|persons?|accounts?|sources?|sections?|pages?|documents?|files?|minutes?|hours?|weeks?|passages?|figures?|results?)$/;
const MONTH_BEFORE_YEAR = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?,?\\s+";
const YEAR_BEFORE = new RegExp(`(?:[/-]\\s*|\\b(?:AY|A\\.Y\\.|FY|F\\.Y\\.|years?|in|of|since|until|till|during|before|after|from|to|by|between|for|and)\\s+|\\b${MONTH_BEFORE_YEAR}|\\b\\d{1,2}(?:st|nd|rd|th)?,?\\s+)$`, "i");
const YEAR_AFTER = /^\s*(?:[-/–]\s*\d|(?:assessment|financial|tax|previous)\s+year\b|AY\b|FY\b|year\b)/i;

type Piece = { marker: boolean; digits: string | undefined; word: string | undefined; start: number; end: number };
type Kind = "start" | "literal" | "unit" | "tens" | "hundred" | "magnitude" | "and";
type Amount = { rupees: number; last: number; hasMagnitude: boolean; hasWords: boolean; literal: string | null };

/** One written amount that starts at token `from`, or null when a number does not start there. */
function readAmount(pieces: Piece[], from: number, gap: (a: Piece, b: Piece) => boolean): Amount | null {
  const first = pieces[from];
  const next = pieces[from + 1];
  const startsWithA = first.word === "a" && next !== undefined && gap(first, next) && (MAGNITUDES.has(next.word ?? "") || next.word === "hundred");
  const startsAmount = first.digits !== undefined || startsWithA || (first.word !== undefined && (UNIT_WORDS.has(first.word) || TENS_WORDS.has(first.word) || first.word === "hundred"));
  if (!startsAmount) return null;

  let total = 0;
  let current = 0;
  let previous: Kind = "start";
  const read: Amount = { rupees: 0, last: from, hasMagnitude: false, hasWords: false, literal: null };
  for (let j = from; j < pieces.length; j += 1) {
    const t = pieces[j];
    if (j > from && !gap(pieces[j - 1], t)) break;
    const w = t.word;
    const kind: Kind | null = t.digits !== undefined ? "literal" : w === "a" ? "unit" : w === undefined ? null
      : UNIT_WORDS.has(w) ? "unit" : TENS_WORDS.has(w) ? "tens" : w === "hundred" ? "hundred" : MAGNITUDES.has(w) ? "magnitude" : w === "and" ? "and" : null;
    if (kind === null || (w === "a" && j !== from)) break;

    const startsGroup = previous === "start" || previous === "magnitude" || previous === "and";
    if (kind === "literal" && !startsGroup) break;
    if (kind === "unit" && !(startsGroup || previous === "hundred" || (previous === "tens" && (UNIT_WORDS.get(w as string) ?? 10) < 10))) break;
    if (kind === "tens" && !(startsGroup || previous === "hundred")) break;
    if (kind === "hundred" && !(previous === "start" || previous === "literal" || previous === "unit" || previous === "tens")) break;
    if (kind === "magnitude" && !(previous === "literal" || previous === "unit" || previous === "tens" || previous === "hundred")) break;
    if (kind === "and") {
      const after = pieces[j + 1];
      const numberNext = after !== undefined && gap(t, after) && (after.digits !== undefined || UNIT_WORDS.has(after.word ?? "") || TENS_WORDS.has(after.word ?? ""));
      if (!(previous === "hundred" || previous === "magnitude") || !numberNext) break;
    }

    if (kind === "literal") {
      const value = Number.parseFloat((t.digits as string).replace(/,+$/, "").replace(/,/g, ""));
      if (!Number.isFinite(value)) break;
      current = value;
      read.literal ??= t.digits as string;
    } else if (kind === "unit") current += w === "a" ? 1 : (UNIT_WORDS.get(w as string) as number);
    else if (kind === "tens") current += TENS_WORDS.get(w as string) as number;
    else if (kind === "hundred") current = (current || 1) * 100;
    else if (kind === "magnitude") {
      total += (current || 1) * (MAGNITUDES.get(w as string) as number);
      current = 0;
      read.hasMagnitude = true;
    }
    if (kind !== "literal" && kind !== "and") read.hasWords = true;
    previous = kind;
    read.last = j;
  }
  read.rupees = total + current;
  return read;
}

function looksLikeYear(text: string, start: number, end: number, whole: string): boolean {
  const value = Number(whole);
  if (whole.length !== 4 || value < 1900 || value > 2100) return false;
  return YEAR_BEFORE.test(text.slice(start > 30 ? start - 30 : 0, start)) || YEAR_AFTER.test(text.slice(end, end + 30));
}

/** A number with no ₹, Rs, INR, "rupees" or magnitude: an amount only if written with digit groups or four digits, and not a year, a percentage, a count or a code. */
function looksLikeBareAmount(text: string, start: Piece, end: Piece, next: Piece | undefined, literal: string): boolean {
  const digits = literal.replace(/,+$/, "");
  const whole = digits.split(".")[0].replace(/,/g, "");
  const grouped = digits.includes(",");
  if (!grouped && whole.length < 4) return false;
  if (/^(?:[A-Za-z_]|\s*(?:%|per\s*cent\b|percent\b))/i.test(text.slice(end.end))) return false;
  if (start.start > 0 && /[A-Za-z_]/.test(text[start.start - 1])) return false;
  if (next?.word !== undefined && COUNT_NOUN.test(next.word) && /^\s*$/.test(text.slice(end.end, next.start))) return false;
  return grouped || !looksLikeYear(text, start.start, end.end, whole);
}

/** Every amount written in a text, as exact paise ("₹12 lakh" is 1,200,000 rupees). Reading only: no tax figure is ever derived. */
function figuresIn(text: string): Figure[] {
  const pieces: Piece[] = [...text.matchAll(PIECE)].map((m) => ({
    marker: m[1] !== undefined, digits: m[2], word: m[3]?.toLowerCase(), start: m.index as number, end: (m.index as number) + m[0].length,
  }));
  const gap = (a: Piece, b: Piece) => /^[\s-]*$/.test(text.slice(a.end, b.start));
  const found: Figure[] = [];
  let i = 0;
  while (i < pieces.length) {
    const read = readAmount(pieces, i, gap);
    if (read === null) {
      i += 1;
      continue;
    }
    const start = pieces[i];
    const end = pieces[read.last];
    const before = pieces[i - 1];
    const after = pieces[read.last + 1];
    const markerBefore = before?.marker === true && /^[\s.]*$/.test(text.slice(before.end, start.start));
    const suffix = after !== undefined && /^\s*$/.test(text.slice(end.end, after.start)) && (after.marker || (after.word !== undefined && /^rupees?$/.test(after.word)));
    const paise = Math.round(read.rupees * 100);
    if (Number.isSafeInteger(paise)) {
      const material = markerBefore || suffix || read.hasMagnitude || (read.literal !== null && !read.hasWords && looksLikeBareAmount(text, start, end, after, read.literal));
      found.push({ text: text.slice(markerBefore ? before.start : start.start, suffix ? (after as Piece).end : end.end).trim().slice(0, 40), paise, material });
    }
    i = read.last + 1;
  }
  return found;
}

// ---------------------------------------------------------------------
// Reading claims out of text
// ---------------------------------------------------------------------

const CITATION = /\[(ev_[0-9a-f]{16})\]/g;
const EVIDENCE_REF = /\bev_\w*/gi;
const IMPERSONATION = /"(?:totalTaxPaise|taxableIncomePaise|evidenceId|authorityTier|rulesVersion|engineVersion|verificationStatus)"\s*:/;

/** Straight apostrophes, so "can't" is one thing. */
const normalize = (text: string) => text.replace(/[‘’]/g, "'");
// Not after an abbreviation: "Circular No. 13/2025" and "Rs. 5,000" stay in one sentence.
const sentencesOf = (text: string) => text.split(/(?<!\b(?:No|Nos|Rs|Sec|Ref|vs|Dr|Mr|Mrs|Ms|approx)\.)(?<=[.!?])\s+|\n+/i).map((s) => s.trim()).filter(Boolean);

// A negation licenses a claim ONLY when it is attached to it: in the same clause, before the claim, with at most a few words
// between (see `denied`). A negation elsewhere in the sentence ("This is not guidance, the statute says...") licenses nothing.
// Where a wrong call has to fall one way, it falls on WITHHOLDING: an honest sentence phrased around the pattern is refused
// rather than a dishonest one released.
const NEGATION_WINDOW_WORDS = 6;
const CLAUSE_BREAK = /[,;:()—–]|\s-\s|\b(?:but|however|although|though|yet|and|so|because|whereas|while|then)\b/i;
/** Any negation: enough to say "this is NOT statute text". Licenses an authority claim, or a regime phrase. */
const ANY_NEGATION = /\b(?:not|no|never|neither|nor|cannot|can't|can\s+not|couldn't|could\s+not|unable|won't|will\s+not|don't|do\s+not|doesn't|does\s+not|isn't|is\s+not|without|unsupported|insufficient)\b/gi;
/** Only a statement of what the ASSISTANT cannot say or has no source for. Licenses a date or an uncited law claim. */
const REFUSAL = /\b(?:cannot|can't|can\s+not|couldn't|could\s+not|unable|not\s+able|won't|will\s+not|don't\s+have|do\s+not\s+have|have\s+no|has\s+no|there\s+is\s+no|there's\s+no|no\s+evidence|no\s+sources?|not\s+found|without|unsupported|insufficient)\b/gi;

/** Whether a cue sits right before `index` in the same clause: the only way a negation licenses what follows it. */
function denied(sentence: string, index: number, cues: RegExp): boolean {
  const before = sentence.slice(0, index);
  let cue: RegExpMatchArray | null = null;
  for (const m of before.matchAll(cues)) cue = m;
  if (cue === null || cue.index === undefined) return false;
  const between = before.slice(cue.index + cue[0].length);
  return !CLAUSE_BREAK.test(between) && between.trim().split(/\s+/).filter(Boolean).length <= NEGATION_WINDOW_WORDS;
}
const hasNegation = (span: string) => span.match(ANY_NEGATION) !== null;

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b";
const MONTH_NOT_MAY = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b";
const DATE_MENTION = new RegExp(
  `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:\\s+\\d{4})?|\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?|\\b${MONTH}\\.?\\s+\\d{4}\\b|\\b\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}\\b|\\b(?:by|before|on|end\\s+of)\\s+(?:the\\s+)?(?:end\\s+of\\s+)?${MONTH_NOT_MAY}`,
  "gi",
);
const DEADLINE_WORD = /\b(?:deadline|due\s+date|last\s+date|filing\s+date|due\s+on|due\s+by|due\s+before|file[^.]{0,40}\b(?:by|before)\b)/i;

// What counts as recommending a regime, EXPLICITLY or by implication ("new is better", "choosing new saves you money").
// A neutral comparison ("a lower tax under the new regime than under the old regime") is not any of these. A phrase the PERSON
// wrote themselves may be repeated (see `personSaid`); a question they asked is not a conclusion.
const BENEFIT = "saves?|cheaper|beneficial|advantageous|favou?rable|preferable|economical|tax[- ]efficient|better|best|wiser|smarter";
const REGIME_SELECTION: Array<{ pattern: RegExp; negatable: boolean }> = [
  { pattern: /\byou(?:'d|\s+would|\s+should|\s+must|\s+ought\s+to|\s+need\s+to|\s+can\s+choose)\b[^.]{0,40}\b(?:choose|pick|select|opt\s+for|go\s+with|use|switch\s+to|stay\s+(?:with|in)|be\s+better\s+off)\b/gi, negatable: false },
  { pattern: /\b(?:go\s+with|switch\s+to|opt\s+for|choose|pick|select)\s+(?:the\s+)?(?:old|new)(?:\s+tax)?\s+regime\b/gi, negatable: false },
  { pattern: /\b(?:old|new)(?:\s+tax)?\s+regime\s+(?:is|would\s+be|seems|looks|appears|might\s+be)\s+(?:the\s+|a\s+)?(?:clearly\s+)?(?:better|best|right|ideal|preferable|cheaper|more\s+(?:beneficial|economical|favou?rable|tax[- ]efficient)|advantageous|smarter|wiser)\b/gi, negatable: false },
  { pattern: /\bi\s+(?:would\s+)?(?:recommend|suggest|advise|propose)\b/gi, negatable: true },
  { pattern: /\bbetter\s+(?:off|choice|option)\b|\bbest\s+(?:regime|option|choice)\b|\b(?:recommend|suggest)(?:ed|ation)?\b[^.]{0,30}\bregime\b/gi, negatable: true },
  // "Choosing new saves you money", "Going with the new regime pays off": picking a regime and a benefit in one breath.
  { pattern: /\b(?:choosing|picking|selecting|opting\s+for|going\s+with|switching\s+to|staying\s+(?:with|in))\s+(?:the\s+)?(?:old|new)\b(?:\s+tax)?(?:\s+regime)?[^.]{0,50}?\b(?:saves?|saving|cheaper|lower|less|reduces?|benefit(?:s|ficial)?|advantage(?:ous)?|better|best|worth|wise|smart|pays?\s+off)\b/gi, negatable: false },
  // "New is better", "Old is the cheaper option": the regime named without the word "regime".
  { pattern: /\b(?:old|new)\s+(?:is|would\s+be|will\s+be)\s+(?:the\s+|a\s+)?(?:clearly\s+|much\s+|far\s+)?(?:better|best|cheaper|preferable)\b/gi, negatable: false },
  // A regime and a benefit word in one sentence, either order: "The new regime saves you tax", "You would save money under the new regime".
  { pattern: new RegExp(`\\b(?:old|new)(?:\\s+tax)?\\s+regime\\b[^.]{0,60}?\\b(?:${BENEFIT})\\b|\\b(?:${BENEFIT})\\b[^.]{0,60}?\\b(?:old|new)(?:\\s+tax)?\\s+regime\\b`, "gi"), negatable: true },
];
const REGIME_WORD = /\b(?:old|new)\s+(?:tax\s+)?regime\b/i;

const STATUTE_CLAIM = [
  /\baccording\s+to\s+(?:the\s+)?(?:income[\s-]?tax\s+)?act\b/gi,
  /\bas\s+per\s+(?:the\s+)?(?:income[\s-]?tax\s+)?act\b/gi,
  /\bthe\s+(?:income[\s-]?tax\s+)?act\s+(?:says|states|provides|prescribes|defines|reads|specifies)\b/gi,
  /\b(?:statute|statutory)\s+(?:says|states|provides|text|wording|provision|language)\b/gi,
];
const CIRCULAR_CLAIM = [
  /\b(?:cbdt\s+)?(?:circular|notification)\s+(?:no\.?\s*[\d/-]+\s+)?(?:says|states|provides|clarifies|specifies)\b/gi,
  /\baccording\s+to\s+(?:the\s+|cbdt\s+)*(?:circular|notification)\b/gi,
  /\bas\s+per\s+(?:the\s+|cbdt\s+)*(?:circular|notification)\b/gi,
  /\b(?:cbdt\s+)?circular\s+no\.?\s*\d/gi,
];
/** Whether a sentence makes one of these claims that no negation right before it denies. */
const claimsAny = (sentence: string, patterns: RegExp[]) =>
  patterns.some((pattern) => [...sentence.matchAll(pattern)].some((m) => !denied(sentence, m.index as number, ANY_NEGATION)));

const SECTION_KEYWORD = /\b(?:section|sec\.?|u\/s)\s*\d{1,3}[A-Za-z]{0,4}/i;
const SECTION_BARE = /(?<![A-Za-z0-9])\d{2,3}[A-Z]{1,4}(?:\([A-Za-z0-9]{1,4}\))*(?![A-Za-z0-9])/;
const LAW_VERB = /\b(?:allows?|allowed|permits?|permitted|provides?|provided|states?|says?|requires?|required|eligible|eligibility|entitled|entitles?|applies|apply|applicable|maximum|limit|rebate|exempt|covers?|covered|defines?|prescribes?|under\s+section|according\s+to|as\s+per)\b/gi;

// ---------------------------------------------------------------------
// buildAnswer
// ---------------------------------------------------------------------

export function buildAnswer(input: AnswerInput): Answer {
  if (!isObj(input) || typeof input.text !== "string" || !Array.isArray(input.toolRecords)) {
    throw new AnswerInputError("An answer input needs the model's text (a string) and the tool records (a list).");
  }
  if (input.userMessages !== undefined && !(Array.isArray(input.userMessages) && input.userMessages.every((m) => typeof m === "string"))) {
    throw new AnswerInputError("userMessages must be a list of strings.");
  }

  const violations: Violation[] = [];
  const flag = (code: ViolationCode, severity: Violation["severity"], detail: string) => {
    if (!violations.some((v) => v.code === code && v.detail === detail)) violations.push({ code, severity, detail });
  };

  // --- 1. tool results -> facts ------------------------------------------------------------------
  const evidenceById = new Map<string, EvidenceFact>();
  const evidence: EvidenceFact[] = [];
  const taxValues: TaxValueFact[] = [];
  const ledger: LedgerFact[] = [];
  const refusals: RefusalFact[] = [];
  const allowedPaise = new Set<number>();
  const taxTotals = new Set<number>();
  const scenarioSeen = new Map<string, string>();
  const resultSeen = new Map<string, string>();
  let conflicting = false;
  const noteScenario = (key: string, value: string) => {
    const before = scenarioSeen.get(key);
    if (before !== undefined && before !== value) conflicting = true;
    scenarioSeen.set(key, value);
  };

  input.toolRecords.forEach((record, index) => {
    const at = `toolRecords[${index}]`;
    if (!isObj(record) || !Number.isSafeInteger(record.round) || (record.round as number) < 1 || !isText(record.callId) || (record.callId as string).length > 128
      || !(ANSWER_TOOL_NAMES as readonly string[]).includes(record.tool as string)) {
      flag("invalid_tool_record", "blocking", `${at} is not a tool call record of a known tool.`);
      return;
    }
    const tool = record.tool as AnswerToolName;
    const meta = { callId: record.callId as string, round: record.round as number };
    const envelope = record.result;
    if (!isObj(envelope) || envelope.tool !== tool || (envelope.status !== "ok" && envelope.status !== "refused")) {
      flag("invalid_tool_record", "blocking", `${at} (${tool}): the result is not a well-formed tool envelope.`);
      return;
    }

    if (envelope.status === "refused") {
      if (!isText(envelope.reason) || typeof envelope.message !== "string" || (envelope.detail !== undefined && !isObj(envelope.detail))) {
        flag("invalid_tool_record", "blocking", `${at} (${tool}): the refusal is malformed.`);
        return;
      }
      refusals.push({ origin: "tool", tool, callId: meta.callId, round: meta.round, kind: "refusal", reason: envelope.reason, message: envelope.message, detail: isObj(envelope.detail) ? clone(envelope.detail) : null });
      return;
    }

    let parsed: Parsed;
    try {
      parsed = parseOk(tool, envelope.result, meta);
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      flag("invalid_tool_result", "blocking", `${at} (${tool}): ${error.message}`);
      return;
    }

    collectPaise(envelope.result, allowedPaise);
    if (parsed.kind === "evidence") {
      for (const fact of parsed.facts) {
        const seen = evidenceById.get(fact.evidenceId);
        if (seen === undefined) {
          evidenceById.set(fact.evidenceId, fact);
          evidence.push(fact);
        } else {
          const content = (f: EvidenceFact) => canon({ ...f, callId: null, round: null });
          if (content(seen) !== content(fact)) flag("conflicting_tool_results", "blocking", `Evidence ${fact.evidenceId} was returned twice with different content.`);
        }
      }
    } else if (parsed.kind === "ledger") {
      ledger.push(parsed.fact);
    } else {
      taxValues.push(parsed.fact);
      refusals.push(...parsed.refusals);
      for (const lite of parsed.results) {
        taxTotals.add(lite.total);
        const key = `${lite.year}|${lite.regime}|${lite.ageCategory}|${lite.gross}|${lite.deductions}`;
        const value = canon([lite.total, lite.taxable, lite.engine, lite.rules]);
        const before = resultSeen.get(key);
        if (before !== undefined && before !== value) conflicting = true;
        resultSeen.set(key, value);
      }
      for (const { key, value } of parsed.scenarioKeys) noteScenario(key, value);
      if (parsed.fact.shape === "scenario") {
        const delta = (parsed.fact.payload as { delta: { base: { totalTaxPaise: number }; scenario: { totalTaxPaise: number } } }).delta;
        taxTotals.add(delta.base.totalTaxPaise);
        taxTotals.add(delta.scenario.totalTaxPaise);
      }
    }
  });
  // Two results that describe the same calculation (the same year, regime and income, or the same request echo) must agree.
  if (conflicting) flag("conflicting_tool_results", "blocking", "Tool results for the same calculation disagree.");

  // --- 2. the model's text --------------------------------------------------------------------------
  const rawText = input.text.trim();
  const text = normalize(rawText);
  if (rawText === "") flag("empty_text", "blocking", "The model produced no text.");
  if (input.text.length > MAX_ANSWER_CHARS) flag("text_too_long", "blocking", `The text is longer than ${MAX_ANSWER_CHARS} characters.`);
  if (IMPERSONATION.test(text)) flag("impersonated_tool_output", "blocking", "The text contains structured fields that only a tool result may carry.");

  // Citations: exactly [ev_ + 16 hex], each one of THIS run's evidence.
  const cited: string[] = [];
  for (const m of text.matchAll(CITATION)) if (!cited.includes(m[1])) cited.push(m[1]);
  for (const stray of text.replace(CITATION, "").match(EVIDENCE_REF) ?? []) flag("malformed_citation", "blocking", `"${stray.slice(0, 40)}" looks like an evidence reference but is not a well-formed [ev_...] citation.`);
  for (const id of cited) if (!evidenceById.has(id)) flag("invented_evidence_id", "blocking", `${id} is not evidence any tool returned in this run.`);

  // Figures: a material figure must be one a tool returned, the person stated, or a cited quote contains.
  const scrubbed = text.replace(CITATION, " ").replace(EVIDENCE_REF, " ");
  for (const f of evidence) for (const n of figuresIn(f.quote)) allowedPaise.add(n.paise);
  for (const message of input.userMessages ?? []) for (const n of figuresIn(normalize(message))) allowedPaise.add(n.paise);
  const textFigures = figuresIn(scrubbed).filter((f) => f.material);
  for (const f of textFigures) if (!allowedPaise.has(f.paise)) flag("ungrounded_figure", "blocking", `"${f.text}" is not a figure any tool returned, the person stated, or a cited passage contains.`);
  if (textFigures.some((f) => taxTotals.has(f.paise)) && !REGIME_WORD.test(text)) {
    flag("regime_unattributed", "blocking", "A tax total is stated without saying which regime it is for.");
  }

  // Sentence-level rules.
  const tiers = new Set(evidence.map((e) => e.authorityTier));
  const quotes = evidence.map((e) => e.quote.toLowerCase().replace(/\s+/g, " "));
  // What the PERSON stated (not what they asked): a regime conclusion in these words may be repeated back to them.
  const stated = (input.userMessages ?? []).flatMap((message) => sentencesOf(normalize(message))).filter((s) => !s.includes("?")).map((s) => s.toLowerCase().replace(/\s+/g, " "));
  const personSaid = (phrase: string) => {
    const wanted = phrase.toLowerCase().replace(/\s+/g, " ").trim();
    return wanted.length >= 8 && stated.some((s) => s.includes(wanted));
  };

  for (const sentence of sentencesOf(text)) {
    let recommends = false;
    for (const { pattern, negatable } of REGIME_SELECTION) {
      for (const m of sentence.matchAll(pattern)) {
        const denies = negatable && (denied(sentence, m.index as number, ANY_NEGATION) || (hasNegation(m[0]) && !CLAUSE_BREAK.test(m[0])));
        if (!denies && !personSaid(m[0])) recommends = true;
      }
    }
    if (recommends) flag("regime_recommendation", "blocking", "The text recommends or selects a tax regime, or says one saves money or is better; only the tool's figures may be reported.");

    // A date beside a deadline word needs a source; only a refusal right beside the date ("I cannot confirm that 31 July is the deadline") licenses it.
    if (DEADLINE_WORD.test(sentence)) {
      for (const m of sentence.matchAll(DATE_MENTION)) {
        if (denied(sentence, m.index as number, REFUSAL)) continue;
        const mention = m[0].toLowerCase().replace(/\s+/g, " ");
        if (!quotes.some((q) => q.includes(mention))) flag("unsupported_deadline", "blocking", `A deadline is stated ("${m[0].slice(0, 40)}") with no source for deadlines.`);
      }
    }

    if (claimsAny(sentence, STATUTE_CLAIM) && !tiers.has("statute")) flag("authority_upgrade", "blocking", "The text speaks with the authority of the Act or the statute, but no statute evidence exists.");
    if (claimsAny(sentence, CIRCULAR_CLAIM) && !tiers.has("notification_circular")) flag("authority_upgrade", "blocking", "The text speaks with the authority of a circular or notification, but no such evidence exists.");

    const hasSection = SECTION_KEYWORD.test(sentence) || SECTION_BARE.test(sentence);
    if (hasSection && !hasCitation(sentence) && [...sentence.matchAll(LAW_VERB)].some((m) => !denied(sentence, m.index as number, REFUSAL))) {
      if (evidence.length === 0) flag("law_claim_without_evidence", "blocking", "The text makes a claim about a section of the law and no tax-law evidence exists.");
      else flag("uncited_law_claim", "warning", "A sentence makes a claim about a section of the law without citing evidence.");
    }
  }

  // --- 3. the state, and the release of the text ----------------------------------------------------------
  const isBlocked = violations.some((v) => v.severity === "blocking");
  const taxRefused = refusals.some((r) => r.tool === "calculate_tax" || r.tool === "compare_tax_regimes" || r.tool === "simulate_tax");
  const lawRefused = refusals.some((r) => r.tool === "search_tax_law");
  const state: AnswerState = isBlocked ? "withheld" : taxRefused && taxValues.length === 0 ? "unsupported" : lawRefused && evidence.length === 0 ? "insufficient_evidence" : "answered";

  const notices: string[] = [];
  for (const fact of taxValues) if (fact.notice !== null && !notices.includes(fact.notice)) notices.push(fact.notice);
  for (const fact of ledger) if (fact.notice !== null && !notices.includes(fact.notice)) notices.push(fact.notice);
  const highest = evidence.reduce<AuthorityTier | null>((top, e) => (top === null || TIER_RANK[e.authorityTier] > TIER_RANK[top] ? e.authorityTier : top), null);
  const guidanceOnly = evidence.length > 0 && evidence.every((e) => e.authorityTier === "official_guidance");
  if (guidanceOnly) notices.push(GUIDANCE_NOTICE);

  const answer: Answer = {
    state,
    text: isBlocked ? null : { origin: "model", content: rawText },
    citations: isBlocked ? [] : cited.flatMap((id) => (evidenceById.has(id) ? [{ evidenceId: id, evidence: evidenceById.get(id) as EvidenceFact }] : [])),
    facts: { evidence, taxValues, ledger, refusals },
    notices,
    authority: { highestTier: highest, guidanceOnly },
    violations,
  };
  return deepFreeze(clone(answer));
}

/** Whether a sentence carries at least one well-formed citation. */
function hasCitation(sentence: string): boolean {
  return new RegExp(CITATION.source).test(sentence);
}
