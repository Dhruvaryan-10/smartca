import type { ComponentType, SVGProps } from "react";
import { IconAsk, IconLedger, IconSummary, IconTax, IconVault } from "./ui/Icons";

export type NavItem = {
  name: string;
  href: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Routes that count as "inside" this destination. */
  paths: string[];
};

// The five primary destinations. Ledger groups the existing income,
// expenses and reports routes (reachable through LedgerTabs) rather than
// adding top-level items; Ask is served by /insights for now.
export const PRIMARY_NAV: NavItem[] = [
  { name: "Summary", href: "/dashboard", Icon: IconSummary, paths: ["/dashboard"] },
  { name: "Ledger", href: "/income", Icon: IconLedger, paths: ["/income", "/expenses", "/reports"] },
  { name: "Tax", href: "/taxes", Icon: IconTax, paths: ["/taxes"] },
  { name: "Vault", href: "/vault", Icon: IconVault, paths: ["/vault"] },
  { name: "Ask", href: "/insights", Icon: IconAsk, paths: ["/insights"] },
];

/** Index of the destination the pathname belongs to, or -1. */
export function activeNavIndex(pathname: string | null): number {
  if (!pathname) return -1;
  return PRIMARY_NAV.findIndex(({ paths }) =>
    paths.some((path) => pathname === path || pathname.startsWith(`${path}/`)),
  );
}
