import type { ReactNode } from "react";

// One header shape for every page: a confident title, one quiet line of
// context, and actions on the right. Identical structure across pages is
// what makes the app feel consistent.
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-display text-title font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-1 text-body text-foreground-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// A titled region within a page. Grouping by heading and space, not by
// wrapping everything in a bordered box.
export function Section({
  title,
  aside,
  children,
  className = "",
}: {
  title: string;
  /** Quiet supporting text or a text link, aligned to the heading's right edge. */
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-stack flex items-baseline justify-between gap-4">
        <h2 className="text-subheading font-semibold text-foreground">{title}</h2>
        {aside && <div className="text-label text-foreground-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}
