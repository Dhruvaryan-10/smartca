import type { CSSProperties, ReactNode } from "react";
import { formatRupees } from "@/lib/format";
import type { ComputationNode } from "@/tax-engine";
import { SpendingBreakdown } from "../components/charts/SpendingBreakdown";
import { Badge } from "../components/ui/Badge";
import { IconAsk, IconCheck, IconClose, IconDocument, IconDownload } from "../components/ui/Icons";
import { Money } from "../components/ui/Money";
import { SummaryHero } from "../(app)/dashboard/SummaryHero";
import { RecentActivity } from "../(app)/dashboard/RecentActivity";
import RegimeComparison from "../(app)/taxes/RegimeComparison";
import { EXAMPLE_COMPARISON, EXAMPLE_NEW_REGIME, EXAMPLE_SUMMARY, EXAMPLE_TAX_INPUT } from "./landing-data";

// The product story. Each chapter is an editorial spread: a short argument on one side and the real SmartCA interface on the
// other — the same components the app renders, fed example data computed by the same code. Visuals drift gently with scroll
// on desktop (landing.css); they are never hidden, and are static under reduced motion.

/** Start offset for a chapter reveal (landing.css `.chapter-in` / `.chapter-visual`). */
const at = (px: number) => ({ "--s": `${px}px` }) as CSSProperties;

function Chapter({
  id,
  kicker,
  title,
  children,
  points,
  visual,
  flip = false,
}: {
  id: string;
  kicker: string;
  title: string;
  children: ReactNode;
  points: string[];
  visual: ReactNode;
  flip?: boolean;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto grid max-w-[84rem] items-center gap-12 px-gutter lg:grid-cols-12 lg:gap-16">
        <div className={`lg:col-span-5 ${flip ? "lg:order-2" : ""}`}>
          <p className="chapter-in text-label font-medium text-primary">{kicker}</p>
          <h2 id={`${id}-title`} className="chapter-in mt-3 font-display text-[clamp(2rem,1.4rem+2.2vw,3rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-foreground" style={at(30)}>
            {title}
          </h2>
          <div className="chapter-in mt-5 max-w-md text-body-lg text-foreground-secondary" style={at(60)}>
            {children}
          </div>
          <ul className="mt-8 max-w-md divide-y divide-divider border-y border-divider">
            {points.map((point, i) => (
              <li key={point} className="chapter-in flex items-start gap-3 py-3 text-body text-foreground" style={at(90 + i * 30)}>
                <IconCheck width={16} height={16} className="mt-0.5 shrink-0 text-primary" />
                {point}
              </li>
            ))}
          </ul>
        </div>
        <div className={`lg:col-span-7 ${flip ? "lg:order-1" : ""}`}>
          <div className="chapter-visual">
            <div className="landing-drift">{visual}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

// A quiet frame around real product UI: the screen's name, the assessment year, and a hairline.
function ProductFrame({ title, children, note = "Example figures" }: { title: string; children: ReactNode; note?: string }) {
  return (
    <figure className="rounded-dialog border border-border bg-background shadow-standard">
      <div className="flex items-center justify-between border-b border-divider px-5 py-3">
        <span className="text-label font-semibold text-foreground">{title}</span>
        <span className="text-micro text-foreground-muted">{note}</span>
      </div>
      <div className="p-5 sm:p-7">{children}</div>
    </figure>
  );
}

export function SummaryChapter() {
  return (
    <Chapter
      id="summary"
      kicker="Financial clarity"
      title="One figure that tells you where you stand."
      points={["Net savings, set on an accounting double rule", "Income, expenses and savings rate side by side", "Each month compared in plain words"]}
      visual={
        <ProductFrame title="Summary">
          <SummaryHero summary={EXAMPLE_SUMMARY} fitToContainer />
        </ProductFrame>
      }
    >
      Summary leads with your net savings, then shows what it’s made of: what came in, what went out, and how much of every rupee
      you kept.
    </Chapter>
  );
}

export function LedgerChapter() {
  return (
    <Chapter
      id="ledger"
      kicker="Understand your money"
      title="Every rupee, in its place."
      flip
      points={["Entries grouped by month, with each month’s total", "Search, category and month filters", "Bank statements imported from CSV, checked first"]}
      visual={
        <ProductFrame title="Ledger">
          <div className="grid gap-8 md:grid-cols-2">
            <div>
              <p className="mb-3 text-subheading font-semibold text-foreground">Where your money goes</p>
              <SpendingBreakdown categories={EXAMPLE_SUMMARY.categories} totalPaise={EXAMPLE_SUMMARY.expensePaise} />
            </div>
            <div>
              <p className="mb-3 text-subheading font-semibold text-foreground">Recent activity</p>
              <RecentActivity items={EXAMPLE_SUMMARY.recent.slice(0, 5)} />
            </div>
          </div>
        </ProductFrame>
      }
    >
      The Ledger is your own record of what comes in and what goes out. Income reads green, spending coral, and every amount carries
      its sign, so the difference never depends on colour alone.
    </Chapter>
  );
}

function SheetRows({ node }: { node: ComputationNode }) {
  return (
    <ul className="text-label">
      {node.children.map((child, i) => (
        <li key={`${child.label}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 border-b border-divider py-2">
          <span className="min-w-0 truncate text-foreground-secondary">{child.label}</span>
          <span className="font-numeric text-foreground">{formatRupees(child.amountPaise)}</span>
        </li>
      ))}
      <li className="rule-subtotal rule-settled mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-2.5">
        <span className="font-semibold text-foreground">{node.label}</span>
        <span className="font-numeric text-subheading font-semibold text-foreground">{formatRupees(node.amountPaise)}</span>
      </li>
    </ul>
  );
}

export function TaxChapter() {
  const salary = EXAMPLE_TAX_INPUT.incomeSources[0].amountPaise;
  return (
    <Chapter
      id="tax"
      kicker="Tax intelligence"
      title="Both regimes, worked out in full."
      points={[
        "Old and new regime computed for AY 2026-27",
        "A computation sheet with every step and section",
        "Saved computations, stored exactly as calculated",
      ]}
      visual={
        <ProductFrame title="Tax" note={`Example: salary ${formatRupees(salary)}, 80C ₹1,50,000`}>
          <RegimeComparison comparison={EXAMPLE_COMPARISON} />
          {EXAMPLE_NEW_REGIME && (
            <div className="mt-8 rounded-panel border border-border bg-surface px-4 pb-2 pt-4 sm:px-5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-subheading font-semibold text-foreground">How the tax was worked out</p>
                <Badge tone="tax">Tax engine · new regime</Badge>
              </div>
              <SheetRows node={EXAMPLE_NEW_REGIME.tree} />
            </div>
          )}
        </ProductFrame>
      }
    >
      Enter your income and deductions. SmartCA’s tax engine computes both regimes, states the difference in rupees and shows every
      step. It never chooses a regime for you.
    </Chapter>
  );
}

export function VaultChapter() {
  return (
    <Chapter
      id="vault"
      kicker="Your financial vault"
      title="Documents you can trust. Values you confirm."
      flip
      points={[
        "Form 16 salary figures read from digital PDFs",
        "The page each value came from, shown beside it",
        "Nothing used for tax until you confirm it",
      ]}
      visual={
        <ProductFrame title="Vault">
          <ul className="divide-y divide-divider rounded-panel border border-border bg-surface">
            {[
              { name: "form16-employer-2025-26.pdf", status: "Confirmed", tone: "success" as const, dot: "bg-success", hint: "Its values are offered on the Tax page." },
              { name: "form16-previous-employer.pdf", status: "Needs review", tone: "warning" as const, dot: "bg-warning", hint: "Check the values read from it before they can be used." },
            ].map((doc) => (
              <li key={doc.name} className="flex items-start gap-3.5 px-4 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-foreground-secondary">
                  <IconDocument />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="min-w-0 truncate text-body font-medium text-foreground">{doc.name}</p>
                    <Badge tone={doc.tone}>
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-pill ${doc.dot}`} />
                      {doc.status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-label text-foreground-muted">Form 16 · AY 2026-27</p>
                  <p className="mt-0.5 text-label text-foreground-secondary">{doc.hint}</p>
                </div>
                <IconDownload width={16} height={16} className="mt-1 hidden shrink-0 text-foreground-muted sm:block" />
              </li>
            ))}
          </ul>
          <div className="mt-6 rounded-panel border border-border bg-surface p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-subheading font-semibold text-foreground">Salary income SmartCA will use</p>
              <Badge>Read from PDF · page 2</Badge>
            </div>
            <dl className="mt-3 text-body">
              <div className="flex items-baseline justify-between gap-4 border-b border-divider py-2">
                <dt className="text-foreground-secondary">Gross salary</dt>
                <dd className="font-numeric text-foreground">{formatRupees(14_40_000_00)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-b border-divider py-2">
                <dt className="text-foreground-secondary">Less: exempt under Section 10</dt>
                <dd className="font-numeric text-foreground">{formatRupees(0)}</dd>
              </div>
              <div className="rule-subtotal rule-settled mt-1 flex items-baseline justify-between gap-4 py-2.5">
                <dt className="font-semibold text-foreground">Salary income</dt>
                <dd className="font-numeric text-heading font-semibold text-foreground">{formatRupees(14_40_000_00)}</dd>
              </div>
            </dl>
          </div>
        </ProductFrame>
      }
    >
      Upload a Form 16 and SmartCA reads its salary figures, showing the page each one came from. You check them, change anything,
      and only then are they offered to your tax computation.
    </Chapter>
  );
}

// Income to insight, as one connected picture. Bars and connectors are proportional to the example figures; every number is
// written beside its shape, so the picture never has to be decoded.
export function FlowSection() {
  const s = EXAMPLE_SUMMARY;
  const cats = s.categories.slice(0, 4);
  const restPaise = s.expensePaise - cats.reduce((sum, c) => sum + c.totalPaise, 0);
  const top = s.categories[0];
  return (
    <section id="flow" aria-labelledby="flow-title" className="scroll-mt-20 border-y border-divider bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-[84rem] px-gutter">
        <div className="max-w-2xl">
          <p className="chapter-in text-label font-medium text-primary">The whole picture</p>
          <h2 id="flow-title" className="chapter-in mt-3 font-display text-[clamp(2rem,1.4rem+2.2vw,3rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-foreground" style={at(30)}>
            From income to insight.
          </h2>
          <p className="chapter-in mt-5 text-body-lg text-foreground-secondary" style={at(60)}>
            What came in, where it went, what stayed, and what that means — in one continuous reading, the way SmartCA lays out your
            own figures.
          </p>
        </div>

        <figure className="mt-14 grid gap-6 lg:grid-cols-[1fr_auto_1.2fr_auto_1fr] lg:items-stretch lg:gap-0">
          <figcaption className="sr-only">
            Example: {formatRupees(s.incomePaise)} of income; {formatRupees(s.expensePaise)} spent, mostly on {top?.category}; {formatRupees(s.savingsPaise)} kept.
          </figcaption>

          <div className="chapter-visual flex flex-col justify-center rounded-panel border border-border bg-background p-6" style={at(-60)}>
            <p className="text-label text-foreground-muted">Came in</p>
            <Money paise={s.incomePaise} kind="income" className="mt-1 block text-figure font-semibold" />
            <div className="mt-4 h-2 rounded-pill bg-income" />
            <p className="mt-3 text-label text-foreground-secondary">Salary and freelance work, six months</p>
          </div>

          <Connector />

          <div className="chapter-visual rounded-panel border border-border bg-background p-6" style={at(0)}>
            <p className="text-label text-foreground-muted">Went out, and stayed</p>
            <ul className="mt-3 space-y-2.5">
              {cats.map((c, i) => (
                <li key={c.category} className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 text-label">
                  <span className="truncate text-foreground">{c.category}</span>
                  <span className="h-2 rounded-pill" style={{ width: `${Math.max(4, (c.totalPaise / s.incomePaise) * 100 * 1.6)}%`, backgroundColor: `color-mix(in srgb, var(--expense) ${[100, 78, 60, 46][i]}%, var(--surface))` }} />
                  <Money paise={c.totalPaise} kind="expense" />
                </li>
              ))}
              {restPaise > 0 && (
                <li className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 text-label">
                  <span className="truncate text-foreground">Everything else</span>
                  <span className="h-2 rounded-pill bg-foreground-muted/40" style={{ width: `${Math.max(4, (restPaise / s.incomePaise) * 100 * 1.6)}%` }} />
                  <Money paise={restPaise} kind="expense" />
                </li>
              )}
              <li className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 border-t border-divider pt-2.5 text-label">
                <span className="font-medium text-foreground">Kept</span>
                <span className="h-2 rounded-pill bg-income" style={{ width: `${Math.min(100, (s.savingsPaise / s.incomePaise) * 100 * 1.6)}%` }} />
                <Money paise={s.savingsPaise} kind="income" className="font-semibold" />
              </li>
            </ul>
          </div>

          <Connector />

          <div className="chapter-visual flex flex-col justify-center rounded-panel border border-primary/30 bg-assistant-soft p-6" style={at(60)}>
            <p className="text-label font-medium text-assistant">What it means</p>
            <p className="mt-2 text-heading font-semibold text-foreground">You kept {s.savingsRatePercent}% of what you earned.</p>
            <p className="mt-2 text-body text-foreground-secondary">
              {top?.category} is {top?.sharePercent}% of your spending — the largest single line, and the first place a change would
              show.
            </p>
          </div>
        </figure>
        <p className="mt-4 text-micro text-foreground-muted">Example figures, computed by SmartCA’s ledger summary.</p>
      </div>
    </section>
  );
}

function Connector() {
  return (
    <svg aria-hidden="true" viewBox="0 0 64 120" preserveAspectRatio="none" className="mx-auto hidden h-full w-16 text-border-strong lg:block">
      <path className="flow-path" pathLength={1} d="M0 60 C 32 60, 32 20, 64 20" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path className="flow-path" pathLength={1} d="M0 60 C 32 60, 32 60, 64 60" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path className="flow-path" pathLength={1} d="M0 60 C 32 60, 32 100, 64 100" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

// Ask SmartCA's moment: the teal identity, the launcher, and an answer laid out the way the product lays one out —
// explanation, the figures' provenance, sources. The copy states what is actually implemented, including that it needs
// permission and an assistant model switched on by the deployment.
export function AskSection() {
  const c = EXAMPLE_COMPARISON;
  const oldTax = c.old.status === "ok" ? c.old.result.totalTaxPaise : 0;
  const newTax = c.new.status === "ok" ? c.new.result.totalTaxPaise : 0;
  const diff = c.numbers?.differencePaise ?? 0;
  return (
    <section id="ask" aria-labelledby="ask-title" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto grid max-w-[84rem] items-center gap-12 px-gutter lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <span className="chapter-in flex h-11 w-11 items-center justify-center rounded-pill bg-assistant text-assistant-foreground">
            <IconAsk />
          </span>
          <p className="chapter-in mt-6 text-label font-medium text-assistant" style={at(20)}>Ask SmartCA</p>
          <h2 id="ask-title" className="chapter-in mt-3 font-display text-[clamp(2rem,1.4rem+2.2vw,3rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-foreground" style={at(40)}>
            Answers that show their working.
          </h2>
          <p className="chapter-in mt-5 max-w-md text-body-lg text-foreground-secondary" style={at(70)}>
            Ask about your ledger, your tax under either regime, or Indian income-tax rules. Ask SmartCA answers with SmartCA’s own
            tools — the tax engine, your ledger and official tax sources — and marks where each figure came from.
          </p>
          <ul className="mt-8 max-w-md divide-y divide-divider border-y border-divider">
            {[
              "Asks your permission first, and shows exactly what would be shared",
              "Withdraw that permission at any time",
              "Explanations are labelled, never presented as the figures themselves",
            ].map((point, i) => (
              <li key={point} className="chapter-in flex items-start gap-3 py-3 text-body text-foreground" style={at(100 + i * 30)}>
                <IconCheck width={16} height={16} className="mt-0.5 shrink-0 text-assistant" />
                {point}
              </li>
            ))}
          </ul>
          <p className="chapter-in mt-4 max-w-md text-label text-foreground-muted" style={at(190)}>
            Available when your SmartCA deployment switches on an assistant model. Until then, SmartCA says so plainly.
          </p>
        </div>

        <div className="lg:col-span-7">
          <div className="chapter-visual">
            <div className="landing-drift relative pb-10 sm:pb-12">
              <figure className="ml-auto max-w-xl overflow-hidden rounded-dialog border border-border bg-surface-elevated shadow-modal">
                <figcaption className="sr-only">An example Ask SmartCA answer comparing the two tax regimes, with its sources.</figcaption>
                <div aria-hidden="true">
                  <div className="flex items-center justify-between border-b border-divider px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-7 w-7 items-center justify-center rounded-pill bg-assistant-soft text-assistant">
                        <IconAsk width={15} height={15} />
                      </span>
                      <span className="text-body font-semibold text-foreground">Ask SmartCA</span>
                    </div>
                    <IconClose width={16} height={16} className="text-foreground-muted" />
                  </div>
                  <div className="space-y-4 px-5 py-5">
                    <div>
                      <p className="text-micro font-medium text-foreground-muted">You asked</p>
                      <p className="mt-1 text-body font-medium text-foreground">Which regime works out lower for me this year?</p>
                    </div>
                    <div className="space-y-3 border-l-2 border-assistant pl-3.5">
                      <div>
                        <p className="text-micro font-medium text-foreground-muted">Explanation</p>
                        <p className="mt-1 text-body text-foreground">
                          With your figures, total tax is {formatRupees(newTax)} under the new regime and {formatRupees(oldTax)} under the
                          old one, so the new regime is {formatRupees(diff)} lower. The old regime allows your Section 80C deduction, but
                          its slab rates are higher.
                        </p>
                      </div>
                      <div className="border-l-2 border-tax pl-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="tax">Tax engine</Badge>
                          <span className="text-label text-foreground">Regime comparison from the SmartCA tax engine</span>
                        </div>
                        <p className="mt-1 font-mono text-micro text-foreground-muted">AY 2026-27</p>
                      </div>
                      <div>
                        <p className="text-micro font-medium text-foreground-muted">Sources</p>
                        <p className="mt-1 text-label text-primary">1. Official guidance · AY 2026-27</p>
                      </div>
                    </div>
                  </div>
                  <div className="border-t border-divider px-5 py-3 text-micro text-foreground-muted">Example answer. Explanations are written by a language model.</div>
                </div>
              </figure>
              <span aria-hidden="true" className="absolute bottom-0 right-2 flex h-14 w-14 items-center justify-center rounded-pill bg-assistant text-assistant-foreground shadow-floating ring-4 ring-assistant-halo sm:right-6">
                <IconAsk width={22} height={22} />
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Principles() {
  const items = [
    { title: "Computed, not guessed", body: "Tax comes from a deterministic engine: the same inputs always give the same figures, with the rules version shown." },
    { title: "Nothing used without your say", body: "Form 16 values wait for your confirmation. The assistant waits for your permission." },
    { title: "Every step shown", body: "Derivation trees, section references and sources. If SmartCA can’t support something, it says so." },
  ];
  return (
    <section aria-labelledby="principles-title" className="border-t border-divider py-20 sm:py-24">
      <div className="mx-auto max-w-[84rem] px-gutter">
        <h2 id="principles-title" className="chapter-in max-w-xl font-display text-[clamp(1.75rem,1.3rem+1.6vw,2.25rem)] font-semibold leading-tight tracking-[-0.025em] text-foreground">
          Honest by construction.
        </h2>
        <div className="mt-10 grid gap-10 md:grid-cols-3 md:gap-12">
          {items.map((item, i) => (
            <div key={item.title} className="chapter-in rule-subtotal pt-5" style={at(40 + i * 60)}>
              <h3 className="text-heading font-semibold text-foreground">{item.title}</h3>
              <p className="mt-2 text-body text-foreground-secondary">{item.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
