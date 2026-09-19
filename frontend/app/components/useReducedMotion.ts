"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

// For motion CSS can't express — chiefly chart animation props. Plain CSS
// animations should use a prefers-reduced-motion media query instead
// (see globals.css). The server snapshot is `false`; the client value is
// read on hydration, so there is no mismatch.
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
