// SmartCA's mark: a right-aligned figure over an accounting double rule,
// the "settled figure" of a computation sheet reduced to three strokes.
// Shown once, in the navigation; it never repeats through the app.
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <svg
        viewBox="0 0 20 20"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        aria-hidden="true"
        className="text-primary"
      >
        <path d="M9 6h7M4 11.5h12M4 14.5h12" />
      </svg>
      <span className="font-display text-subheading font-semibold tracking-tight text-foreground">SmartCA</span>
    </span>
  );
}
