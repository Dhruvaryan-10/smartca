"use client";

import { useSyncExternalStore } from "react";

// Appearance preference. "system" (the default) follows the OS; "light"
// and "dark" pin a theme. Stored under the same key the root layout's
// inline script reads before first paint, so there is no flash.
export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "smartca-theme";
const CHANGE_EVENT = "smartca-theme-change";

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage unavailable (private browsing): fall through to system.
  }
  return "system";
}

function applyToDocument(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not persisted; still applied for this page view.
  }
  applyToDocument(preference);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  // Another tab changed the preference: apply it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    applyToDocument(readPreference());
    onChange();
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The current appearance preference; "system" during server render. */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, readPreference, () => "system");
}
