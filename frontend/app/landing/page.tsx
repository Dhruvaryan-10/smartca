import type { Metadata } from "next";
import Link from "next/link";
import { auth } from "@/auth";
import { buttonClasses } from "../components/ui/Button";
import { Wordmark } from "../components/ui/Wordmark";
import { Hero } from "./Hero";
import { AskSection, FlowSection, LedgerChapter, Principles, SummaryChapter, TaxChapter, VaultChapter } from "./Story";
import "./landing.css";

export const metadata: Metadata = {
  title: "SmartCA — Your money, worked out",
  description:
    "A calm ledger for your income, spending and tax. SmartCA does the arithmetic, compares both tax regimes for AY 2026-27, shows every step, and never uses a figure you haven’t confirmed.",
};

const NAV = [
  { href: "#summary", label: "Summary" },
  { href: "#ledger", label: "Ledger" },
  { href: "#tax", label: "Tax" },
  { href: "#vault", label: "Vault" },
  { href: "#ask", label: "Ask SmartCA" },
];

// The public SmartCA page. A server component with no client JavaScript of its own beyond the small spending breakdown it
// borrows from the app: the signature sequence and every other motion are scroll-linked CSS (landing.css). The session is read
// only to offer "Open SmartCA" instead of sign-up to someone already signed in.
export default async function LandingPage() {
  const session = await auth();
  const signedIn = Boolean(session?.user);

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-(--z-toast) focus:rounded-control focus:bg-surface-elevated focus:px-3 focus:py-2 focus:text-body focus:shadow-floating focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        Skip to content
      </a>

      <header className="landing-header sticky top-0 z-(--z-sticky) bg-background">
        <div className="mx-auto flex h-16 max-w-[84rem] items-center justify-between gap-6 px-gutter">
          <Link href="/landing" aria-label="SmartCA home" className="rounded-control focus-visible:focus-ring">
            <Wordmark />
          </Link>
          <nav aria-label="Explore SmartCA" className="hidden lg:block">
            <ul className="flex items-center gap-7">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="landing-link rounded-xs py-1 text-body text-foreground-secondary hover:text-foreground focus-visible:focus-ring">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            {signedIn ? (
              <Link href="/dashboard" className={buttonClasses("primary", "md")}>
                Open SmartCA
              </Link>
            ) : (
              <>
                <Link href="/login" className={buttonClasses("ghost", "md", "text-foreground")}>
                  Sign in
                </Link>
                <Link href="/signup" className={buttonClasses("primary", "md")}>
                  Get started
                </Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="outline-none">
        <Hero signedIn={signedIn} />
        <div id="story" className="scroll-mt-16">
          <SummaryChapter />
          <LedgerChapter />
          <TaxChapter />
          <VaultChapter />
        </div>
        <FlowSection />
        <AskSection />
        <Principles />

        <section aria-labelledby="final-title" className="border-t border-divider py-24 sm:py-36">
          <div className="mx-auto max-w-[84rem] px-gutter text-center">
            <h2 id="final-title" className="mx-auto max-w-4xl font-display text-[clamp(2.75rem,1.4rem+5.2vw,5.5rem)] font-semibold leading-[1.02] tracking-[-0.04em] text-foreground">
              Know every figure.
              <br />
              <span className="text-foreground-muted">See every step.</span>
            </h2>
            <p className="mx-auto mt-6 max-w-lg text-body-lg text-foreground-secondary">
              Record what comes in and what goes out. SmartCA does the arithmetic, works out your tax, and shows its working.
            </p>
            <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href={signedIn ? "/dashboard" : "/signup"} className={buttonClasses("primary", "lg", "w-full sm:w-auto")}>
                {signedIn ? "Open SmartCA" : "Get started"}
              </Link>
              {!signedIn && (
                <Link href="/login" className={buttonClasses("outline", "lg", "w-full sm:w-auto")}>
                  Sign in
                </Link>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-divider">
        <div className="mx-auto flex max-w-[84rem] flex-col gap-4 px-gutter py-10 sm:flex-row sm:items-center sm:justify-between">
          <Wordmark />
          <p className="max-w-xl text-label text-foreground-muted">
            SmartCA computes tax for resident individuals for AY 2026-27 and lists what it doesn’t cover. It isn’t tax advice; check with a
            chartered accountant before you file.
          </p>
        </div>
      </footer>
    </div>
  );
}
