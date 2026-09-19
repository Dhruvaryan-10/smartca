"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";

// Hydrates next-auth's client context from the server-verified session
// (fetched once in the root layout via auth()) so useSession() in
// client components like UserMenu never has to re-fetch it itself.
export default function Providers({
  session,
  children,
}: {
  session: Session | null;
  children: React.ReactNode;
}) {
  return <SessionProvider session={session}>{children}</SessionProvider>;
}
