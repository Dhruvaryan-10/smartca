import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SmartCA | AI Finance & Tax Management",
  description:
    "SmartCA helps you manage income, expenses, taxes and financial insights with AI-powered automation.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        className={`${geist.className} bg-slate-950 text-white antialiased`}
      >
        {children}
      </body>
    </html>
  );
}