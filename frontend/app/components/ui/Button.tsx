import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "destructive";
type Size = "sm" | "md" | "lg";

// Primary is the SmartCA accent and should appear once per view. Secondary
// sits on the inset surface so it reads as a control without needing a
// border.
const VARIANT_CLASSES: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:brightness-110 active:brightness-95",
  secondary: "bg-inset text-foreground hover:bg-border active:bg-border",
  ghost: "text-muted-foreground hover:bg-inset hover:text-foreground",
  destructive: "bg-destructive text-destructive-foreground hover:brightness-110 active:brightness-95",
};

// Compact by default (32/36px) for dense app surfaces; `lg` (44px) is for
// touch-first, single-purpose forms like sign-in.
const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

export function buttonClasses(variant: Variant = "primary", size: Size = "md", className = ""): string {
  return `inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-medium whitespace-nowrap
    transition-[background-color,color,filter] duration-150 ease-[var(--ease-standard)]
    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background
    disabled:opacity-50 disabled:cursor-not-allowed
    ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`;
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(({ variant = "primary", size = "md", className = "", ...props }, ref) => {
  return <button ref={ref} className={buttonClasses(variant, size, className)} {...props} />;
});
Button.displayName = "Button";
