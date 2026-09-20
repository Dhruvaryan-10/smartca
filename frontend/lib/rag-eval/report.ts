// The human-readable RAG evaluation report. PURE: a string from an EvalResult.
//
// It deliberately has no headline score. Each metric is shown as `k/n`, its rate and a 95% Wilson interval, broken down
// by category, by split, and with the provisional cases on their own. Every failing case is listed with the question,
// the expected behaviour, what retrieval returned and what was missing or wrong.
import type { MetricBlock } from "./aggregate";
import type { EvalResult } from "./run";
import { HARD_FAILURE_KINDS } from "./score";
import type { CaseScore } from "./score";
import type { Rate } from "./stats";

const pct = (x: number | null) => (x === null ? "  n/a" : `${(x * 100).toFixed(1)}%`.padStart(6));
const fmtRate = (r: Rate) => (r.n === 0 ? "     0/0      n/a" : `${`${r.k}/${r.n}`.padStart(8)}  ${pct(r.rate)}  [${pct(r.low).trim()} to ${pct(r.high).trim()}]`);
const row = (label: string, value: string, indent = 2) => `${" ".repeat(indent)}${label.padEnd(40)}${value}`;
const clip = (text: string, max = 150) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function metricLines(m: MetricBlock, indent = 2): string[] {
  const b = m.byBehavior;
  return [
    row("cases", `${m.cases}  (answer ${b.answer}, insufficient_evidence ${b.insufficient_evidence}, route_to_engine ${b.route_to_engine}, refuse_out_of_scope ${b.refuse_out_of_scope}; ${m.safetyOnlyCases} checked for safety only)`, indent),
    row("gold recall@1 (requirements)", fmtRate(m.recallAt[1]), indent),
    row("gold recall@3 (requirements)", fmtRate(m.recallAt[3]), indent),
    row("gold recall@5 (requirements)", fmtRate(m.recallAt[5]), indent),
    row("cases fully covered @1 / @3 / @5", `${m.fullCaseRecallAt[1].k}/${m.fullCaseRecallAt[1].n}  ${m.fullCaseRecallAt[3].k}/${m.fullCaseRecallAt[3].n}  ${m.fullCaseRecallAt[5].k}/${m.fullCaseRecallAt[5].n}`, indent),
    row("MRR (mean, no interval)", `${m.mrr.mean === null ? "n/a" : m.mrr.mean.toFixed(3)}  over ${m.mrr.n} answer cases`, indent),
    row("quote support (of retrieved gold)", fmtRate(m.quoteSupport), indent),
    row("false-insufficient rate", fmtRate(m.falseInsufficient), indent),
    row("false-ok rate", fmtRate(m.falseOk), indent),
    row("typed-reason accuracy", fmtRate(m.typedReasonAccuracy), indent),
    row("distractor intrusion @1", fmtRate(m.distractorIntrusion.at1), indent),
    row("distractor intrusion @3", fmtRate(m.distractorIntrusion.at3), indent),
    row("distractor intrusion @5", fmtRate(m.distractorIntrusion.at5), indent),
    row("section-resolution accuracy", fmtRate(m.sectionResolutionAccuracy), indent),
    row("cases with any failure / hard failure", `${m.casesWithFailures} / ${m.casesWithHardFailures}`, indent),
  ];
}

const compactLine = (label: string, m: MetricBlock) =>
  `  ${label.padEnd(24)}${String(m.cases).padStart(3)} cases | recall@1 ${m.recallAt[1].k}/${m.recallAt[1].n} @3 ${m.recallAt[3].k}/${m.recallAt[3].n} @5 ${m.recallAt[5].k}/${m.recallAt[5].n}` +
  ` | MRR ${m.mrr.mean === null ? "n/a" : m.mrr.mean.toFixed(2)} | false-insuff ${m.falseInsufficient.k}/${m.falseInsufficient.n} | false-ok ${m.falseOk.k}/${m.falseOk.n}` +
  ` | reason ${m.typedReasonAccuracy.k}/${m.typedReasonAccuracy.n} | intrusion@3 ${m.distractorIntrusion.at3.k}/${m.distractorIntrusion.at3.n} | section ${m.sectionResolutionAccuracy.k}/${m.sectionResolutionAccuracy.n}`;

function caseBlock(c: CaseScore): string[] {
  const status = c.actual.status === "insufficient_evidence" ? `insufficient_evidence (reason: ${c.actual.reason})` : c.actual.status === "error" ? `error (${c.actual.error})` : "ok";
  const evidence =
    c.actual.evidence.length === 0
      ? ["      none"]
      : c.actual.evidence.map((e) => `      #${e.rank} ${e.sourceKey.replace(/^itd-efiling-/, "").replace(/-ay-2026-27$/, "")} > ${e.heading ?? "?"} [chunk ${e.chunkIndex ?? "?"}, ${e.authorityTier}, ${e.verificationStatus}, AY ${e.assessmentYear}]${e.matchesGold.length ? `  GOLD/DISTRACTOR: ${e.matchesGold.join(", ")}` : ""}\n         "${clip(oneLine(e.quote), 130)}"`);
  const review = c.reviewStatus === "provisional" ? `PROVISIONAL (${c.reviewPriority})` : "gold";
  return [
    `  [${c.split}] ${c.id}  ${c.category}  ${review}`,
    `    question:            ${c.question}`,
    `    expected behavior:   ${c.expectedBehavior}${c.engineRequired ? "  (figures must come from the engine)" : ""}; retrieval expected: ${c.retrievalExpectation}`,
    `    retrieval status:    ${status}`,
    `    evidence returned:`,
    ...evidence,
    `    reason / gold:       ${c.requirements.length === 0 ? "no scored gold evidence for this case" : c.requirements.map((r) => `requirement ${r.index + 1} (${r.anyOf.join(" | ")}): ${r.rank === null ? "NOT RETRIEVED" : `found at rank ${r.rank}${r.quoteSupported === false ? ", quote lacks the anchor" : ""}`}`).join("; ")}`,
    `    missing/incorrect:`,
    ...c.failures.map((f) => `      ${f.hard ? "[HARD] " : ""}${f.kind}: ${f.detail}`),
  ];
}

export function formatReport(result: EvalResult): string {
  const { metrics: m, dataset: d } = result;
  const out: string[] = [];
  const heading = (title: string) => out.push("", `== ${title} ${"=".repeat(Math.max(3, 76 - title.length))}`);

  out.push(
    `RAG RETRIEVAL EVALUATION`,
    `  dataset ${d.version} (sha256 ${d.sha256.slice(0, 12)}…), ran: ${d.ran}`,
    `  corpus  ${result.corpus.version} (manifest ${result.corpus.manifestSha256.slice(0, 12)}…)`,
    `  ${d.caseCount} cases in the dataset: ${d.goldCaseCount} gold (the primary score) and ${d.provisionalCaseCount} provisional (reported separately, never in the primary score).`,
    `  Layer: lexical retrieval only. No LLM, no embeddings, no answer generation. No pass thresholds are set: this records a baseline.`,
    `  Every rate is k/n with a 95% Wilson interval. There is no single accuracy figure; read the metrics together and mind n.`,
    `  route_to_engine and refuse_out_of_scope cases are checked for retrieval SAFETY only: retrieval alone cannot prove their final behaviour.`,
  );

  heading("HARD SAFETY FAILURES (all cases, provisional included)");
  if (result.hardFailures.length === 0) out.push("  none");
  for (const kind of HARD_FAILURE_KINDS) {
    const hits = result.hardFailures.filter((f) => f.kind === kind);
    out.push(`  ${kind}: ${hits.length} case(s)${hits.length ? `  ${hits.map((f) => `${f.id}${f.review === "provisional" ? "*" : ""}[${f.split}]`).join(" ")}` : ""}`);
  }
  if (result.hardFailures.length > 0) out.push("  (* = provisional case)");
  // The refusals that keep an unsafe answer out: retrieval said "no" instead of returning evidence for the wrong year or tier.
  const refused = (pick: (c: CaseScore) => unknown) => result.cases.filter((c) => pick(c) !== null).map((c) => c.id);
  const yearRefusals = refused((c) => c.actual.yearMismatch);
  const tierRefusals = refused((c) => c.actual.authorityTier);
  out.push(
    `  assessment-year mismatch refusals: ${yearRefusals.length} case(s)${yearRefusals.length ? `  ${yearRefusals.join(" ")}` : ""}`,
    `  required-authority-tier refusals: ${tierRefusals.length} case(s)${tierRefusals.length ? `  ${tierRefusals.join(" ")}` : ""}`,
  );
  out.push(
    "  engine_required_numeric_answer_from_evidence is checked structurally: retrieval returns evidence and nothing else, so it cannot",
    "  produce a trusted figure. The answer-layer form of this gate cannot be evaluated until an answer generator exists.",
  );

  heading("OVERALL (primary: gold cases, dev + test)");
  out.push(...metricLines(m.primary));

  heading("BY CATEGORY (primary: gold cases)");
  for (const [category, block] of Object.entries(m.byCategory)) out.push(compactLine(category, block));

  heading("DEV VS TEST (primary: gold cases)");
  out.push("  dev is what retrieval may be tuned against; test is held out and frozen.");
  out.push("  dev:", ...metricLines(m.bySplit.dev, 4), "  test:", ...metricLines(m.bySplit.test, 4));

  heading("PROVISIONAL / TAX-PROFESSIONAL-REVIEW CASES (reported separately, not in the primary score)");
  out.push(...metricLines(m.provisional));
  out.push(compactLine("provisional dev", m.provisionalBySplit.dev), compactLine("provisional test", m.provisionalBySplit.test), "");
  for (const c of result.cases.filter((s) => s.reviewStatus === "provisional")) {
    const verdict = c.failures.length === 0 ? "no failure" : c.failures.map((f) => `${f.hard ? "HARD " : ""}${f.kind}`).join(", ");
    out.push(`  [${c.split}] ${c.id.padEnd(7)} ${String(c.reviewPriority).padEnd(15)} ${c.expectedBehavior.padEnd(22)} ${c.actual.status.padEnd(21)} ${verdict}`);
  }

  heading("FAILURES (every case with a failure; gold and provisional)");
  const failing = result.cases.filter((c) => c.failures.length > 0);
  if (failing.length === 0) out.push("  none");
  for (const c of failing) out.push("", ...caseBlock(c));

  return `${out.join("\n")}\n`;
}
