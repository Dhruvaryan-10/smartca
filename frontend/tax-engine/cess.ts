// Health & Education Cess — a flat percentage applied to tax after
// rebate and surcharge. Parameterized by rate (basis points) rather than
// hardcoding 4% here, so a future AY's rules module can supply a
// different rate without touching this function.
//
// Statutory rounding (Sections 288A/288B) is applied elsewhere in the
// engine — taxable income once (compute.ts) and final tax payable once
// (engine.ts), via rounding.ts — never here, since cess is an
// intermediate component and the law rounds only at those two points.
import type { ComputationNode } from "./types";

export function computeCess(taxAfterRebateAndSurchargePaise: number, cessRateBasisPoints: number): ComputationNode {
  const cessPaise = Math.floor((taxAfterRebateAndSurchargePaise * cessRateBasisPoints) / 10000);
  return {
    label: `Health & Education Cess (${cessRateBasisPoints / 100}%)`,
    amountPaise: cessPaise,
    kind: "cess",
    sourceSection: null,
    children: [],
  };
}
