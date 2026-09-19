"use client";

import { forwardRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import { FieldMessage, Input, Label } from "./Input";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "id"> & {
  id: string;
  label: string;
  /** Validation message; when set the field is marked invalid. */
  error?: string | null;
  /** Persistent guidance shown while there is no error. */
  hint?: string;
};

// Label, control and message as one unit, wired for assistive tech:
// the message is tied to the input with aria-describedby, invalid state
// is exposed with aria-invalid, and password fields get a Show/Hide
// control so people can check what they typed instead of retyping.
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { id, label, error, hint, type = "text", ...inputProps },
  ref,
) {
  const [revealed, setRevealed] = useState(false);
  const isPassword = type === "password";
  const messageId = `${id}-message`;
  const hasMessage = Boolean(error || hint);

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          ref={ref}
          id={id}
          type={isPassword && revealed ? "text" : type}
          fieldSize="lg"
          aria-invalid={error ? true : undefined}
          aria-describedby={hasMessage ? messageId : undefined}
          style={isPassword ? { paddingRight: "4.25rem" } : undefined}
          {...inputProps}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            aria-pressed={revealed}
            aria-label={revealed ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-1.5 my-auto h-8 rounded-[var(--radius-sm)] px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {revealed ? "Hide" : "Show"}
          </button>
        )}
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
});
