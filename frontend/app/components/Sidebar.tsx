"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Sidebar() {

  const pathname = usePathname();

  const menu = [
    { name: "Dashboard", path: "/dashboard" },
    { name: "Income", path: "/income" },
    { name: "Expenses", path: "/expenses" },
    { name: "Taxes", path: "/taxes" },
    { name: "Reports", path: "/reports" },
    { name: "AI Insights", path: "/insights" }
  ];

  return (

    <aside className="w-64 bg-[#020617] border-r border-white/10 min-h-screen p-6">

      <h1 className="text-2xl font-bold text-teal-400 mb-10">
        SmartCA
      </h1>

      <nav className="space-y-4 text-gray-300">

        {menu.map((item) => {

          const active = pathname === item.path;

          return (

            <Link key={item.path} href={item.path}>

              <div
                className={`px-4 py-3 rounded-xl transition cursor-pointer
                ${
                  active
                    ? "bg-teal-500/20 text-teal-400"
                    : "hover:text-teal-400"
                }`}
              >
                {item.name}
              </div>

            </Link>

          );

        })}

      </nav>

    </aside>

  );
}