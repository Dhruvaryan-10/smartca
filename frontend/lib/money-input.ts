// Exact rupee-string to paise parsing for tax inputs.
//
// Never goes through floating point: `Number("19.99") * 100` is
// 1998.9999999999998, and a wrong paisa in a tax input is a wrong tax
// figure. Digits are split on the decimal point and combined as integers.
//
// This is input parsing only. The server re-validates every amount it
// receives (services/tax.ts) and remains the authority on what is accepted.

/** Largest amount accepted for any single field: ₹10,00,00,00,000 (₹1,000 crore), in paise. */
export const MAX_MONEY_PAISE = 1_000_000_000_000;

export type MoneyParseFailure = {
  ok: false;
  reason: "empty" | "negative" | "malformed" | "too_many_decimals" | "too_large";
  /** Written for the person entering the amount. */
  message: string;
};

export type MoneyParseResult = { ok: true; paise: number } | MoneyParseFailure;

const MESSAGES: Record<MoneyParseFailure["reason"], string> = {
  empty: "Enter an amount.",
  negative: "Amounts can’t be negative.",
  malformed: "Enter an amount like 1,50,000 or 1,50,000.50.",
  too_many_decimals: "Use at most two decimal places.",
  too_large: "Amounts above ₹10,00,00,00,000 aren’t supported.",
};

function fail(reason: MoneyParseFailure["reason"]): MoneyParseFailure {
  return { ok: false, reason, message: MESSAGES[reason] };
}

const RUPEE_SYMBOL = "₹";
const MINUS_SIGNS = "-−"; // hyphen-minus and the real minus sign

// Digits, optionally followed by a decimal point and digits. Grouping commas
// are validated separately.
const NUMBER_SHAPE = /^(\d[\d,]*)(?:\.(\d*))?$/;
// 12,34,567 (Indian) and 1,234,567 (western). Both accept "1,000".
const INDIAN_GROUPING = /^\d{1,2}(,\d{2})*,\d{3}$/;
const WESTERN_GROUPING = /^\d{1,3}(,\d{3})+$/;

/**
 * Parse text such as "₹1,50,000", "150000", "1,50,000.50" into integer paise.
 * Whole rupees or up to two decimal places; anything else is rejected rather
 * than rounded.
 */
export function parseRupeesToPaise(input: string): MoneyParseResult {
  if (typeof input !== "string") return fail("malformed");

  let text = input.trim();

  // Accounting-style negatives: "(100)".
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = text.slice(1, -1).trim();
  }

  // One optional rupee symbol and one optional minus sign, in either order.
  let sawSymbol = false;
  let sawMinus = false;
  for (;;) {
    const ch = text[0];
    if (ch === undefined) break;
    if (ch === RUPEE_SYMBOL && !sawSymbol) {
      sawSymbol = true;
    } else if (MINUS_SIGNS.includes(ch) && !sawMinus) {
      sawMinus = true;
      negative = true;
    } else if (ch === " ") {
      // whitespace between the symbol/sign and the digits
    } else {
      break;
    }
    text = text.slice(1);
  }

  if (text === "") {
    // "" and a lone ₹ are simply empty; a lone "-" or "()" is malformed.
    return negative ? fail("malformed") : fail("empty");
  }

  const match = NUMBER_SHAPE.exec(text);
  if (!match) return fail("malformed");
  const [, integerPart, fractionPart] = match;

  if (integerPart.includes(",") && !INDIAN_GROUPING.test(integerPart) && !WESTERN_GROUPING.test(integerPart)) {
    return fail("malformed");
  }
  // "150000." has a decimal point but no digits after it.
  if (fractionPart === "") return fail("malformed");
  if (negative) return fail("negative");
  if (fractionPart !== undefined && fractionPart.length > 2) return fail("too_many_decimals");

  const wholeRupees = integerPart.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  // 13+ digits is far beyond the maximum; reject before converting so no
  // precision can be lost on the way.
  if (wholeRupees.length > 12) return fail("too_large");

  const fractionPaise = fractionPart === undefined ? 0 : Number(fractionPart.padEnd(2, "0"));
  const paise = Number(wholeRupees) * 100 + fractionPaise;
  if (paise > MAX_MONEY_PAISE) return fail("too_large");

  return { ok: true, paise };
}

/**
 * Integer paise back to editable text: "150000" or "150000.50". The inverse
 * of `parseRupeesToPaise` for any value it accepts.
 */
export function formatPaiseForInput(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0) {
    throw new RangeError(`Expected a non-negative integer number of paise; got ${paise}.`);
  }
  const rupees = Math.floor(paise / 100);
  const remainder = paise % 100;
  return remainder === 0 ? String(rupees) : `${rupees}.${String(remainder).padStart(2, "0")}`;
}
