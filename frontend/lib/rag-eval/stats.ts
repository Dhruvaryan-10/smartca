// Small statistics for the RAG evaluation harness. PURE.
//
// Every percentage the harness reports is a count out of a count (`k` of `n`) with a Wilson score interval, because
// the sets are small (dozens of cases, sometimes single digits) and a bare percentage would look far more certain
// than it is. The interval assumes independent trials; requirements within one multi-chunk case are not fully
// independent, so treat the interval on pooled requirements as a guide, not a guarantee.

export type Rate = {
  k: number;
  n: number;
  /** k / n, or null when there was nothing to count. */
  rate: number | null;
  /** Lower and upper bounds of the 95% Wilson score interval, or null when n is 0. */
  low: number | null;
  high: number | null;
};

const Z_95 = 1.96;
/** Four decimals, and never -0, so a result serialises to the same text every time. */
const round4 = (x: number) => Math.round(x * 10000) / 10000 || 0;

export function wilson(k: number, n: number): Rate {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || k > n) throw new Error("k must be between 0 and n, both whole numbers.");
  if (n === 0) return { k, n, rate: null, low: null, high: null };

  const p = k / n;
  const z2 = Z_95 * Z_95;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { k, n, rate: round4(p), low: round4(Math.max(0, centre - half)), high: round4(Math.min(1, centre + half)) };
}

export const mean = (values: number[]): number | null => (values.length === 0 ? null : round4(values.reduce((sum, v) => sum + v, 0) / values.length));
