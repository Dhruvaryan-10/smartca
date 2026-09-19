// Axis-helper tests. Pure. Expected ticks are worked out by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { niceAxis } from "../lib/chart";

const rupees = (r: number) => r * 100;

test("niceAxis picks round steps and always covers the maximum", () => {
  // The fixture that produced ₹85K / ₹1.7L / ₹2.6L under auto-scaling.
  const { max, ticks } = niceAxis(rupees(2_55_000));
  assert.deepEqual(ticks, [0, 100_000, 200_000, 300_000].map(rupees));
  assert.equal(max, rupees(3_00_000));
});

test("niceAxis uses 2.5 steps where they read better", () => {
  const { ticks } = niceAxis(rupees(10_00_000));
  assert.deepEqual(ticks, [0, 2_50_000, 5_00_000, 7_50_000, 10_00_000].map(rupees));
});

test("niceAxis handles small and exact values", () => {
  assert.deepEqual(niceAxis(rupees(800)).ticks, [0, 200, 400, 600, 800].map(rupees));
  assert.deepEqual(niceAxis(rupees(1_00_000)).ticks, [0, 25_000, 50_000, 75_000, 1_00_000].map(rupees));
});

test("niceAxis has a sensible axis when there is no data above zero", () => {
  const { max, ticks } = niceAxis(0);
  assert.equal(max, rupees(1_000));
  assert.deepEqual(ticks, [0, 500, 1_000].map(rupees));
});

test("niceAxis never returns a max below the data", () => {
  for (const r of [1, 7, 999, 12_345, 4_56_789, 3_21_00_000]) {
    const { max, ticks } = niceAxis(rupees(r));
    assert.ok(max >= rupees(r), `max ${max} should cover ${r}`);
    assert.equal(ticks[0], 0);
    assert.ok(ticks.length >= 3 && ticks.length <= 7, `tick count ${ticks.length} for ${r}`);
  }
});
