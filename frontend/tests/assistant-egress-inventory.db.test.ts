// The egress inventory (lib/assistant/tool-contract.ts, ASSISTANT_EGRESS_INVENTORY) against the REAL tool wrappers. It describes
// what each tool returns (and so what a model would be sent); it decides nothing about what may leave SmartCA.
//
// How: every text input a tool can receive is seeded with a marker naming where it came from (the person's ledger text, the
// model's own arguments, including unknown argument NAMES, and retrieved corpus text). Each tool runs through its ok and refusal
// paths, and every leaf of every result is collected with the markers it carries. Then:
//   - every leaf is covered by an inventory entry (the entry for its path, or for a parent of it), and every entry covers a leaf;
//   - a leaf carrying ledger or argument text is its OWN entry, classed user_free_text; one carrying corpus text is its own entry,
//     classed tax_corpus_text. Free text cannot hide inside an entry classed as figures or system values;
//   - every user_free_text and tax_corpus_text entry really carried such text in some probe.
// So a new field fails, a new free-text field fails even under a classed parent, and a stale entry fails.
//
// The ledger and retrieval are injected (createAssistantTools(deps)); compare_tax_regimes reads the seeded assessment year, so
// this needs the local PostgreSQL.
import "../db/load-env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_EGRESS_INVENTORY, ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import type { EgressFieldClass, ToolName } from "../lib/assistant/tool-contract";
import { createAssistantTools } from "../services/assistant/tools";
import { filterToolResult } from "../lib/assistant/egress-filter";
import type { AssistantToolDeps } from "../services/assistant/tools";
import type { TaxEvidence, TaxRetrievalInput, TaxRetrievalResult } from "../services/tax-retrieval";
import { calculateTax, comparisonNumbers } from "../tax-engine";
import type { ComparisonInput } from "../tax-engine";

const USER = "8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f";
type Marker = "ledger" | "argument" | "corpus";
const MARK: Record<Marker, string> = { ledger: "qzledgerq", argument: "qzargq", corpus: "qzcorpusq" };
const MARKERS = Object.keys(MARK) as Marker[];
const CLASSES: EgressFieldClass[] = ["user_free_text", "user_financial_data", "tax_corpus_text", "system_value"];
const CLASS_OF: Record<Marker, EgressFieldClass> = { ledger: "user_free_text", argument: "user_free_text", corpus: "tax_corpus_text" };

type LedgerRow = Awaited<ReturnType<NonNullable<AssistantToolDeps["listTransactions"]>>>[number];
const row = (n: number, type: "income" | "expense", occurredOn: string): LedgerRow =>
  ({
    id: `row-${n}`,
    userId: USER,
    type,
    amountPaise: 10_000 * n,
    category: `${MARK.ledger} category ${n}`,
    description: `${MARK.ledger} description ${n}`,
    source: `${MARK.ledger} source ${n}`,
    occurredOn,
  }) as unknown as LedgerRow;
const LEDGER = [row(1, "income", "2026-03-01"), row(2, "expense", "2026-03-05")];

const evidence: TaxEvidence = {
  evidenceId: "ev_00000000000000a1",
  chunkId: `${MARK.corpus}-chunk`,
  sourceKey: `${MARK.corpus}-source`,
  title: `${MARK.corpus} title`,
  publisher: `${MARK.corpus} publisher`,
  url: `https://example.gov.in/${MARK.corpus}`,
  authorityTier: "official_guidance",
  sectionRef: `${MARK.corpus}-87A`,
  quote: `${MARK.corpus} quote`,
  assessmentYear: "2026-27",
  effectiveFrom: null,
  retrievedAt: "2026-09-19T00:00:00.000Z",
  corpusVersion: `${MARK.corpus}-v1`,
  verificationStatus: "primary_verified",
  score: 1,
};

// What retrieval returns. Section references are read from the model's question or sectionRef, so they carry the argument marker;
// everything read from the corpus carries the corpus marker.
const retrieveOk = async (input: TaxRetrievalInput): Promise<TaxRetrievalResult> => ({
  status: "ok",
  assessmentYear: input.assessmentYear,
  corpusVersion: `${MARK.corpus}-v1`,
  evidence: [evidence],
  unmatchedSectionRefs: [`${MARK.argument}-unmatched`],
  sectionResolutions: [{ requested: `${MARK.argument}-87A`, basis: "exact", resolvedTo: `${MARK.corpus}-87A`, clauseCovered: true, evidenceIds: [evidence.evidenceId] } as never],
});
const retrieveRefused = async (input: TaxRetrievalInput): Promise<TaxRetrievalResult> => ({
  status: "insufficient_evidence",
  reason: "year_mismatch" as never,
  assessmentYear: input.assessmentYear,
  corpusVersion: `${MARK.corpus}-v1`,
  sectionRefs: [`${MARK.argument}-87A`],
  yearMismatch: { requested: input.assessmentYear, stated: [`${MARK.argument}-year`] },
  authorityTier: { required: ["statute"], available: ["official_guidance"] } as never,
});

const taxBody = {
  assessmentYear: "2026-27",
  ageCategory: "below60",
  income: { salaryPaise: 150_000_000, businessPaise: 20_000_000, otherPaise: 5_000_000 },
  deductions: { section80CPaise: 15_000_000, healthInsurance: { selfFamilyPaise: 2_000_000, parentsPaise: 3_000_000, spouseIsSenior: false, anyParentIsSenior: true } },
};
const extraKey = { [MARK.argument]: 1 };

// A saved computation as services/tax.ts returns it: the engine's own results for both regimes.
const savedInput: ComparisonInput = { assessmentYearLabel: "2026-27", ageCategory: "below60", incomeSources: [{ kind: "salary", label: "Salary", amountPaise: 150_000_000 }], deductions: [] };
const savedOld = calculateTax({ ...savedInput, regime: "old" });
const savedNew = calculateTax({ ...savedInput, regime: "new" });
const savedComputation = async () => ({ assessmentYear: "2026-27", savedAt: "2026-10-01T10:00:00.000Z", savedComputations: 2, input: savedInput, results: { old: savedOld, new: savedNew }, numbers: comparisonNumbers(savedOld, savedNew) });

/** Each tool's calls: its ok path, and refusal paths fed argument text (an unknown field NAME, an over-long or unmatched value). */
const PROBES: Record<ToolName, Array<{ deps: AssistantToolDeps; args: unknown }>> = {
  search_tax_law: [
    { deps: { retrieve: retrieveOk }, args: { question: `${MARK.argument} rebate`, assessmentYear: "2026-27", sectionRef: MARK.argument } },
    { deps: { retrieve: retrieveRefused }, args: { question: `${MARK.argument} rebate`, assessmentYear: "2026-27" } },
    { deps: { retrieve: retrieveOk }, args: { question: "rebate", assessmentYear: "2026-27", ...extraKey } },
    { deps: { retrieve: retrieveOk }, args: { question: `${MARK.argument} ${"x".repeat(2_000)}`, assessmentYear: "2026-27" } },
  ],
  query_transactions: [
    { deps: {}, args: { includeDescription: true } },
    { deps: {}, args: { category: MARK.argument, type: "expense", from: "2026-01-01", to: "2026-12-31", limit: 5 } },
    { deps: {}, args: { category: `${MARK.argument}${"x".repeat(2_000)}` } },
    { deps: {}, args: extraKey },
    { deps: {}, args: { sort: "amount" } },
  ],
  get_financial_summary: [
    { deps: {}, args: {} },
    { deps: {}, args: { from: "2026-01-01", to: "2026-12-31" } },
    { deps: {}, args: extraKey },
  ],
  calculate_tax: [
    { deps: {}, args: { regime: "old", ...taxBody } },
    { deps: {}, args: { regime: "old", ...taxBody, ...extraKey } },
    { deps: {}, args: { regime: "old", ...taxBody, income: { ...taxBody.income, ...extraKey } } },
  ],
  compare_tax_regimes: [
    { deps: {}, args: taxBody },
    { deps: {}, args: { ...taxBody, ...extraKey } },
    { deps: {}, args: { ...taxBody, income: { ...taxBody.income, ...extraKey } } },
  ],
  simulate_tax: [
    { deps: {}, args: { regime: "old", base: { ...taxBody, deductions: {} }, scenario: taxBody } },
    { deps: {}, args: { regime: "old", base: taxBody, scenario: taxBody, ...extraKey } },
    { deps: {}, args: { regime: "old", base: { ...taxBody, ...extraKey }, scenario: taxBody } },
  ],
  get_saved_tax_computation: [
    { deps: { getLatestSavedTaxComputation: savedComputation }, args: {} },
    { deps: { getLatestSavedTaxComputation: savedComputation }, args: { assessmentYear: "2026-27" } },
    { deps: { getLatestSavedTaxComputation: async () => null }, args: {} },
    { deps: { getLatestSavedTaxComputation: savedComputation }, args: extraKey },
  ],
};

/** Every leaf (a primitive, or an empty array or object), as path -> the markers it carried in any probe. Arrays are `[]`. */
function collect(value: unknown, path: string, leaves: Map<string, Set<Marker>>, keyMarkers: string[]): void {
  const leaf = (marks: Marker[]) => {
    const set = leaves.get(path) ?? new Set<Marker>();
    for (const m of marks) set.add(m);
    leaves.set(path, set);
  };
  const markersIn = (text: string) => MARKERS.filter((m) => text.includes(MARK[m]));
  if (Array.isArray(value)) {
    if (value.length === 0) leaf([]);
    value.forEach((item) => collect(item, `${path}[]`, leaves, keyMarkers));
  } else if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) leaf([]);
    for (const [key, item] of entries) {
      if (markersIn(key).length > 0) keyMarkers.push(`${path}{${key}}`);
      collect(item, path === "" ? key : `${path}.${key}`, leaves, keyMarkers);
    }
  } else leaf(typeof value === "string" ? markersIn(value) : []);
}

/** The inventory entry that covers a path: the path itself, or its nearest listed parent. */
function coveringEntry(path: string, inventory: Readonly<Record<string, EgressFieldClass>>): string | null {
  let best: string | null = null;
  for (const entry of Object.keys(inventory)) {
    const covers = path === entry || path.startsWith(`${entry}.`) || path.startsWith(`${entry}[]`);
    if (covers && (best === null || entry.length > best.length)) best = entry;
  }
  return best;
}

test("every real tool has an inventory, and every entry uses one of the four classes", () => {
  assert.deepEqual(Object.keys(ASSISTANT_EGRESS_INVENTORY).sort(), [...ASSISTANT_TOOL_NAMES].sort());
  for (const inventory of Object.values(ASSISTANT_EGRESS_INVENTORY)) for (const c of Object.values(inventory)) assert.ok(CLASSES.includes(c), c);
});

for (const tool of ASSISTANT_TOOL_NAMES) {
  test(`${tool}: the inventory matches what the real tool returns, and every field carrying free or corpus text is its own entry`, async () => {
    const leaves = new Map<string, Set<Marker>>();
    const keyMarkers: string[] = [];
    for (const { deps, args } of PROBES[tool]) {
      const tools = createAssistantTools({ listTransactions: async () => structuredClone(LEDGER), ...deps });
      collect(await tools[tool](USER, structuredClone(args)), "", leaves, keyMarkers);
    }
    const inventory = ASSISTANT_EGRESS_INVENTORY[tool];
    assert.deepEqual(keyMarkers, [], "no free text is ever used as an object key");

    // An empty array or object is covered by the entries for what it would hold.
    const hasEntryBelow = (path: string) => Object.keys(inventory).some((entry) => entry.startsWith(`${path}[]`) || entry.startsWith(`${path}.`));
    const uncovered = [...leaves.keys()].filter((path) => coveringEntry(path, inventory) === null && !hasEntryBelow(path)).sort();
    assert.deepEqual(uncovered, [], `${tool}: fields the tool returns that the inventory does not list`);

    const used = new Set([...leaves.keys()].map((path) => coveringEntry(path, inventory)));
    assert.deepEqual(Object.keys(inventory).filter((entry) => !used.has(entry)).sort(), [], `${tool}: inventory entries the tool never returns`);

    const misclassed: string[] = [];
    const carried = new Map<string, Set<Marker>>();
    for (const [path, marks] of leaves) {
      const entry = coveringEntry(path, inventory);
      if (entry === null) continue; // an empty container, covered by the entries below it
      for (const m of marks) {
        if (entry !== path || inventory[entry] !== CLASS_OF[m]) misclassed.push(`${path} carries ${m} text but is covered by ${entry} (${inventory[entry]})`);
        carried.set(entry, (carried.get(entry) ?? new Set()).add(m));
      }
    }
    assert.deepEqual(misclassed.sort(), [], `${tool}: free or corpus text in a field not listed as such`);

    const neverCarried = Object.entries(inventory)
      .filter(([entry, c]) => (c === "user_free_text" || c === "tax_corpus_text") && ![...(carried.get(entry) ?? [])].some((m) => CLASS_OF[m] === c))
      .map(([entry]) => entry);
    assert.deepEqual(neverCarried, [], `${tool}: listed as free or corpus text, but never carried any`);
  });
}

// The filter against the REAL tool wrappers: showing every class reproduces each result exactly, and forbidding a class leaves none of
// the text that class carries anywhere in what the model would be sent.
for (const tool of ASSISTANT_TOOL_NAMES) {
  test(`${tool}: the egress filter shows the real result exactly, or without every trace of a forbidden class`, async () => {
    const ALL = { user_free_text: true, user_financial_data: true, tax_corpus_text: true, system_value: true };
    for (const { deps, args } of PROBES[tool]) {
      const tools = createAssistantTools({ listTransactions: async () => structuredClone(LEDGER), ...deps });
      const raw = await tools[tool](USER, structuredClone(args));
      const before = JSON.stringify(raw);
      assert.equal(JSON.stringify(filterToolResult(tool, raw, ALL)), before, "all classes: byte for byte");
      const noFree = JSON.stringify(filterToolResult(tool, raw, { ...ALL, user_free_text: false }));
      assert.equal(noFree.includes(MARK.ledger) || noFree.includes(MARK.argument), false, "no ledger or argument text without user_free_text");
      const noCorpus = JSON.stringify(filterToolResult(tool, raw, { ...ALL, tax_corpus_text: false }));
      assert.equal(noCorpus.includes(MARK.corpus), false, "no corpus text without tax_corpus_text");
      assert.equal(JSON.stringify(raw), before, "the raw result is untouched");
    }
  });
}
