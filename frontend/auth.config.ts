// Edge-safe Auth.js config: route-protection logic and session/token
// shaping only. Deliberately has NO providers here — the Credentials
// provider (frontend/auth.ts) pulls in bcryptjs and database access,
// neither of which are guaranteed to run on the Edge runtime that
// middleware executes in. middleware.ts imports ONLY this file, never
// frontend/auth.ts, so the Edge bundle never includes bcryptjs or the
// pg driver.
import type { NextAuthConfig } from "next-auth";

// Pages reachable without a session. Everything else under this app is
// a private financial area and requires authentication.
const PUBLIC_PATHS = new Set(["/", "/landing", "/login", "/signup"]);

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Auth.js's own handlers (sign-in/callback/etc.) and our signup route
  // must stay reachable while signed out — that's how sessions start.
  if (pathname.startsWith("/api/auth")) return true;
  return false;
}

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    authorized({ auth, request }) {
      const isLoggedIn = !!auth?.user;
      if (isPublicPath(request.nextUrl.pathname)) return true;
      return isLoggedIn;
    },
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.id === "string") {
        session.user.id = token.id;
      }
      return session;
    },
  },
  providers: [], // populated in auth.ts
} satisfies NextAuthConfig;
