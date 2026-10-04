"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { signOut, useSession } from "next-auth/react";
import { setThemePreference, useThemePreference, type ThemePreference } from "./theme";
import { IconCheck, IconChevronDown } from "./ui/Icons";

const APPEARANCE: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const ITEM =
  "flex h-9 w-full items-center gap-2.5 rounded-xs px-2.5 text-left text-body text-foreground outline-none " +
  "transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken focus-visible:bg-surface-sunken";

// Account menu (WAI-ARIA menu button): Enter, Space or ArrowDown opens
// on the first item, ArrowUp on the last; arrows, Home and End move
// within; Escape closes and returns focus to the button; Tab closes and
// lets focus continue. Appearance lives here rather than as a separate
// top-bar control, defaulting to the system setting.
export default function UserMenu() {
  const { data: session } = useSession();
  const preference = useThemePreference();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<"first" | "last">("first");
  const menuId = useId();

  const name = session?.user?.name || session?.user?.email || "Account";
  const email = session?.user?.name ? session?.user?.email : null;
  const initial = name.charAt(0).toUpperCase();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  const openMenu = (focus: "first" | "last") => {
    focusOnOpen.current = focus;
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const list = items();
    (focusOnOpen.current === "first" ? list[0] : list[list.length - 1])?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onButtonKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openMenu("first");
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu("last");
    }
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(list.length - 1);
      case "Escape":
        event.preventDefault();
        return close(true);
      case "Tab":
        return close(false);
    }
  };

  const choose = (value: ThemePreference) => {
    setThemePreference(value);
    close(true);
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={onButtonKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${name}`}
        className="flex h-10 items-center gap-2 rounded-control pl-1 pr-1.5 transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken focus-visible:focus-ring sm:pr-2"
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-pill bg-surface-sunken text-label font-semibold text-foreground">
          {initial}
        </span>
        <span className="hidden max-w-40 truncate text-body text-foreground sm:inline">{name}</span>
        <IconChevronDown
          className={`hidden text-foreground-muted transition-transform duration-(--duration-normal) ease-standard sm:block ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="menu-enter absolute right-0 z-(--z-dropdown) mt-2 w-64 origin-top-right rounded-md border border-border bg-surface-elevated p-1.5 shadow-floating"
        >
          <div role="presentation" className="px-2.5 pb-2.5 pt-2">
            <p className="truncate text-body font-medium text-foreground">{name}</p>
            {email && <p className="truncate text-label text-foreground-muted">{email}</p>}
          </div>

          <div role="separator" className="-mx-1.5 my-1 h-px bg-divider" />

          <div role="group" aria-labelledby={`${menuId}-appearance`}>
            <p id={`${menuId}-appearance`} role="presentation" className="px-2.5 pb-1 pt-2 text-micro text-foreground-muted">
              Appearance
            </p>
            {APPEARANCE.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={preference === value}
                tabIndex={-1}
                onClick={() => choose(value)}
                className={ITEM}
              >
                <span className="flex w-4 justify-center text-primary">
                  {preference === value && <IconCheck width={16} height={16} />}
                </span>
                {label}
              </button>
            ))}
          </div>

          <div role="separator" className="-mx-1.5 my-1 h-px bg-divider" />

          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            onClick={() => signOut({ callbackUrl: "/login" })}
            className={ITEM}
          >
            <span className="w-4" aria-hidden="true" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
