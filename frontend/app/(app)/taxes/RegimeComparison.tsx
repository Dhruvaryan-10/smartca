import { formatRupees } from "@/lib/format";
import type { RegimeComparison as Comparison, RegimeOutcome } from "@/tax-engine";
import { Badge } from "../../components/ui/Badge";

// Old and new regime side by side. Everything shown was produced by the tax
// engine: this component only formats it. It states numbers (totals and how
// far apart they are) and never tells anyone which regime to choose. The
// totals carry the recompute wash when a new result arrives (`washKey`).
export default function RegimeComparison({ comparison, washKey }: { comparison: Comparison; washKey?: string | number }) {
  const numbers = comparison.numbers;
  const lowerBy = (regime: "old" | "new") =>
    numbers && numbers.lowerTaxRegime === regime ? numbers.differencePaise : null;

  return (
    <section aria-label="Old and new regime compared">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        <RegimeCard label="Old regime" outcome={comparison.old} lowerByPaise={lowerBy("old")} washKey={washKey} />
        <RegimeCard label="New regime" outcome={comparison.new} lowerByPaise={lowerBy("new")} washKey={washKey} />
      </div>
      <p className="mt-4 text-body text-foreground" aria-live="polite">
        {describeDifference(comparison)}
      </p>
      <p className="mt-1 text-label text-foreground-muted">Tax liability for the year, before any TDS or advance tax you have already paid.</p>
    </section>
  );
}

function describeDifference(comparison: Comparison): string {
  const numbers = comparison.numbers;
  if (!numbers) return "A side-by-side difference isn’t available because one regime has no result.";
  if (numbers.lowerTaxRegime === "equal") return "Both regimes give the same total tax.";
  const lower = numbers.lowerTaxRegime === "old" ? "old" : "new";
  return `Total tax is ${formatRupees(numbers.differencePaise)} lower under the ${lower} regime.`;
}

function RegimeCard({
  label,
  outcome,
  lowerByPaise,
  washKey,
}: {
  label: string;
  outcome: RegimeOutcome;
  lowerByPaise: number | null;
  washKey?: string | number;
}) {
  if (outcome.status === "refused") {
    return (
      <div className="rounded-panel border border-border bg-surface p-4">
        <h3 className="text-label font-medium text-foreground-muted">{label}</h3>
        <p className="mt-2 text-subheading font-medium text-foreground">No result for this regime</p>
        <p className="mt-1 text-label text-foreground-muted">{outcome.refusal.message}</p>
      </div>
    );
  }

  const { result } = outcome;
  return (
    <div className="rounded-panel border border-border bg-surface p-4">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-label font-medium text-foreground-muted">{label}</h3>
        {lowerByPaise !== null && <Badge tone="tax">{formatRupees(lowerByPaise)} lower</Badge>}
      </div>
      <p key={washKey} className="recompute-wash -mx-1 mt-2 rounded-xs px-1 font-numeric text-figure font-semibold text-foreground">
        {formatRupees(result.totalTaxPaise)}
      </p>
      <p className="text-micro text-foreground-muted">Total tax</p>
      <dl className="mt-4 space-y-1.5 border-t border-divider pt-3 text-label">
        <Row label="Taxable income" value={formatRupees(result.taxableIncomePaise)} />
        <Row label="Deductions applied" value={formatRupees(result.totalDeductionsPaise)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-foreground-muted">{label}</dt>
      <dd className="font-numeric text-foreground">{value}</dd>
    </div>
  );
}
