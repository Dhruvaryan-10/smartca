"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { name: "Income", href: "/income", dot: "bg-income" },
  { name: "Expenses", href: "/expenses", dot: "bg-expense" },
  { name: "Reports", href: "/reports", dot: null },
];

// Sub-navigation within the "Ledger" nav concept, which Sidebar collapses
// to a single link (/income) — this keeps /expenses and /reports reachable
// without adding extra top-level nav items or new routes. Income and
// expenses carry their colour as a small dot beside the word, so the
// distinction is visible before a single figure loads.
export default function LedgerTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Ledger sections" className="-mx-1 flex gap-1 overflow-x-auto border-b border-border px-1">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`-mb-px inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-t-xs border-b-2 px-3 text-body font-medium transition-colors duration-(--duration-fast) ease-standard focus-visible:focus-ring sm:h-10 ${
              active ? "border-border-active text-foreground" : "border-transparent text-foreground-muted hover:text-foreground"
            }`}
          >
            {tab.dot && <span aria-hidden="true" className={`h-2 w-2 rounded-pill ${tab.dot}`} />}
            {tab.name}
          </Link>
        );
      })}
    </nav>
  );
}
