import { forwardRef } from "react";
import type { InputHTMLAttributes, SelectHTMLAttributes, LabelHTMLAttributes, HTMLAttributes } from "react";

type FieldSize = "md" | "lg";

// Controls live on the sunken surface. The 1px boundary uses
// --field-border (>= 3:1 against the page in both themes) so a field is
// identifiable without relying on fill alone; focus swaps it for the
// accent plus a soft ring. `aria-invalid` drives the error treatment so
// styling can never drift from the semantics. Text is 16px on phones so
// iOS never zooms into a focused field.
const FIELD_BASE =
  "w-full rounded-control bg-surface-sunken border border-field-border text-foreground " +
  "placeholder:text-foreground-muted transition-[border-color,box-shadow,background-color] duration-(--duration-fast) ease-standard " +
  "hover:border-foreground-muted " +
  "focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus-visible:ring-danger/25 " +
  "disabled:opacity-60 disabled:cursor-not-allowed";

const FIELD_SIZE: Record<FieldSize, string> = {
  md: "h-11 px-3 text-base sm:h-9 sm:text-body",
  lg: "h-11 px-3.5 text-base sm:text-body-lg",
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
  return <label className={`mb-1.5 block text-label font-medium text-foreground ${className}`} {...props} />;
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
      className={`mt-1.5 text-label ${tone === "error" ? "text-danger" : "text-foreground-muted"} ${className}`}
      {...props}
    />
  );
}
