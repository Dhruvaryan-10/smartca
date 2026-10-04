import { formatRupees } from "@/lib/format";
import type { Summary } from "@/lib/summary";
import { moneyFlow, type MoneyFlow } from "@/lib/summary-view";
import { Money } from "../../components/ui/Money";

// The settled figure: net savings, finished with an accounting double
// rule (the one per view), then the money-flow bar that explains it and
// the three figures it is made of. Large surfaces stay neutral; colour
// sits only on figures and the bar's segments.
//
// `fitToContainer` (the landing page, where it sits in a card narrower than the viewport): the figure and the bar go side by
// side when the card is wide enough for both, not when the viewport is, so the bar never spills out of the card.
export function SummaryHero({ summary, fitToContainer = false }: { summary: Summary; fitToContainer?: boolean }) {
  const { savingsPaise, incomePaise, expensePaise, savingsRatePercent } = summary;
  const overspent = savingsPaise < 0;
  const flow = moneyFlow(incomePaise, expensePaise);
  const columns = fitToContainer ? "grid gap-10 @3xl:grid-cols-12 @3xl:items-end @3xl:gap-16" : "grid gap-10 lg:grid-cols-12 lg:items-end lg:gap-16";
  const half = fitToContainer ? "@3xl:col-span-6" : "lg:col-span-6";

  return (
    <section aria-labelledby="net-savings" className={fitToContainer ? "@container space-y-10" : "space-y-10"}>
      <div className={columns}>
        <div className={half}>
          <h2 id="net-savings" className="text-label font-medium text-foreground-muted">
            Net savings
          </h2>
          <div className="mt-2 inline-flex flex-col">
            <p className="font-display text-display font-semibold">
              <Money paise={savingsPaise} kind={overspent ? "net" : "neutral"} />
            </p>
            <span aria-hidden="true" className="wipe-in mt-3 block h-0.75 border-y border-foreground" />
          </div>
          <p className="mt-4 max-w-md text-body text-foreground-secondary">{savingsCaption(savingsPaise, savingsRatePercent, incomePaise)}</p>
        </div>

        <div className={half}>
          <FlowBar flow={flow} incomePaise={incomePaise} expensePaise={expensePaise} />
        </div>
      </div>

      <dl className="grid grid-cols-2 border-t border-border sm:grid-cols-3">
        <Figure label="Income">
          <Money paise={incomePaise} kind="income" />
        </Figure>
        <Figure label="Expenses" className="border-l border-divider pl-5 sm:pl-8">
          <Money paise={expensePaise} kind="expense" />
        </Figure>
        <Figure label="Savings rate" className="col-span-2 border-t border-divider sm:col-span-1 sm:border-l sm:border-t-0 sm:pl-8">
          {savingsRatePercent === null ? (
            <>
              <span aria-hidden="true" className="text-foreground-muted">
                —
              </span>
              <span className="sr-only">Not available without income</span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="font-numeric text-foreground">
                {savingsRatePercent < 0 ? `−${Math.abs(savingsRatePercent)}` : savingsRatePercent}%
              </span>
              <span className="sr-only">{savingsRatePercent < 0 ? `minus ${Math.abs(savingsRatePercent)}` : savingsRatePercent}%</span>
            </>
          )}
        </Figure>
      </dl>
    </section>
  );
}

function Figure({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`py-4 pr-5 sm:pr-8 ${className}`}>
      <dt className="text-label text-foreground-muted">{label}</dt>
      <dd className="mt-1 text-figure font-semibold">{children}</dd>
    </div>
  );
}

function savingsCaption(savingsPaise: number, ratePercent: number | null, incomePaise: number): string {
  if (incomePaise === 0) return "No income recorded yet, so there’s no savings rate to show.";
  if (savingsPaise < 0) return `You’ve spent ${formatRupees(-savingsPaise)} more than you’ve earned.`;
  if (savingsPaise === 0) return "Your expenses match your income.";
  return `You’ve kept ${ratePercent}% of your income.`;
}

// Where income went, as one segmented bar: spent (coral) and kept
// (green), or, when spending ran past income, what income covered and
// the overspend. Each segment is labelled with its figure and share, so
// the colours only confirm what the words say.
function FlowBar({ flow, incomePaise, expensePaise }: { flow: MoneyFlow; incomePaise: number; expensePaise: number }) {
  if (flow.kind === "empty") return null;

  const segments =
    flow.kind === "kept"
      ? [
          { key: "spent", label: "Spent", tone: "expense" as const, percent: flow.spentPercent, paise: expensePaise },
          { key: "kept", label: "Kept", tone: "income" as const, percent: flow.keptPercent, paise: flow.keptPaise },
        ]
      : flow.kind === "overspent"
        ? [
            { key: "covered", label: "Covered by income", tone: "income" as const, percent: flow.incomePercent, paise: incomePaise },
            { key: "over", label: "Overspent", tone: "expense" as const, percent: flow.overspentPercent, paise: flow.overspentPaise },
          ]
        : [{ key: "spent", label: "Spent", tone: "expense" as const, percent: 100, paise: expensePaise }];

  const headline =
    flow.kind === "kept"
      ? `Of every ₹100 you earned, ₹${flow.spentPercent} went to expenses and ₹${flow.keptPercent} stayed with you.`
      : flow.kind === "overspent"
        ? `Your income covered ${flow.incomePercent}% of what you spent. The rest came from beyond what you earned.`
        : "You’ve recorded expenses but no income yet.";

  return (
    <div>
      <p className="text-body text-foreground">{headline}</p>
      <div aria-hidden="true" className="wipe-in-slow mt-4 flex h-3 gap-0.5 overflow-hidden rounded-pill bg-surface-sunken">
        {segments
          .filter((segment) => segment.percent > 0)
          .map((segment) => (
            <span
              key={segment.key}
              className={`h-full ${segment.tone === "income" ? "bg-income" : "bg-expense"}`}
              style={{ flexGrow: segment.percent, flexBasis: 0 }}
            />
          ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
        {segments.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2 text-label">
            <span aria-hidden="true" className={`h-2 w-2 rounded-xs ${segment.tone === "income" ? "bg-income" : "bg-expense"}`} />
            <span className="text-foreground-muted">{segment.label}</span>
            <Money paise={segment.paise} className="font-medium" />
            <span className="font-numeric text-foreground-muted">{segment.percent}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
