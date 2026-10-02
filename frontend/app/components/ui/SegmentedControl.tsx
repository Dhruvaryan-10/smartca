// A small set of mutually exclusive views (the regime shown in a
// computation sheet, a report's metric). Each option is a toggle button
// with aria-pressed; the chosen one lifts onto the elevated surface.
// `stretch` makes it full width with equal segments on phones, the way a
// native segmented control sits under a page title.
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  stretch = false,
  className = "",
}: {
  /** Accessible name for the group. */
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  stretch?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`rounded-control bg-surface-sunken p-0.5 ${stretch ? "flex w-full sm:inline-flex sm:w-auto" : "inline-flex self-start"} ${className}`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={`h-9 rounded-[calc(var(--radius-control)-2px)] px-3.5 text-label font-medium transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-standard focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 ${
              stretch ? "flex-1 sm:flex-none" : ""
            } ${selected ? "bg-surface-elevated text-foreground shadow-raised" : "text-foreground-muted hover:text-foreground"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
