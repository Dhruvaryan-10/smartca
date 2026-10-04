import { formatRupees } from "@/lib/format";
import { moneyTone, signedPaise, spokenAmount, type MoneyKind, type MoneyTone } from "@/lib/money-tone";

const TONE_CLASSES: Record<MoneyTone, string> = {
  income: "text-income",
  expense: "text-expense",
  tax: "text-tax",
  neutral: "text-foreground",
};

// A rupee figure in the financial colour language: tabular, formatted
// through lib/format, coloured by what it is (income green, expenses
// coral, tax gold, net by its sign), and read aloud with "minus" spelled
// out. `signed` shows the direction (+ inflow, − outflow) so the colour
// is never the only signal.
export function Money({
  paise,
  kind = "neutral",
  signed = false,
  className = "",
}: {
  paise: number;
  kind?: MoneyKind;
  signed?: boolean;
  className?: string;
}) {
  const value = signed ? signedPaise(kind, paise) : paise;
  const text = formatRupees(value, { showPositiveSign: signed });
  return (
    <span className={`font-numeric ${TONE_CLASSES[moneyTone(kind, value)]} ${className}`}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{spokenAmount(text)}</span>
    </span>
  );
}
