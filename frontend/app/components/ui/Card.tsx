import type { HTMLAttributes } from "react";

// A card is a grouped region that earns its own surface — a form, a
// table, a self-contained module. It is NOT the default wrapper for every
// piece of content; page-level grouping should come from spacing and
// type. Flat by design: a hairline border, no shadow.
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bg-card text-card-foreground border border-border rounded-[var(--radius-lg)] ${className}`}
      {...props}
    />
  );
}

export function CardHeader({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 pt-5 pb-2 ${className}`} {...props} />;
}

export function CardTitle({ className = "", ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={`text-[15px] font-semibold tracking-tight ${className}`} {...props} />;
}

export function CardContent({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 pb-5 pt-2 ${className}`} {...props} />;
}
