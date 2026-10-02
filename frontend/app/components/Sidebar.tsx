"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRIMARY_NAV, activeNavIndex } from "./navigation";
import { IconClose } from "./ui/Icons";
import { Wordmark } from "./ui/Wordmark";

// Quiet by design: same surface as the page, no fill on inactive items.
// "You are here" is a single sunken fill that slides between items when
// the destination changes (instant under reduced motion), plus the
// accent on the current item's icon and aria-current.
//
// `rail` is the fixed desktop sidebar; `drawer` is the mobile instance,
// with 44px touch targets and a visible close button.
export default function Sidebar({
  variant = "rail",
  onNavigate,
  onClose,
}: {
  variant?: "rail" | "drawer";
  onNavigate?: (href: string) => void;
  onClose?: () => void;
}) {
  const pathname = usePathname();
  const active = activeNavIndex(pathname);
  const drawer = variant === "drawer";

  return (
    <div
      className={`flex h-full flex-col bg-background px-3 pb-4 ${drawer ? "w-full pt-2" : "w-(--sidebar-width) pt-3"}`}
    >
      <div className="flex h-11 items-center justify-between pl-2.5">
        <Link
          href="/dashboard"
          onClick={() => onNavigate?.("/dashboard")}
          aria-label="SmartCA, go to Summary"
          className="rounded-control focus-visible:focus-ring"
        >
          <Wordmark />
        </Link>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation"
            className="inline-flex h-11 w-11 items-center justify-center rounded-control text-foreground-muted transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken hover:text-foreground focus-visible:focus-ring"
          >
            <IconClose />
          </button>
        )}
      </div>

      <nav
        aria-label="Primary"
        className={`relative mt-6 flex flex-col gap-(--nav-gap) [--nav-gap:2px] ${drawer ? "[--nav-item:2.75rem]" : "[--nav-item:2.25rem]"}`}
      >
        {active >= 0 && (
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-(--nav-item) rounded-control bg-surface-sunken transition-transform duration-(--duration-normal) ease-standard"
            style={{ transform: `translateY(calc(${active} * (var(--nav-item) + var(--nav-gap))))` }}
          />
        )}
        {PRIMARY_NAV.map(({ name, href, Icon }, index) => {
          const current = index === active;
          return (
            <Link
              key={href}
              href={href}
              onClick={() => onNavigate?.(href)}
              aria-current={current ? "page" : undefined}
              className={`relative flex h-(--nav-item) items-center gap-3 rounded-control px-2.5 text-body font-medium transition-colors duration-(--duration-fast) ease-standard focus-visible:focus-ring ${
                current ? "text-foreground" : "text-foreground-muted hover:bg-surface-sunken/60 hover:text-foreground"
              }`}
            >
              <Icon className={current ? "text-primary" : undefined} />
              {name}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
