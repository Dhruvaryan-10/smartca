"use client";

import { useState } from "react";
import { formatRupees } from "@/lib/format";
import type { ComputationNode, DeductionAdjustment, TaxResult } from "@/tax-engine";
import { IconChevronDown } from "../components/ui/Icons";

// The computation sheet: the engine's two derivation trees, rendered as
// they were produced. Deductions and rebates are negative amounts, exactly as
// the engine stores them. Nothing here recomputes anything, which is also why
// a saved computation can be shown with this same component.
type Regime = "old" | "new";

const ADJUSTMENT_LABEL: Record<DeductionAdjustment["component"], string> = {
  "80C": "Section 80C",
  "80D-self-family": "Section 80D (self and family)",
  "80D-parents": "Section 80D (parents)",
};

export default function ComputationSheet({
  results,
  initialRegime = "new",
}: {
  results: { old: TaxResult | null; new: TaxResult | null };
  initialRegime?: Regime;
}) {
  const [selected, setSelected] = useState<Regime>(initialRegime);

  const available = (["old", "new"] as const).filter((regime) => results[regime]);
  if (available.length === 0) return null;

  // If the chosen regime has no result, show the one that does.
  const regime: Regime = results[selected] ? selected : available[0];
  const result = results[regime]!;

  return (
    <section aria-label="Computation sheet">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Regime shown in the computation sheet" className="inline-flex rounded-[var(--radius-sm)] bg-inset p-0.5">
          {(["old", "new"] as const).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={regime === r}
              disabled={!results[r]}
              onClick={() => setSelected(r)}
              className={`h-8 rounded-[calc(var(--radius-sm)-2px)] px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 ${
                regime === r ? "bg-elevated text-foreground shadow-[var(--shadow-md)]" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r === "old" ? "Old regime" : "New regime"}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-muted-foreground">
          Assessment year {result.assessmentYearLabel} · engine {result.engineVersion} · rules {result.rulesVersion}
        </p>
      </div>

      <div className="mt-6 space-y-10">
        <SheetBlock title="How your taxable income was worked out">
          <TreeNode node={result.taxableIncomeTree} depth={0} isRoot />
          {result.deductionAdjustments.length > 0 && <LimitNotes adjustments={result.deductionAdjustments} />}
        </SheetBlock>

        <SheetBlock title="How the tax was worked out">
          <TreeNode node={result.tree} depth={0} isRoot />
        </SheetBlock>
      </div>

      <p className="mt-6 text-[13px] leading-relaxed text-muted-foreground">
        Taxable income and the final tax are rounded to the nearest ₹10 where the law requires it (Sections 288A and 288B). Those
        adjustments appear as their own rows when they change the figure.
      </p>
    </section>
  );
}

function SheetBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-[15px] font-semibold tracking-tight text-foreground">{title}</h3>
      <ul>{children}</ul>
    </div>
  );
}

function LimitNotes({ adjustments }: { adjustments: DeductionAdjustment[] }) {
  return (
    <li className="mt-3 list-none rounded-[var(--radius-md)] border border-border p-4">
      <p className="text-[13px] font-medium text-foreground">Deduction limits applied</p>
      <ul className="mt-2 space-y-1.5 text-[13px] text-muted-foreground">
        {adjustments.map((a) => (
          <li key={a.component}>
            {a.declaredPaise > a.allowedPaise ? (
              <>
                <span className="text-foreground">{ADJUSTMENT_LABEL[a.component]}:</span> you entered{" "}
                <span className="font-numeric">{formatRupees(a.declaredPaise)}</span>. The limit is{" "}
                <span className="font-numeric">{formatRupees(a.capPaise)}</span>, so{" "}
                <span className="font-numeric">{formatRupees(a.allowedPaise)}</span> is allowed.
              </>
            ) : (
              <>
                <span className="text-foreground">{ADJUSTMENT_LABEL[a.component]}:</span>{" "}
                <span className="font-numeric">{formatRupees(a.declaredPaise)}</span> is within the{" "}
                <span className="font-numeric">{formatRupees(a.capPaise)}</span> limit.
              </>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

// One row of a derivation tree. Rows with children can be collapsed; the
// root row is the figure the tree adds up to and is set apart as the result.
function TreeNode({ node, depth, isRoot = false }: { node: ComputationNode; depth: number; isRoot?: boolean }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <li className="list-none">
      <div
        className={`grid grid-cols-[1fr_auto] items-baseline gap-x-4 border-b border-border py-2.5 ${
          isRoot ? "border-t-2 border-t-foreground/70 py-3" : ""
        }`}
        style={{ paddingLeft: depth * 20 }}
      >
        <div className="flex min-w-0 items-baseline gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
              onClick={() => setOpen((v) => !v)}
              className="-ml-1 inline-flex h-5 w-5 shrink-0 translate-y-1 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <IconChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
            </button>
          ) : (
            <span className="inline-block w-4 shrink-0" aria-hidden="true" />
          )}
          <span className={`min-w-0 text-sm ${isRoot ? "font-semibold text-foreground" : "text-foreground"}`}>{node.label}</span>
          {node.sourceSection && <span className="shrink-0 text-[12px] text-muted-foreground">{node.sourceSection}</span>}
        </div>
        <span
          className={`font-numeric ${isRoot ? "text-lg font-semibold text-foreground" : "text-sm text-foreground"}`}
        >
          {formatRupees(node.amountPaise)}
        </span>
      </div>
      {hasChildren && open && (
        <ul>
          {node.children.map((child, i) => (
            <TreeNode key={`${child.label}-${i}`} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}
