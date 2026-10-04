import type { ReactNode } from "react";
import AppShell from "../components/AppShell";

// Every authenticated route lives in this group, so the shell mounts once
// and persists across navigation. The group adds no URL segment; access
// control is unchanged and stays in proxy.ts.
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
