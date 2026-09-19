import type { ReactNode } from "react";
import { Button } from "./Button";

// An empty state answers three questions in as few words as possible:
// what is empty, why, and what can I do about it. No illustration, no
// invented data.
export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Smaller footprint for use inside a section, e.g. under a chart heading. */
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? "py-8" : "py-20"}`}>
      <p className="text-[15px] font-medium text-foreground">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 py-10 text-sm text-muted-foreground"
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" />
      {label}
    </div>
  );
}

// Loading placeholder block. Shapes are sized by the caller so the
// skeleton matches the layout it stands in for and nothing jumps when
// real content arrives.
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton ${className}`} />;
}

export function ErrorState({
  message,
  title = "Something went wrong",
  onRetry,
}: {
  message: string;
  title?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="rounded-[var(--radius-lg)] border border-border bg-card p-5">
      <p className="text-[15px] font-medium text-destructive">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
