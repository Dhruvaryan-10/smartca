"use client";

import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import Link from "next/link";
import FinanceAIModel from "../components/FinanceAIModel";

export default function Landing() {

  const [showNav, setShowNav] = useState(false);

  useEffect(() => {
    const handleScroll = () => setShowNav(window.scrollY > 40);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <main className="relative overflow-x-hidden text-white bg-[#020617]">

      {/* ================= ANIMATED BACKGROUND ================= */}

      <div className="absolute inset-0 -z-10 overflow-hidden">

        <div className="blob blob1" />
        <div className="blob blob2" />
        <div className="blob blob3" />

      </div>

      {/* ================= NAVBAR ================= */}

      <motion.nav
        initial={{ y: -100 }}
        animate={{ y: showNav ? 0 : -100 }}
        transition={{ duration: 0.4 }}
        className="fixed w-full z-50 backdrop-blur-xl bg-black/40 border-b border-white/10 px-10 py-5 flex justify-between items-center"
      >

        <h1 className="text-xl font-bold text-teal-300 tracking-wide">
          SmartCA
        </h1>

        <div className="space-x-8 text-sm">

          <Link href="#features" className="hover:text-teal-300 transition">
            Features
          </Link>

          <Link href="#pricing" className="hover:text-teal-300 transition">
            Pricing
          </Link>

          <Link href="/login" className="hover:text-teal-300 transition">
            Login
          </Link>

          <Link
            href="/signup"
            className="bg-teal-400 text-black px-6 py-2 rounded-lg font-semibold hover:opacity-80 transition"
          >
            Get Started
          </Link>

        </div>

      </motion.nav>

      {/* ================= HERO ================= */}

      <section className="min-h-screen flex flex-col lg:flex-row items-center justify-between max-w-7xl mx-auto px-8 pt-32">

        {/* LEFT TEXT */}

        <motion.div
          initial={{ opacity: 0, x: -60 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="max-w-xl"
        >

          <h1 className="text-5xl lg:text-6xl font-extrabold leading-tight">

            AI Powered
            <span className="block text-teal-400 mt-2">
              Finance Intelligence
            </span>

          </h1>

          <p className="mt-6 text-slate-300 text-lg leading-relaxed">

            Track income, manage expenses, estimate taxes and receive
            intelligent financial insights — all in one powerful AI dashboard.

          </p>

          <div className="mt-10 flex gap-6">

            <Link
              href="/signup"
              className="px-8 py-4 rounded-xl bg-teal-400 text-black font-semibold hover:scale-105 transition shadow-lg"
            >
              Start Free Trial
            </Link>

            <Link
              href="#features"
              className="px-8 py-4 rounded-xl border border-teal-300 hover:bg-teal-300 hover:text-black transition"
            >
              Learn More
            </Link>

          </div>

        </motion.div>

        {/* RIGHT 3D MODEL */}

        <motion.div
          initial={{ opacity: 0, x: 60 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8 }}
          className="w-[420px] h-[420px] lg:w-[480px] lg:h-[480px] mt-16 lg:mt-0"
        >

          <FinanceAIModel />

        </motion.div>

      </section>

      {/* ================= FEATURES ================= */}

      <section
        id="features"
        className="max-w-7xl mx-auto px-8 py-32 grid md:grid-cols-3 gap-10"
      >

        {[
          {
            title: "Expense Tracking",
            desc: "AI automatically categorizes transactions and shows spending insights."
          },

          {
            title: "Tax Optimization",
            desc: "Smart tax estimation and deduction suggestions."
          },

          {
            title: "Financial Forecasting",
            desc: "Predict savings and investments using AI models."
          }

        ].map((feature, i) => (

          <motion.div
            key={i}
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.2 }}
            className="bg-black/40 border border-white/10 rounded-2xl p-8 hover:border-teal-400 transition backdrop-blur-lg"
          >

            <h3 className="text-xl font-semibold text-teal-300 mb-4">
              {feature.title}
            </h3>

            <p className="text-slate-400 leading-relaxed">
              {feature.desc}
            </p>

          </motion.div>

        ))}

      </section>

      {/* ================= PRICING ================= */}

      <section
        id="pricing"
        className="max-w-6xl mx-auto text-center py-32 px-8"
      >

        <h2 className="text-4xl font-bold mb-16">
          Simple Pricing
        </h2>

        <div className="grid md:grid-cols-3 gap-10">

          {[
            { name: "Free", price: "₹0" },
            { name: "Pro", price: "₹499/mo" },
            { name: "Enterprise", price: "Custom" },
          ].map((p, i) => (

            <div
              key={i}
              className="border border-white/10 rounded-2xl p-10 bg-black/40 hover:border-teal-400 transition backdrop-blur-lg"
            >

              <h3 className="text-xl mb-4">{p.name}</h3>

              <p className="text-4xl font-bold text-teal-300 mb-6">
                {p.price}
              </p>

              <button className="bg-teal-400 text-black px-6 py-3 rounded-lg font-semibold hover:scale-105 transition">
                Choose Plan
              </button>

            </div>

          ))}

        </div>

      </section>

      {/* ================= CTA ================= */}

      <section className="text-center pb-24">

        <h2 className="text-4xl font-bold">
          Ready to Take Control of Your Finances?
        </h2>

        <Link
          href="/signup"
          className="inline-block mt-8 bg-teal-400 text-black px-10 py-4 rounded-xl font-semibold hover:scale-105 transition shadow-lg"
        >
          Start Using SmartCA
        </Link>

      </section>

      {/* ================= FOOTER ================= */}

      <footer className="border-t border-white/10 py-8 text-center text-slate-400 text-sm">
        © {new Date().getFullYear()} SmartCA
      </footer>

    </main>
  );
}