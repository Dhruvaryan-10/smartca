// Display formatting for money and dates. UI-boundary only: the database
// and every service deal in integer paise (see db/schema.ts). Nothing
// here is used to compute a tax or a stored total — it only renders
// values that have already been computed.
//
// Indian digit grouping (₹1,50,000, not ₹150,000 or ₹150000) comes from
// the en-IN locale; the minus sign is a real minus (U+2212) so negative
// figures line up with positive ones in tabular columns.

const INR_GROUPED = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const INR_GROUPED_PAISE = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const INR_COMPACT = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const MINUS = "−";

type FormatRupeesOptions = {
  /** Prefix positive figures with "+" (used for signed activity rows). */
  showPositiveSign?: boolean;
};

/**
 * Format integer paise as rupees with Indian grouping. Whole-rupee
 * amounts render without decimals ("₹1,50,000"); amounts with a paise
 * component keep both decimals ("₹1,250.50") so nothing is silently
 * rounded away.
 */
export function formatRupees(paise: number, options: FormatRupeesOptions = {}): string {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const rupees = absolute / 100;
  const body = absolute % 100 === 0 ? INR_GROUPED.format(rupees) : INR_GROUPED_PAISE.format(rupees);
  if (negative) return `${MINUS}₹${body}`;
  return `${options.showPositiveSign && absolute > 0 ? "+" : ""}₹${body}`;
}

/** Short form for chart axes: 1.5L, 25Cr, 12K. Input is integer paise. */
export function formatRupeesCompact(paise: number): string {
  const rupees = paise / 100;
  if (rupees === 0) return "₹0";
  const sign = rupees < 0 ? MINUS : "";
  return `${sign}₹${INR_COMPACT.format(Math.abs(rupees))}`;
}

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIsoDate(iso: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(match[1]), month, day: Number(match[3]) };
}

/**
 * "2026-03-04" -> "4 Mar 2026". Parsed from the string, never through
 * `new Date()`: a bare YYYY-MM-DD is read as UTC by Date and can land on
 * the previous day in time zones behind UTC.
 */
export function formatDate(iso: string): string {
  const parts = parseIsoDate(iso);
  if (!parts) return iso;
  return `${parts.day} ${MONTH_SHORT[parts.month - 1]} ${parts.year}`;
}

/** "2026-03" -> "Mar", or "Mar ’26" when the label needs its year. */
export function formatMonthLabel(monthKey: string, withYear: boolean): string {
  const parts = parseIsoDate(`${monthKey}-01`);
  if (!parts) return monthKey;
  const name = MONTH_SHORT[parts.month - 1];
  return withYear ? `${name} ’${String(parts.year).slice(2)}` : name;
}
