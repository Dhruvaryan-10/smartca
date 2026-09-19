import { forwardRef } from "react";
import type { InputHTMLAttributes, SelectHTMLAttributes, LabelHTMLAttributes, HTMLAttributes } from "react";

type FieldSize = "md" | "lg";

// Controls live on the inset surface. The 1px boundary uses
// --field-border (>= 3:1 against the page in both themes) so a field is
// identifiable without relying on fill alone; focus swaps it for the
// accent plus a soft ring. `aria-invalid` drives the error treatment so
// styling can never drift from the semantics.
const FIELD_BASE =
  "w-full rounded-[var(--radius-sm)] bg-inset border border-field-border text-foreground " +
  "placeholder:text-muted-foreground transition-[border-color,box-shadow] duration-150 " +
  "hover:border-foreground/40 " +
  "focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 " +
  "aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/25 " +
  "disabled:opacity-60 disabled:cursor-not-allowed";

const FIELD_SIZE: Record<FieldSize, string> = {
  md: "h-9 px-3 text-sm",
  lg: "h-11 px-3.5 text-[15px]",
};

type FieldProps = { fieldSize?: FieldSize };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(
  ({ className = "", fieldSize = "md", ...props }, ref) => (
    <input ref={ref} className={`${FIELD_BASE} ${FIELD_SIZE[fieldSize]} ${className}`} {...props} />
  ),
);
Input.displayName = "Input";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & FieldProps>(
  ({ className = "", fieldSize = "md", ...props }, ref) => (
    <select ref={ref} className={`${FIELD_BASE} ${FIELD_SIZE[fieldSize]} ${className}`} {...props} />
  ),
);
Select.displayName = "Select";

export function Label({ className = "", ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={`block text-[13px] font-medium text-muted-foreground mb-1.5 ${className}`} {...props} />
  );
}

// Inline guidance or validation beneath a field. Pair with the field's
// aria-describedby so screen readers announce it with the input.
export function FieldMessage({
  tone = "hint",
  className = "",
  ...props
}: HTMLAttributes<HTMLParagraphElement> & { tone?: "hint" | "error" }) {
  return (
    <p
      className={`mt-1.5 text-[13px] ${tone === "error" ? "text-destructive" : "text-muted-foreground"} ${className}`}
      {...props}
    />
  );
}
