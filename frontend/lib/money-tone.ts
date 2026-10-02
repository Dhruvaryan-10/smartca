// The financial colour language, as pure rules (rendered by app/components/ui/Money.tsx). Colour never travels alone: every toned
// figure also carries its sign or its label, and screen readers hear "minus" rather than a dash.

/** What a figure is. "net" takes its tone from its sign. */
export type MoneyKind = "income" | "expense" | "tax" | "net" | "neutral";
export type MoneyTone = "income" | "expense" | "tax" | "neutral";

export function moneyTone(kind: MoneyKind, paise: number): MoneyTone {
  if (kind === "net") return paise > 0 ? "income" : paise < 0 ? "expense" : "neutral";
  return kind;
}

/**
 * The paise to format for a signed figure. Expenses are stored as positive amounts and shown as outflows; everything else keeps its
 * own sign.
 */
export function signedPaise(kind: MoneyKind, paise: number): number {
  return kind === "expense" ? -Math.abs(paise) : paise;
}

/** A formatted amount as it should be read aloud: the true minus sign becomes the word, so it is never skipped. */
export function spokenAmount(formatted: string): string {
  return formatted.replace(/^−/, "minus ").replace(/^\+/, "plus ");
}
