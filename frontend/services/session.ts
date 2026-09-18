// The ONLY place API routes/server actions should derive "who is
// making this request" from. Always reads the server-verified Auth.js
// session — never a request body, query string, or header supplied by
// the client. Every service function below takes `userId` as an
// explicit parameter (which keeps them pure and easy to unit-test),
// but the only legitimate way to obtain that userId in real request
// handling is through this file.
import { auth } from "@/auth";
import { NotAuthenticatedError } from "./errors";

export async function getSessionUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

// Pure gate function, split out so the "no session -> reject" rule can
// be unit-tested directly without needing a real Next.js request/cookie
// context (which auth() itself requires and a bare test process can't
// provide). This is the actual code requireSessionUserId runs below —
// not a reimplementation of it.
export function requireUserId(userId: string | null): string {
  if (!userId) throw new NotAuthenticatedError();
  return userId;
}

export async function requireSessionUserId(): Promise<string> {
  return requireUserId(await getSessionUserId());
}
