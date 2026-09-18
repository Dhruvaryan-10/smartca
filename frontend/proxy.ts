// Server-side route protection. Runs on the Edge runtime, so this
// imports ONLY the edge-safe auth.config.ts (no Credentials provider,
// no bcryptjs, no database access) — never frontend/auth.ts directly.
//
// This is the enforcement point: an unauthenticated request to any
// private page is redirected to /login before the page ever renders,
// regardless of what any client-side code does or doesn't check.
import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

// Next.js 16 statically scans this file for a plain top-level export
// named exactly `proxy` (the current convention — `middleware.ts` is
// deprecated as of this Next.js version). A destructured
// `export const { auth: proxy } = ...` is NOT detected by that static
// check even though it works at runtime, so this must stay a simple
// identifier export.
const { auth } = NextAuth(authConfig);
export const proxy = auth;

export const config = {
  // Skip static assets and Next internals; every other route (including
  // API routes) goes through the `authorized` callback in auth.config.ts,
  // which explicitly allow-lists the public pages and /api/auth/*.
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
