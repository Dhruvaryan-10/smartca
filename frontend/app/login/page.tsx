"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FinanceAIModel from "../components/FinanceAIModel";

export default function Login() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !password) {
      setError("Enter your email and password.");
      return;
    }

    setError(null);
    setLoading(true);

    // redirect: false — we handle the redirect ourselves so we can show
    // a real error message instead of a lossy query-string redirect.
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    setLoading(false);

    if (!result || result.error) {
      // Deliberately generic: never reveal whether the email exists.
      setError("Invalid email or password.");
      return;
    }

    router.push("/dashboard");
  };

  return (
    <main className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#020617] text-white">

      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="blob blob1" />
        <div className="blob blob2" />
        <div className="blob blob3" />
      </div>

      <div className="max-w-6xl w-full grid lg:grid-cols-2 gap-16 items-center px-8">

        {/* LEFT MODEL */}

        <motion.div
          initial={{ opacity: 0, x: -40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="hidden lg:flex justify-center items-center"
        >
          <div className="w-[380px] h-[380px]">
            <FinanceAIModel />
          </div>
        </motion.div>

        {/* LOGIN CARD */}

        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="w-full max-w-md mx-auto"
        >

          <div className="p-10 rounded-3xl bg-white/5 backdrop-blur-xl border border-white/10 shadow-[0_20px_60px_rgba(0,0,0,0.6)]">

            <h1 className="text-center text-xl text-teal-300 font-semibold mb-2">
              SmartCA
            </h1>

            <h2 className="text-center text-3xl font-bold mb-8">
              Login
            </h2>

            <form onSubmit={handleSubmit} className="space-y-6">

              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                autoComplete="email"
                className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />

              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400"
              />

              {error && (
                <p className="text-sm text-rose-400" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-teal-400 text-black font-semibold"
              >
                {loading ? "Logging in..." : "Login"}
              </button>

            </form>

            <p className="mt-6 text-center text-slate-400 text-sm">
              Don&rsquo;t have an account?{" "}
              <Link href="/signup" className="text-teal-300 hover:underline">
                Sign up
              </Link>
            </p>
          </div>

        </motion.div>

      </div>

    </main>
  );
}
