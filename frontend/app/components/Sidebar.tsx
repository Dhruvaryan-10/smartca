"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconSummary, IconLedger, IconTax, IconVault, IconAsk, IconClose } from "./ui/Icons";

// Conceptual primary nav (Phase 2). Existing routes map onto it rather
// than inventing new ones, except Vault, which has no existing analog
// and is a deliberate coming-soon placeholder (see app/vault/page.tsx).
const NAV = [
  { name: "Summary", href: "/dashboard", Icon: IconSummary, match: (p: string) => p === "/dashboard" },
  { name: "Ledger", href: "/income", Icon: IconLedger, match: (p: string) => ["/income", "/expenses", "/reports"].includes(p) },
  { name: "Tax", href: "/taxes", Icon: IconTax, match: (p: string) => p === "/taxes" },
  { name: "Vault", href: "/vault", Icon: IconVault, match: (p: string) => p === "/vault" },
  { name: "Ask", href: "/insights", Icon: IconAsk, match: (p: string) => p === "/insights" },
];

// Quiet by design: same surface as the page, no fill on inactive items,
// and the accent appears in exactly one place — the active item's icon.
// Position and a subtle fill carry "you are here"; colour only confirms it.
export default function Sidebar({
  onNavigate,
  onClose,
}: {
  onNavigate?: () => void;
  /** Present only for the mobile drawer instance — renders a visible close affordance. */
  onClose?: () => void;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full w-64 flex-col bg-background px-3 py-4 lg:w-60">
      <div className="flex h-9 items-center justify-between px-2.5">
        <span className="text-[15px] font-semibold tracking-tight text-foreground">SmartCA</span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-inset hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <IconClose />
          </button>
        )}
      </div>

      <nav aria-label="Primary" className="mt-6 flex flex-col gap-0.5">
        {NAV.map(({ name, href, Icon, match }) => {
          const active = match(pathname ?? "");
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={`flex h-9 items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 text-[13.5px] font-medium transition-colors duration-150 ease-[var(--ease-standard)]
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                ${active ? "bg-inset text-foreground" : "text-muted-foreground hover:bg-inset/60 hover:text-foreground"}`}
            >
              <Icon className={active ? "text-primary" : "text-muted-foreground"} />
              {name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
