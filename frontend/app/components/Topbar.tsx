"use client";

import type { RefObject } from "react";
import UserMenu from "./UserMenu";
import { IconMenu } from "./ui/Icons";

// Sticky top bar. At the top of a page it has no edge: it is part of the
// paper. Once content scrolls beneath it, a hairline and a faint shadow
// appear and the current section's name condenses in (always shown below
// lg, where there is no sidebar to say where you are).
export default function Topbar({
  section,
  condensed,
  onMenuClick,
  menuButtonRef,
}: {
  section: string | null;
  condensed: boolean;
  onMenuClick: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header
      className={`sticky top-0 z-(--z-sticky) flex h-(--header-height) items-center justify-between gap-3 border-b bg-background px-gutter transition-[border-color,box-shadow] duration-(--duration-normal) ease-standard ${
        condensed ? "border-border shadow-raised" : "border-transparent"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={onMenuClick}
          aria-label="Open navigation"
          aria-haspopup="dialog"
          className="-ml-2.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-foreground transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken focus-visible:focus-ring lg:hidden"
        >
          <IconMenu />
        </button>

        {/* A visual echo of the page heading, which screen readers
            already get from the page's own h1. */}
        {section && (
          <p
            aria-hidden="true"
            className={`truncate text-body font-semibold text-foreground transition-opacity duration-(--duration-normal) ease-standard ${
              condensed ? "lg:opacity-100" : "lg:opacity-0"
            }`}
          >
            {section}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {/* Only AY 2026-27 is supported, so this is context, not a
            selector: a disabled dropdown reads as a broken control. */}
        <p className="text-label text-foreground-muted">
          <span className="sr-only">Assessment year </span>
          <span aria-hidden="true">AY </span>
          <span className="font-medium text-foreground font-numeric">2026-27</span>
        </p>
        <UserMenu />
      </div>
    </header>
  );
}
