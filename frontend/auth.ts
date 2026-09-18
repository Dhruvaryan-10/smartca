// Full Auth.js config — Node runtime only (Credentials provider pulls
// in bcryptjs + the database). Never imported from middleware.ts; see
// auth.config.ts for the edge-safe subset middleware actually uses.
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "./auth.config";
import { findUserByEmail, verifyPassword } from "./services/users";

if (!process.env.AUTH_SECRET) {
  throw new Error(
    "AUTH_SECRET is not set. Copy frontend/.env.example to frontend/.env.local " +
    "and set AUTH_SECRET to a random value (e.g. `npx auth secret` or " +
    "`openssl rand -base64 33`). There is no insecure fallback — sessions " +
    "cannot be signed without it."
  );
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = typeof credentials?.email === "string" ? credentials.email : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password) return null;

        const user = await findUserByEmail(email);
        // Same outcome (null -> generic "invalid credentials") whether
        // the email doesn't exist or the password is wrong — never
        // reveal which one it was.
        if (!user) return null;

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name ?? null };
      },
    }),
  ],
});
