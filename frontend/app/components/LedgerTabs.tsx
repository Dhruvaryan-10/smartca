"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { name: "Income", href: "/income" },
  { name: "Expenses", href: "/expenses" },
  { name: "Reports", href: "/reports" },
];

// Sub-navigation within the "Ledger" nav concept, which Sidebar collapses
// to a single link (/income) — this keeps /expenses and /reports reachable
// without adding extra top-level nav items or new routes.
export default function LedgerTabs() {
  const pathname = usePathname();

  return (
    <nav aria-label="Ledger sections" className="flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
              ${active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {tab.name}
          </Link>
        );
      })}
    </nav>
  );
}
