import { formatRupees } from "@/lib/format";
import type { RegimeComparison as Comparison, RegimeOutcome } from "@/tax-engine";

// Old and new regime side by side. Everything shown was produced by the tax
// engine: this component only formats it. It states numbers (totals and how
// far apart they are) and never tells anyone which regime to choose.
export default function RegimeComparison({ comparison }: { comparison: Comparison }) {
  return (
    <section aria-label="Old and new regime compared">
      <div className="grid grid-cols-1 border-t border-border sm:grid-cols-2">
        <RegimeColumn label="Old regime" outcome={comparison.old} />
        <RegimeColumn label="New regime" outcome={comparison.new} divided />
      </div>
      <p className="mt-4 text-sm text-foreground" aria-live="polite">
        {describeDifference(comparison)}
      </p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Tax liability for the year, before any TDS or advance tax you have already paid.
      </p>
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

function RegimeColumn({ label, outcome, divided = false }: { label: string; outcome: RegimeOutcome; divided?: boolean }) {
  const spacing = divided ? "border-t border-border pt-5 sm:border-l sm:border-t-0 sm:pl-8" : "pb-5 pt-5 sm:pr-8";

  if (outcome.status === "refused") {
    return (
      <div className={spacing}>
        <h3 className="text-[13px] font-medium text-muted-foreground">{label}</h3>
        <p className="mt-2 text-[15px] font-medium text-foreground">No result for this regime</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{outcome.refusal.message}</p>
      </div>
    );
  }

  const { result } = outcome;
  return (
    <div className={spacing}>
      <h3 className="text-[13px] font-medium text-muted-foreground">{label}</h3>
      <p className="mt-1 font-numeric text-[28px] font-semibold leading-9 tracking-[-0.02em] text-foreground">
        {formatRupees(result.totalTaxPaise)}
      </p>
      <p className="text-[13px] text-muted-foreground">Total tax</p>
      <dl className="mt-4 space-y-1.5 text-sm">
        <Row label="Taxable income" value={formatRupees(result.taxableIncomePaise)} />
        <Row label="Deductions applied" value={formatRupees(result.totalDeductionsPaise)} />
      </dl>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-numeric text-foreground">{value}</dd>
    </div>
  );
}
