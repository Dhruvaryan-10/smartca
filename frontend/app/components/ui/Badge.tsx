import type { HTMLAttributes } from "react";

type Tone = "neutral" | "success" | "destructive" | "warning";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground border-border",
  success: "bg-success/10 text-success border-success/30",
  destructive: "bg-destructive/10 text-destructive border-destructive/30",
  warning: "bg-warning/10 text-warning border-warning/30",
};

export function Badge({
  tone = "neutral",
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${TONE_CLASSES[tone]} ${className}`}
      {...props}
    />
  );
}
