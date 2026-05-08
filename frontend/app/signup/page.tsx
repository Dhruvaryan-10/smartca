"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { useRouter } from "next/navigation";
import FinanceAIModel from "../components/FinanceAIModel";

export default function Signup() {

  const router = useRouter();

  const [step, setStep] = useState<"signup" | "otp">("signup");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);

  // SEND OTP
  const sendOtp = async () => {

    if (!phone || !name) return alert("Enter all fields");

    try {

      setLoading(true);

      const res = await fetch("http://localhost:5000/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });

      const data = await res.json();

      if (res.ok) {
        setStep("otp");
      } else {
        alert(data.error || "Failed to send OTP");
      }

    } catch {
      alert("Server error");
    } finally {
      setLoading(false);
    }
  };

  // VERIFY OTP
  const verifyOtp = async () => {

    if (!otp) return alert("Enter OTP");

    try {

      setLoading(true);

      const res = await fetch("http://localhost:5000/verify-signup-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, otp, name }),
      });

      const data = await res.json();

      if (res.ok) {
        localStorage.setItem("token", data.token);
        router.push("/dashboard");
      } else {
        alert(data.error || "Invalid OTP");
      }

    } catch {
      alert("Server error");
    } finally {
      setLoading(false);
    }
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

            {step === "signup" && (
              <>
                <h2 className="text-center text-3xl font-bold mb-8">
                  Create Account
                </h2>

                <div className="space-y-6">

                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full Name"
                    className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder-slate-400"
                  />

                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Phone Number"
                    className="w-full px-4 py-3 rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder-slate-400"
                  />

                  <button
                    onClick={sendOtp}
                    disabled={loading}
                    className="w-full py-3 rounded-xl bg-teal-400 text-black font-semibold hover:scale-[1.03] transition"
                  >
                    {loading ? "Sending..." : "Send OTP"}
                  </button>

                </div>

                <p className="mt-6 text-center text-slate-400 text-sm">
                  Already have an account?{" "}
                  <Link
                    href="/login"
                    className="text-teal-300 hover:underline"
                  >
                    Login
                  </Link>
                </p>
              </>
            )}

            {step === "otp" && (
              <>
                <h2 className="text-center text-3xl font-bold mb-8">
                  Enter OTP
                </h2>

                <div className="space-y-6">

                  <input
                    type="text"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    maxLength={6}
                    placeholder="6 digit OTP"
                    className="w-full px-4 py-3 text-center text-lg tracking-widest rounded-xl bg-black/40 border border-white/10 focus:outline-none focus:ring-2 focus:ring-teal-400 placeholder-slate-400"
                  />

                  <button
                    onClick={verifyOtp}
                    disabled={loading}
                    className="w-full py-3 rounded-xl bg-teal-400 text-black font-semibold hover:scale-[1.03] transition"
                  >
                    {loading ? "Verifying..." : "Verify & Signup"}
                  </button>

                </div>

                <button
                  onClick={() => setStep("signup")}
                  className="mt-4 text-sm text-slate-400 hover:text-teal-300 transition"
                >
                  ← Change Details
                </button>
              </>
            )}

          </div>

        </motion.div>

      </div>

    </main>
  );
}