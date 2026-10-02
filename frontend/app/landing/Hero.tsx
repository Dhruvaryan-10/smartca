import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { formatMonthLabel, formatRupees } from "@/lib/format";
import { moneyFlow } from "@/lib/summary-view";
import { buttonClasses } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { IconArrowDownLeft, IconArrowUpRight, IconAsk, IconLedger, IconSummary, IconTax, IconVault } from "../components/ui/Icons";
import { EXAMPLE_COMPARISON, EXAMPLE_SUMMARY } from "./landing-data";

const STEPS = [
  { title: "Every rupee recorded", body: "Income and expenses, by date and category.", a: "6%", b: "22%" },
  { title: "Sorted and summed", body: "Net savings, months compared, spending by category.", a: "22%", b: "40%" },
  { title: "Tax worked out", body: "Both regimes for AY 2026-27, every step shown.", a: "40%", b: "58%" },
  { title: "Explained when you ask", body: "Ask SmartCA answers with sources, with your permission.", a: "58%", b: "76%" },
];

const vars = (v: Record<string, string>) => v as CSSProperties;

// The first viewport: what SmartCA is, in one line, and the product itself as the focal point. On desktop the section is
// tall and its content sticky: as you scroll, the scattered pieces of a person's finances dock into a SmartCA Summary, and
// the steps on the left light up in order. Everything stays readable throughout; without motion it is simply assembled.
export function Hero({ signedIn }: { signedIn: boolean }) {
  return (
    <section aria-labelledby="hero-title" className="hero-story relative">
      <div className="hero-sticky flex items-center">
        <div className="mx-auto grid w-full max-w-[84rem] items-center gap-12 px-gutter py-14 sm:py-20 lg:grid-cols-12 lg:gap-10 lg:py-0">
          <div className="lg:col-span-5">
            <Badge tone="tax" className="mb-6">
              AY 2026-27 · Old and new regime
            </Badge>
            <h1 id="hero-title" className="font-display text-[clamp(2.75rem,1.6rem+4.4vw,4.75rem)] font-semibold leading-[1.02] tracking-[-0.035em] text-foreground">
              Your money,
              <br />
              worked out.
            </h1>
            <p className="mt-6 max-w-md text-body-lg text-foreground-secondary sm:text-[1.0625rem] sm:leading-7">
              SmartCA is a calm ledger for your income, spending and tax. It does the arithmetic, shows every step, and never uses a
              figure you haven’t confirmed.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link href={signedIn ? "/dashboard" : "/signup"} className={buttonClasses("primary", "lg", "w-full sm:w-auto")}>
                {signedIn ? "Open SmartCA" : "Get started"}
              </Link>
              <a href="#story" className={buttonClasses("outline", "lg", "w-full sm:w-auto")}>
                Explore SmartCA
              </a>
            </div>

            <ol className="relative mt-12 hidden space-y-4 border-l border-border pl-6 lg:block" aria-label="How SmartCA works">
              <span aria-hidden="true" className="hero-progress-fill absolute -left-px top-0 h-full w-px bg-primary" />
              {STEPS.map((step) => (
                <li key={step.title} className="hero-step relative" style={vars({ "--a": step.a, "--b": step.b })}>
                  <span aria-hidden="true" className="hero-step-dot absolute -left-[1.84rem] top-1.5 h-2.5 w-2.5 rounded-pill" />
                  <p className="text-body font-medium">{step.title}</p>
                  <p className="text-label text-foreground-muted">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>

          <div className="lg:col-span-7">
            <HeroComposition />
          </div>
        </div>
      </div>
    </section>
  );
}

function Piece({ from, a, b, className = "", children }: { from: string; a: string; b: string; className?: string; children: ReactNode }) {
  return (
    <div className={`hero-piece rounded-lg border border-border bg-surface-elevated p-4 ${className}`} style={vars({ "--from": from, "--a": a, "--b": b })}>
      {children}
    </div>
  );
}

function HeroComposition() {
  const s = EXAMPLE_SUMMARY;
  const flow = moneyFlow(s.incomePaise, s.expensePaise);
  const kept = flow.kind === "kept" ? flow : null;
  const newRegime = EXAMPLE_COMPARISON.new.status === "ok" ? EXAMPLE_COMPARISON.new.result : null;
  const lowerBy = EXAMPLE_COMPARISON.numbers?.lowerTaxRegime === "new" ? EXAMPLE_COMPARISON.numbers.differencePaise : null;
  const max = Math.max(...s.months.flatMap((m) => [m.incomePaise, m.expensePaise]));

  return (
    <figure className="hero-stage">
      <figcaption className="sr-only">
        An example SmartCA Summary: net savings of {formatRupees(s.savingsPaise)} from {formatRupees(s.incomePaise)} of income and{" "}
        {formatRupees(s.expensePaise)} of expenses over six months, with monthly bars, recent entries, a tax comparison and the Ask
        SmartCA button.
      </figcaption>
      <div aria-hidden="true" className="hero-surface rounded-dialog border border-border bg-surface shadow-modal">
        <div className="flex items-center justify-between border-b border-divider px-4 py-3 sm:px-5">
          <div className="flex items-center gap-2.5">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" className="text-primary">
              <path d="M9 6h7M4 11.5h12M4 14.5h12" />
            </svg>
            <span className="text-label font-semibold text-foreground">Summary</span>
          </div>
          <span className="text-micro text-foreground-muted">
            AY <span className="font-medium text-foreground">2026-27</span>
          </span>
        </div>
        <div className="flex [transform-style:preserve-3d]">
          <div className="hidden w-12 shrink-0 flex-col items-center gap-3 border-r border-divider py-4 text-foreground-muted sm:flex">
            <span className="flex h-8 w-8 items-center justify-center rounded-control bg-surface-sunken text-primary">
              <IconSummary width={16} height={16} />
            </span>
            <IconLedger width={16} height={16} />
            <IconTax width={16} height={16} />
            <IconVault width={16} height={16} />
            <IconAsk width={16} height={16} />
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-6 gap-3 p-3 [transform-style:preserve-3d] sm:gap-4 sm:p-5">
            <Piece from="translate3d(-22%, -34%, 160px) rotateZ(-5deg)" a="6%" b="24%" className="col-span-6 sm:col-span-3">
              <p className="text-micro font-medium text-foreground-muted">Net savings</p>
              <div className="mt-1 inline-flex flex-col">
                <p className="font-numeric text-[1.65rem] font-semibold leading-8 tracking-[-0.02em] text-foreground sm:text-figure">
                  {formatRupees(s.savingsPaise)}
                </p>
                <span className="mt-1.5 block h-0.75 border-y border-foreground" />
              </div>
              <p className="mt-2 text-micro text-foreground-secondary">You’ve kept {s.savingsRatePercent}% of your income.</p>
            </Piece>

            <Piece from="translate3d(30%, -42%, 110px) rotateZ(4deg)" a="10%" b="30%" className="col-span-6 sm:col-span-3">
              <p className="text-micro text-foreground-secondary">
                Of every ₹100 earned, ₹{kept?.spentPercent} spent, ₹{kept?.keptPercent} kept.
              </p>
              <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-pill bg-surface-sunken">
                <span className="h-full bg-expense" style={{ flexGrow: kept?.spentPercent ?? 0, flexBasis: 0 }} />
                <span className="h-full bg-income" style={{ flexGrow: kept?.keptPercent ?? 0, flexBasis: 0 }} />
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-micro">
                <span className="flex items-center gap-1.5 text-foreground-muted">
                  <span className="h-2 w-2 rounded-xs bg-expense" /> Spent <span className="font-numeric font-medium text-foreground">{formatRupees(s.expensePaise)}</span>
                </span>
                <span className="flex items-center gap-1.5 text-foreground-muted">
                  <span className="h-2 w-2 rounded-xs bg-income" /> Income <span className="font-numeric font-medium text-foreground">{formatRupees(s.incomePaise)}</span>
                </span>
              </div>
            </Piece>

            <Piece from="translate3d(34%, 30%, 200px) rotateZ(6deg)" a="18%" b="40%" className="col-span-6 sm:col-span-4">
              <p className="text-micro font-medium text-foreground-muted">Income and expenses by month</p>
              <div className="mt-3 flex items-end justify-between gap-2">
                {s.months.map((m) => (
                  <div key={m.key} className="flex flex-1 flex-col items-center gap-1.5">
                    <div className="flex h-20 w-full items-end justify-center gap-0.5 sm:h-24">
                      <span className="w-2.5 rounded-t-xs bg-chart-income sm:w-3" style={{ height: `${(m.incomePaise / max) * 100}%` }} />
                      <span className="w-2.5 rounded-t-xs bg-chart-expense sm:w-3" style={{ height: `${(m.expensePaise / max) * 100}%` }} />
                    </div>
                    <span className="text-[10px] leading-none text-foreground-muted">{formatMonthLabel(m.key, false)}</span>
                  </div>
                ))}
              </div>
            </Piece>

            <Piece from="translate3d(46%, -6%, 240px) rotateZ(-3deg)" a="40%" b="58%" className="col-span-3 sm:col-span-2">
              <div className="flex items-center justify-between gap-1">
                <p className="text-micro text-foreground-muted">New regime</p>
              </div>
              <p className="mt-1 font-numeric text-subheading font-semibold text-foreground">
                {newRegime ? formatRupees(newRegime.totalTaxPaise) : "—"}
              </p>
              <p className="text-micro text-foreground-muted">Total tax</p>
              {lowerBy !== null && <Badge tone="tax" className="mt-2">{formatRupees(lowerBy)} lower</Badge>}
            </Piece>

            <Piece from="translate3d(-30%, 34%, 130px) rotateZ(-4deg)" a="24%" b="44%" className="col-span-6 sm:col-span-4">
              <ul className="divide-y divide-divider">
                {s.recent.slice(0, 3).map((t) => {
                  const income = t.type === "income";
                  const Icon = income ? IconArrowDownLeft : IconArrowUpRight;
                  return (
                    <li key={t.id} className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-pill ${income ? "bg-income-soft text-income" : "bg-expense-soft text-expense"}`}>
                        <Icon width={13} height={13} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-micro text-foreground">{t.description ?? t.category}</span>
                      <span className={`font-numeric text-micro font-medium ${income ? "text-income" : "text-expense"}`}>
                        {formatRupees(income ? t.amountPaise : -t.amountPaise, { showPositiveSign: true })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Piece>

            <Piece from="translate3d(14%, 48%, 280px) scale(0.85)" a="58%" b="76%" className="col-span-3 flex flex-col justify-between border-primary/30 bg-assistant-soft sm:col-span-2">
              <p className="text-micro font-medium text-assistant">Ask SmartCA</p>
              <p className="mt-1 text-micro text-foreground-secondary">Answers with sources</p>
              <span className="mt-2 flex h-9 w-9 items-center justify-center self-end rounded-pill bg-assistant text-assistant-foreground shadow-floating">
                <IconAsk width={16} height={16} />
              </span>
            </Piece>
          </div>
        </div>
      </div>
      <p className="mt-4 text-center text-micro text-foreground-muted lg:text-right">Example figures, computed by SmartCA’s own ledger and tax engine.</p>
    </figure>
  );
}
