import type { HTMLAttributes } from "react";

// Status tones (success/destructive/warning/info) and the financial
// colour language (income/expense/tax/assistant). A badge is always a
// word: the tone confirms it, never replaces it.
type Tone = "neutral" | "success" | "destructive" | "warning" | "info" | "income" | "expense" | "tax" | "assistant";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  success: "bg-success-soft text-success",
  destructive: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
  income: "bg-income-soft text-income",
  expense: "bg-expense-soft text-expense",
  tax: "bg-tax-soft text-tax",
  assistant: "bg-assistant-soft text-assistant",
};

export function Badge({
  tone = "neutral",
  className = "",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-xs px-2 py-0.5 text-micro font-medium ${TONE_CLASSES[tone]} ${className}`}
      {...props}
    />
  );
}
