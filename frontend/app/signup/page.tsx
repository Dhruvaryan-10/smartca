"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FinanceAIModel from "../components/FinanceAIModel";

export default function Signup() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name || !email || !password) {
      setError("Enter your name, email, and password.");
      return;
    }

    setError(null);
    setLoading(true);

    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Signup failed. Please try again.");
      setLoading(false);
      return;
    }

    // Signed up — now sign in with the same credentials.
    const result = await signIn("credentials", { email, password, redirect: false });

    setLoading(false);

    if (!result || result.error) {
      // Account was created but sign-in somehow failed — send them to
      // login rather than leaving them stuck on this form.
      router.push("/login");
      return;
    }

    router.push("/dashboard");
  };

  return (
    <main className="relative min-h-screen flex items-center justify-center overflow-hidden bg-[#020617] text-white">

      {/* BACKGROUND BLOBS */}

      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div className="blob blob1" />
        <div className="blob blob2" />
        <div className="blob blob3" />
      </div>

      {/* PAGE GRID */}

      <div className="max-w-6xl w-full grid lg:grid-cols-2 gap-16 items-center px-8">

        {/* LEFT AI MODEL */}

        <motion.div
          initial={{ opacity: 0, x: -40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="hidden lg:flex justify-center items-center"
        >

          <div className="relative w-[380px] h-[380px]">

            <div className="absolute inset-0 blur-3xl bg-teal-500 opacity-20 rounded-full" />

            <FinanceAIModel />

          </div>

        </motion.div>

        {/* SIGNUP CARD */}

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
              Create Account
            </h2>

            <form onSubmit={handleSubmit} className="space-y-6">

              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full Name"
                autoComplete="name"
                className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder-slate-400"
              />

              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                autoComplete="email"
                className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder-slate-400"
              />

              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password (min. 8 characters)"
                autoComplete="new-password"
                className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder-slate-400"
              />

              {error && (
                <p className="text-sm text-rose-400" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3 rounded-xl bg-teal-400 text-black font-semibold hover:scale-[1.03] transition"
              >
                {loading ? "Creating account..." : "Create Account"}
              </button>

            </form>

            <p className="mt-6 text-center text-slate-400 text-sm">
              Already have an account?{" "}
              <Link
                href="/login"
                className="text-teal-300 hover:underline"
              >
                Login
              </Link>
            </p>
          </div>

        </motion.div>

      </div>

    </main>
  );
}
