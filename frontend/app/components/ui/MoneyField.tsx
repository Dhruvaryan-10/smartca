import type { InputHTMLAttributes } from "react";
import { FieldMessage, Input, Label } from "./Input";

// A rupee amount: label above, ₹ inside the field, figures right-aligned
// in tabular numerals so stacked fields line up like a money column. It
// is a text field (inputMode decimal), not type=number: amounts such as
// 1,50,000.50 are typed as people write them and parsed exactly by
// lib/money-input. Hint and error are wired to the input for screen
// readers; an error replaces the hint.
export function MoneyField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  className = "",
  autoFocus = false,
  inputProps,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string;
  className?: string;
  /** Focus this field when its dialog opens (components/ui/Dialog.tsx). */
  autoFocus?: boolean;
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange">;
}) {
  const messageId = `${id}-message`;
  return (
    <div className={className}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-body text-foreground-muted">
          ₹
        </span>
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? messageId : undefined}
          className="pl-7 text-right font-numeric"
          data-autofocus={autoFocus ? "" : undefined}
          {...inputProps}
        />
      </div>
      {error ? (
        <FieldMessage id={messageId} tone="error" aria-live="polite">
          {error}
        </FieldMessage>
      ) : hint ? (
        <FieldMessage id={messageId}>{hint}</FieldMessage>
      ) : null}
    </div>
  );
}
