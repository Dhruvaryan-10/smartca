"use client";

import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { IconChevronDown } from "./ui/Icons";

export default function UserMenu() {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const name = session?.user?.name || session?.user?.email || "Account";
  const initial = name.charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onClickAway = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
        className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 transition-colors hover:bg-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-inset text-[13px] font-medium text-foreground">
          {initial}
        </span>
        <span className="hidden max-w-[10rem] truncate text-[13px] text-foreground sm:inline">{name}</span>
        <IconChevronDown className="hidden text-muted-foreground sm:block" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-[var(--radius-md)] border border-border bg-elevated shadow-[var(--shadow-md)]"
        >
          <div className="truncate border-b border-border px-3 py-2 text-xs text-muted-foreground">{name}</div>
          <button
            role="menuitem"
            type="button"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="block w-full px-3 py-2 text-left text-sm text-foreground hover:bg-inset focus-visible:bg-inset focus-visible:outline-none"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
