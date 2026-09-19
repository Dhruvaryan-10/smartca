// Display-formatting tests. Pure — no database, session, or network.
// Expected strings are written out by hand (Indian grouping rules), not
// derived from the formatter under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDate, formatMonthLabel, formatRupees, formatRupeesCompact } from "../lib/format";

const rupees = (r: number) => r * 100;

test("formatRupees groups digits the Indian way", () => {
  assert.equal(formatRupees(rupees(0)), "₹0");
  assert.equal(formatRupees(rupees(999)), "₹999");
  assert.equal(formatRupees(rupees(1_000)), "₹1,000");
  assert.equal(formatRupees(rupees(1_50_000)), "₹1,50,000");
  assert.equal(formatRupees(rupees(12_34_567)), "₹12,34,567");
  assert.equal(formatRupees(rupees(1_00_00_000)), "₹1,00,00,000");
});

test("formatRupees keeps paise only when there are paise", () => {
  assert.equal(formatRupees(125_050), "₹1,250.50");
  assert.equal(formatRupees(5), "₹0.05");
  assert.equal(formatRupees(rupees(1_250)), "₹1,250");
});

test("formatRupees uses a real minus sign for negatives", () => {
  assert.equal(formatRupees(-rupees(12_000)), "−₹12,000");
  assert.equal(formatRupees(-rupees(12_34_567)), "−₹12,34,567");
});

test("formatRupees can prefix positive amounts, but never zero", () => {
  assert.equal(formatRupees(rupees(500), { showPositiveSign: true }), "+₹500");
  assert.equal(formatRupees(0, { showPositiveSign: true }), "₹0");
  assert.equal(formatRupees(-rupees(500), { showPositiveSign: true }), "−₹500");
});

test("formatRupeesCompact uses Indian units", () => {
  assert.equal(formatRupeesCompact(0), "₹0");
  assert.equal(formatRupeesCompact(rupees(1_200)), "₹1.2K");
  assert.equal(formatRupeesCompact(rupees(1_50_000)), "₹1.5L");
  assert.equal(formatRupeesCompact(rupees(2_50_00_000)), "₹2.5Cr");
  assert.equal(formatRupeesCompact(-rupees(1_50_000)), "−₹1.5L");
});

test("formatDate reads the calendar date literally", () => {
  assert.equal(formatDate("2026-03-04"), "4 Mar 2026");
  assert.equal(formatDate("2025-12-31"), "31 Dec 2025");
  // First of a month: the case a UTC-parsed Date gets wrong west of UTC.
  assert.equal(formatDate("2026-09-01"), "1 Sep 2026");
  assert.equal(formatDate("not a date"), "not a date");
});

test("formatMonthLabel adds the year only when asked", () => {
  assert.equal(formatMonthLabel("2026-03", false), "Mar");
  assert.equal(formatMonthLabel("2026-03", true), "Mar ’26");
});
