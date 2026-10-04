import Link from "next/link";
import type { ComponentType, SVGProps } from "react";
import { IconArrowDownLeft, IconArrowUpRight, IconChevronRight, IconUpload } from "../../components/ui/Icons";

const STEPS: {
  href: string;
  title: string;
  description: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  tone: string;
}[] = [
  {
    href: "/income",
    title: "Record income",
    description: "Salary, freelance work or any money you receive.",
    Icon: IconArrowDownLeft,
    tone: "bg-income-soft text-income",
  },
  {
    href: "/expenses",
    title: "Record an expense",
    description: "Rent, groceries, bills: anything you spend.",
    Icon: IconArrowUpRight,
    tone: "bg-expense-soft text-expense",
  },
  {
    href: "/vault",
    title: "Import a bank statement",
    description: "Bring in many entries at once from a CSV file in Vault.",
    Icon: IconUpload,
    tone: "bg-secondary text-foreground",
  },
];

// The first-run Summary: the shape of what is coming (an empty settled
// figure, ₹0 over its double rule) and three ways to start. No invented
// sample data.
export function GetStarted() {
  return (
    <section aria-labelledby="get-started" className="grid gap-10 lg:grid-cols-12 lg:gap-16">
      <div className="lg:col-span-5">
        <p className="text-label font-medium text-foreground-muted">Net savings</p>
        <div className="mt-2 inline-flex flex-col" aria-hidden="true">
          <p className="font-display font-numeric text-display font-semibold text-foreground-muted/40">₹0</p>
          <span className="mt-3 block h-0.75 border-y border-foreground-muted/40" />
        </div>
        <h2 id="get-started" className="mt-8 text-heading font-semibold text-foreground">
          Your summary starts with your first entry
        </h2>
        <p className="mt-2 max-w-md text-body text-foreground-secondary">
          Record what comes in and what goes out, and this page will show your net savings, how each month compares and where
          your money goes.
        </p>
      </div>

      <ol className="divide-y divide-divider self-start rounded-panel border border-border bg-surface lg:col-span-7">
        {STEPS.map(({ href, title, description, Icon, tone }) => (
          <li key={href} className="first:*:rounded-t-panel last:*:rounded-b-panel">
            <Link
              href={href}
              className="group flex min-h-16 items-center gap-4 px-4 py-3.5 transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken focus-visible:focus-ring sm:px-5"
            >
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-pill ${tone}`}>
                <Icon width={18} height={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium text-foreground">{title}</span>
                <span className="mt-0.5 block text-label text-foreground-muted">{description}</span>
              </span>
              <IconChevronRight className="shrink-0 text-foreground-muted transition-transform duration-(--duration-fast) ease-standard group-hover:translate-x-0.5" />
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}
