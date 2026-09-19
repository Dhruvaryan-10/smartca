import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { auth } from "@/auth";
import Providers from "./providers";
import "./globals.css";

// Geist is the app's existing typeface; exposed as a CSS variable so the
// font stack in globals.css can fall back to the platform UI font (SF Pro
// on Apple devices) instead of being locked to a single className.
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

export const metadata: Metadata = {
  title: "SmartCA | AI Finance & Tax Management",
  description:
    "SmartCA helps you manage income, expenses, taxes and financial insights with AI-powered automation.",
};

// Applies a saved theme preference before first paint (no flash of the
// wrong theme); falls back to the OS preference via CSS when nothing is
// saved. Inline and tiny on purpose — no theme-management dependency.
const THEME_INIT_SCRIPT = `
try {
  var t = localStorage.getItem("smartca-theme");
  if (t === "light" || t === "dark") {
    document.documentElement.setAttribute("data-theme", t);
  }
} catch (e) {}
`;

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className={`${geist.variable} antialiased`}>
        <Providers session={session}>{children}</Providers>
      </body>
    </html>
  );
}
