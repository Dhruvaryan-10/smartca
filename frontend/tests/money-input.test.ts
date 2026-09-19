// Exact rupee-string to paise parser tests. Pure — no database, session, or network.
//
// The parser must never go through floating point: several ordinary
// amounts below (0.29, 1.15, 4.35, 19.99) are not exactly representable, and
// `Number(x) * 100` gets them wrong. Expected paise values are written out
// by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_MONEY_PAISE, formatPaiseForInput, parseRupeesToPaise } from "../lib/money-input";

function ok(input: string): number {
  const result = parseRupeesToPaise(input);
  assert.equal(result.ok, true, `expected ${JSON.stringify(input)} to parse, got ${JSON.stringify(result)}`);
  return result.ok ? result.paise : -1;
}

function failure(input: string) {
  const result = parseRupeesToPaise(input);
  assert.equal(result.ok, false, `expected ${JSON.stringify(input)} to be rejected, got ${JSON.stringify(result)}`);
  return result.ok ? null : result;
}

test("parses plain digits, with and without the rupee symbol", () => {
  assert.equal(ok("150000"), 1_50_000 * 100);
  assert.equal(ok("₹150000"), 1_50_000 * 100);
  assert.equal(ok("₹ 1,50,000"), 1_50_000 * 100);
  assert.equal(ok("  ₹1,50,000  "), 1_50_000 * 100);
  assert.equal(ok("0"), 0);
  assert.equal(ok("007"), 700);
});

test("accepts Indian grouping", () => {
  assert.equal(ok("₹1,50,000"), 15_000_000);
  assert.equal(ok("1,000"), 100_000);
  assert.equal(ok("12,34,567"), 12_34_567 * 100);
  assert.equal(ok("1,00,00,000"), 1_00_00_000 * 100);
});

test("also accepts western grouping, since people paste both", () => {
  assert.equal(ok("150,000"), 15_000_000);
  assert.equal(ok("1,234,567"), 1_234_567 * 100);
});

test("rejects misplaced commas", () => {
  for (const bad of ["1,5,0,000", "1,50,00", ",100", "100,", "1,,000", "12,345,67", "100,00,000", "1,50,0000"]) {
    assert.equal(failure(bad)?.reason, "malformed", bad);
  }
});

test("parses decimals exactly, including values floating point gets wrong", () => {
  assert.equal(ok("150000.50"), 15_000_050);
  assert.equal(ok("1,50,000.50"), 15_000_050);
  assert.equal(ok("0.5"), 50);
  assert.equal(ok("0.05"), 5);
  assert.equal(ok("100.5"), 10_050);
  assert.equal(ok("1.50"), 150);
  // Each of these is off by one paise under Number(x) * 100.
  assert.equal(ok("0.29"), 29);
  assert.equal(ok("1.15"), 115);
  assert.equal(ok("4.35"), 435);
  assert.equal(ok("19.99"), 1999);
  assert.equal(ok("8.2"), 820);
});

test("rejects more than two decimal places rather than rounding silently", () => {
  for (const bad of ["1.234", "0.001", "100.000", "1,50,000.505"]) {
    assert.equal(failure(bad)?.reason, "too_many_decimals", bad);
  }
});

test("reports empty input distinctly so callers can treat it as zero or missing", () => {
  for (const blank of ["", "   ", "₹", " ₹ "]) {
    assert.equal(failure(blank)?.reason, "empty", JSON.stringify(blank));
  }
});

test("rejects negative amounts in every common spelling", () => {
  for (const negative of ["-100", "−100", "₹-100", "-₹100", "(100)", "-1,50,000", "- 100"]) {
    assert.equal(failure(negative)?.reason, "negative", negative);
  }
});

test("rejects malformed input", () => {
  const malformed = [
    "abc", "12abc", "1e5", "1.2.3", "₹₹100", "+100", "1 000", "150000.", ".5", "NaN", "Infinity",
    "१००", "1_000", "100%", "$100", "-", "--100", "1,50,000/-",
  ];
  for (const bad of malformed) {
    assert.equal(failure(bad)?.reason, "malformed", bad);
  }
});

test("accepts the maximum and rejects anything above it, without losing precision", () => {
  assert.equal(MAX_MONEY_PAISE, 10_00_00_00_000 * 100); // ₹1,000 crore
  assert.equal(ok("10,00,00,00,000"), MAX_MONEY_PAISE);
  assert.equal(failure("10,00,00,00,000.01")?.reason, "too_large");
  assert.equal(failure("10,00,00,00,001")?.reason, "too_large");
  assert.equal(failure("99999999999999999999999")?.reason, "too_large");
  assert.equal(failure("9".repeat(400))?.reason, "too_large");
});

test("every accepted value is a safe integer number of paise", () => {
  for (const input of ["0", "0.01", "1", "19.99", "10,00,00,00,000", "9,99,99,99,999.99"]) {
    const paise = ok(input);
    assert.equal(Number.isSafeInteger(paise), true, input);
    assert.ok(paise >= 0 && paise <= MAX_MONEY_PAISE, input);
  }
});

test("non-string input is rejected rather than coerced", () => {
  for (const bad of [null, undefined, 150000, {}, []]) {
    assert.equal(parseRupeesToPaise(bad as unknown as string).ok, false);
  }
});

test("failures carry a message written for the person entering the amount", () => {
  assert.match(failure("")!.message, /enter an amount/i);
  assert.match(failure("-5")!.message, /negative/i);
  assert.match(failure("abc")!.message, /1,50,000/);
  assert.match(failure("1.234")!.message, /two decimal/i);
  assert.match(failure("99999999999999")!.message, /10,00,00,00,000/);
});

test("formatPaiseForInput round-trips through the parser", () => {
  assert.equal(formatPaiseForInput(0), "0");
  assert.equal(formatPaiseForInput(15_000_000), "150000");
  assert.equal(formatPaiseForInput(15_000_050), "150000.50");
  assert.equal(formatPaiseForInput(5), "0.05");
  assert.equal(formatPaiseForInput(10_050), "100.50");
  for (const paise of [0, 5, 29, 1999, 15_000_050, MAX_MONEY_PAISE]) {
    assert.equal(ok(formatPaiseForInput(paise)), paise);
  }
});

test("formatPaiseForInput refuses values that are not valid amounts", () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => formatPaiseForInput(bad), RangeError);
  }
});
