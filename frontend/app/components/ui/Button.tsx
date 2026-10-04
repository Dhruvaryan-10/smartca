import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "outline" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

// Primary is the SmartCA accent and should appear once per view. Secondary
// sits on the sunken surface so it reads as a control without a border;
// outline is the quiet alternative beside a primary. Hover steps the fill
// (never a brightness filter, which washes out in dark mode) and a press
// settles the button slightly, within the instant duration.
const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "bg-secondary text-foreground hover:bg-border",
  outline: "border border-field-border text-foreground hover:bg-surface-sunken",
  ghost: "text-foreground-muted hover:bg-surface-sunken hover:text-foreground",
  destructive: "bg-danger text-danger-foreground hover:bg-danger-hover",
};

// Compact by default (32/36px) for dense app surfaces; `lg` (44px) is for
// touch-first, single-purpose forms like sign-in.
const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-8 px-3 text-label",
  md: "h-9 px-4 text-body",
  lg: "h-11 px-5 text-body-lg",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md", className = ""): string {
  return `inline-flex items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap select-none
    transition-[background-color,color,border-color,transform] duration-(--duration-fast) ease-standard
    active:scale-98 active:duration-(--duration-instant)
    focus-visible:focus-ring
    disabled:pointer-events-none disabled:opacity-50
    ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(({ variant = "primary", size = "md", className = "", ...props }, ref) => {
  return <button ref={ref} className={buttonClasses(variant, size, className)} {...props} />;
});
Button.displayName = "Button";
