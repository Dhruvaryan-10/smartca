"use client";

import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import Topbar from "./Topbar";
import AssistantLauncher from "./assistant/AssistantLauncher";
import { PRIMARY_NAV, activeNavIndex } from "./navigation";
import { usePrefersReducedMotion } from "./useReducedMotion";

type DrawerState = "closed" | "open" | "closing";

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

// The authenticated frame, rendered once by app/(app)/layout.tsx so it
// persists across navigation: a fixed sidebar from lg, a modal drawer
// below that, a sticky top bar and the page container. Pages render only
// their content; data fetching and business logic stay in the pages.
export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduceMotion = usePrefersReducedMotion();
  const [drawer, setDrawer] = useState<DrawerState>("closed");
  const [condensed, setCondensed] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);

  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const restoreFocusToMenu = useRef(false);
  const isFirstPathname = useRef(true);

  const activeIndex = activeNavIndex(pathname);
  const section = activeIndex >= 0 ? PRIMARY_NAV[activeIndex].name : null;
  const drawerOpen = drawer === "open";

  const closeDrawer = (restoreFocus: boolean) => {
    restoreFocusToMenu.current = restoreFocus;
    setDrawer(reduceMotion ? "closed" : "closing");
  };

  // Any route change (link, back/forward) closes an open drawer.
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    if (drawer === "open") setDrawer(reduceMotion ? "closed" : "closing");
  }

  // After client navigation, move focus to the new page so keyboard and
  // screen-reader users start at its content, not on a stale nav link.
  useEffect(() => {
    if (isFirstPathname.current) {
      isFirstPathname.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  // Focus returns to the menu button only once the page behind the
  // drawer is no longer inert.
  useEffect(() => {
    if (!drawerOpen && restoreFocusToMenu.current) {
      restoreFocusToMenu.current = false;
      menuButtonRef.current?.focus();
    }
  }, [drawerOpen]);

  // While the drawer is open: focus moves into it, the page behind does
  // not scroll, Escape closes it, and it closes if the viewport grows to
  // the fixed-sidebar layout.
  useEffect(() => {
    if (!drawerOpen) return;
    drawerRef.current?.querySelector<HTMLElement>("nav a")?.focus();
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer(true);
    };
    const wide = window.matchMedia("(min-width: 1024px)");
    const onWide = () => {
      if (wide.matches) setDrawer("closed");
    };
    document.addEventListener("keydown", onKeyDown);
    wide.addEventListener("change", onWide);
    return () => {
      root.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      wide.removeEventListener("change", onWide);
    };
    // closeDrawer only reads refs and the reduced-motion flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen]);

  // The exit animation normally ends the closing state; this guarantees
  // the overlay never lingers if no animationend arrives.
  useEffect(() => {
    if (drawer !== "closing") return;
    const timer = window.setTimeout(() => setDrawer("closed"), 400);
    return () => window.clearTimeout(timer);
  }, [drawer]);

  // The top bar gains its edge and section title once the top of the
  // page has scrolled beneath it.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(([entry]) => setCondensed(!entry.isIntersecting), {
      rootMargin: "-56px 0px 0px 0px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Tab and Shift+Tab stay inside the open drawer.
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !drawerRef.current) return;
    const focusable = Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onDrawerNavigate = (href: string) => {
    // Same page: no route change will move focus, so do it here.
    closeDrawer(false);
    if (href === pathname) requestAnimationFrame(() => mainRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div data-app-shell className="flex min-h-screen bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-(--z-toast) focus:rounded-control focus:bg-surface-elevated focus:px-3 focus:py-2 focus:text-body focus:shadow-floating focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        Skip to content
      </a>

      <aside aria-label="Sidebar" className="sticky top-0 hidden h-screen shrink-0 border-r border-divider lg:block">
        <Sidebar />
      </aside>

      {drawer !== "closed" && (
        <div className="fixed inset-0 z-(--z-drawer) lg:hidden">
          <div
            aria-hidden="true"
            onClick={() => closeDrawer(true)}
            className={`absolute inset-0 bg-overlay ${drawer === "closing" ? "shell-overlay-exit" : "shell-overlay-enter"}`}
          />
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            onKeyDown={trapFocus}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget && drawer === "closing") setDrawer("closed");
            }}
            className={`relative h-full w-[min(18rem,85vw)] shadow-floating ${
              drawer === "closing" ? "shell-drawer-exit" : "shell-drawer-enter"
            }`}
          >
            <Sidebar variant="drawer" onNavigate={onDrawerNavigate} onClose={() => closeDrawer(true)} />
          </div>
        </div>
      )}

      <div inert={drawerOpen} className="flex min-w-0 flex-1 flex-col">
        <Topbar
          section={section}
          condensed={condensed}
          onMenuClick={() => setDrawer("open")}
          menuButtonRef={menuButtonRef}
        />
        {/* Bottom padding keeps the last content clear of the floating Ask button. */}
        <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 px-gutter pb-28 pt-6 outline-none sm:pt-8">
          <div ref={sentinelRef} aria-hidden="true" className="h-px" />
          <div className="mx-auto w-full max-w-data">{children}</div>
        </main>
        {/* Inside the content column, so it is inert while the drawer is open. */}
        <AssistantLauncher />
      </div>
    </div>
  );
}
