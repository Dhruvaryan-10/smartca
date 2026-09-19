// Statutory rounding — Sections 288A (total/taxable income) and 288B
// (tax payable). Both sections use the identical convention, verified in
// the Phase 1C-B source audit: ignore paise first, then round the whole-
// rupee amount to the nearest multiple of ₹10 — a last digit of 5 or
// more rounds UP, less than 5 rounds DOWN. Applied only at the two
// points the law specifies (taxable income once, final tax payable
// once) — never per slab, per deduction, per rebate, surcharge, or cess
// component individually.
//
// Assumes a non-negative input in whole or fractional rupees (as integer
// paise) — taxable income and tax payable are never negative in this
// engine (both are floored at zero upstream), so negative handling is
// deliberately not implemented here.
export function roundToNearestTenRupees(amountPaise: number): number {
  const wholeRupees = Math.floor(amountPaise / 100); // "ignore paise" per 288A/288B
  const lastDigit = wholeRupees % 10;
  const roundedRupees = lastDigit >= 5 ? wholeRupees + (10 - lastDigit) : wholeRupees - lastDigit;
  return roundedRupees * 100;
}
