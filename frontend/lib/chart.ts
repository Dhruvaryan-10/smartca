// Axis maths for the Summary chart. Pure display helper — it only decides
// where gridlines fall, never what a value is.

const STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10];

/**
 * Round gridline positions for a 0-based money axis. Input and output are
 * integer paise; steps are chosen in rupees so the labels read as round
 * numbers in Indian units (₹50K, ₹1L, ₹2.5L) instead of whatever a
 * charting library's auto-scale lands on (₹85K, ₹1.7L, ₹2.6L).
 */
export function niceAxis(maxPaise: number, targetIntervals = 4): { max: number; ticks: number[] } {
  const maxRupees = Math.max(0, maxPaise) / 100;
  if (maxRupees === 0) {
    return { max: 1_000 * 100, ticks: [0, 500 * 100, 1_000 * 100] };
  }

  const rawStep = maxRupees / targetIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const stepRupees = (STEP_MULTIPLIERS.find((m) => m * magnitude >= rawStep) ?? 10) * magnitude;

  const ticks: number[] = [];
  for (let value = 0; value < maxRupees + stepRupees; value += stepRupees) {
    ticks.push(Math.round(value * 100));
    if (value >= maxRupees) break;
  }
  return { max: ticks[ticks.length - 1], ticks };
}
