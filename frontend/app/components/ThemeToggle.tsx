"use client";

import { useEffect, useState } from "react";
import { IconSun, IconMoon } from "./ui/Icons";

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("smartca-theme", theme);
  } catch {
    // Private browsing / storage disabled — theme just won't persist.
  }
}

export default function ThemeToggle() {
  // Starts null so the button renders identically on server and first
  // client paint (no hydration mismatch); resolves to the real value
  // right after mount, reading whatever the layout's inline script (or
  // the OS preference) already applied.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    // Reading document/matchMedia (an external system) is exactly what
    // effects are for; the resulting setState can't be avoided without
    // reintroducing a server/client hydration mismatch on `theme`.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current === "dark" || (!current && prefersDark) ? "dark" : "light");
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-inset hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {theme === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}
