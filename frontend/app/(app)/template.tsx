import type { ReactNode } from "react";

// Templates remount on every navigation (layouts do not), so the page
// content settles in on each route change while the shell stays still.
// The animation is removed under prefers-reduced-motion (globals.css).
export default function AppTemplate({ children }: { children: ReactNode }) {
  return <div className="page-enter space-y-8">{children}</div>;
}
