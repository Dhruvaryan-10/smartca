"use client";

import { useRouter } from "next/navigation";

export default function Navbar() {

  const router = useRouter();

  const logout = () => {
    localStorage.removeItem("token");
    router.push("/login");
  };

  return (
    <div className="flex items-center justify-between bg-black/40 backdrop-blur-xl border-b border-white/10 px-8 py-4">

      {/* LEFT */}
      <div className="flex items-center gap-6">

        <h1 className="text-xl font-bold text-teal-400">
          SmartCA
        </h1>

        <input
          type="text"
          placeholder="Search..."
          className="bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-400"
        />

      </div>

      {/* RIGHT */}

      <div className="flex items-center gap-6">

        {/* Notification */}

        <div className="cursor-pointer text-slate-300 hover:text-teal-400">
          🔔
        </div>

        {/* Profile */}

        <div className="flex items-center gap-2 text-slate-300">

          <div className="w-8 h-8 rounded-full bg-teal-400 flex items-center justify-center text-black font-bold">
            U
          </div>

          <span className="text-sm">
            User
          </span>

        </div>

        {/* Logout */}

        <button
          onClick={logout}
          className="bg-teal-400 text-black px-4 py-2 rounded-lg font-semibold hover:scale-105 transition"
        >
          Logout
        </button>

      </div>

    </div>
  );
}