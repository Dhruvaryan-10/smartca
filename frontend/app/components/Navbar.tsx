"use client";

import type { RefObject } from "react";
import ThemeToggle from "./ThemeToggle";
import UserMenu from "./UserMenu";
import { IconMenu } from "./ui/Icons";

export default function Navbar({
  onMenuClick,
  menuButtonRef,
}: {
  onMenuClick?: () => void;
  menuButtonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-border px-4 sm:px-8">
      <div className="flex items-center gap-3">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className="-ml-1.5 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-foreground transition-colors hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
        >
          <IconMenu />
        </button>

        {/* Only AY 2026-27 is supported today, so this is plain context,
            not a selector — a disabled dropdown reads as a broken control. */}
        <p className="text-[13px] text-muted-foreground">
          <span className="sr-only">Assessment year </span>
          <span aria-hidden="true">AY </span>
          <span className="font-medium text-foreground">2026-27</span>
        </p>
      </div>

      <div className="flex items-center gap-1">
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
