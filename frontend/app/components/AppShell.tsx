"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Navbar from "./Navbar";
import Sidebar from "./Sidebar";

// Shared authenticated-app frame: persistent sidebar on large screens,
// a slide-over drawer below that, plus the header. Every authenticated
// page renders its own content as `children`; business logic/API calls
// stay in the page components, unchanged.
export default function AppShell({ children }: { children: ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const openMobileNav = () => setMobileNavOpen(true);
  const closeMobileNav = () => {
    setMobileNavOpen(false);
    menuButtonRef.current?.focus();
  };

  // Keyboard access for the drawer: Escape closes it, and focus moves
  // into it on open so keyboard/screen-reader users land somewhere
  // useful instead of behind an invisible overlay.
  useEffect(() => {
    if (!mobileNavOpen) return;
    drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMobileNav();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-[var(--radius-sm)] focus:bg-elevated focus:px-3 focus:py-2 focus:text-sm focus:shadow-[var(--shadow-md)]"
      >
        Skip to content
      </a>
      <div className="sticky top-0 hidden h-screen shrink-0 border-r border-border lg:block">
        <Sidebar />
      </div>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation menu"
            className="shell-overlay-enter absolute inset-0 bg-black/45"
            onClick={closeMobileNav}
          />
          <div ref={drawerRef} className="shell-drawer-enter relative z-10 h-full shadow-[var(--shadow-md)]">
            <Sidebar onNavigate={closeMobileNav} onClose={closeMobileNav} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Navbar onMenuClick={openMobileNav} menuButtonRef={menuButtonRef} />
        <main id="main" tabIndex={-1} className="flex-1 px-4 py-8 focus:outline-none sm:px-8 sm:py-10">
          {/* page-enter: a brief fade/settle so navigation reads as a
              change of view (disabled under prefers-reduced-motion). */}
          <div className="page-enter mx-auto w-full max-w-5xl space-y-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
