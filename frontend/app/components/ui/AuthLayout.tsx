import Link from "next/link";
import type { ReactNode } from "react";

// The frame for sign-in and sign-up: a quiet page, one narrow column, a
// large title. No card, no decoration — the form is the only thing here,
// so it gets the whole room. The wordmark is the only brand element.
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="px-6 py-6 sm:px-10">
        <Link
          href="/"
          className="rounded-[var(--radius-sm)] text-[15px] font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
        >
          SmartCA
        </Link>
      </header>

      <div className="flex flex-1 items-start justify-center px-6 pb-20 pt-6 sm:items-center sm:pt-0">
        <div className="page-enter w-full max-w-[22rem]">
          <h1 className="text-[32px] font-semibold leading-10 tracking-[-0.025em]">{title}</h1>
          {subtitle && <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          {footer && <div className="mt-8 text-sm text-muted-foreground">{footer}</div>}
        </div>
      </div>
    </main>
  );
}

export function AuthLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-sm font-medium text-foreground underline decoration-border decoration-2 underline-offset-4 transition-colors hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}
