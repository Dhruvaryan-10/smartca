"use client";

import { useState } from "react";
import type { CSSProperties } from "react";
import { formatRupees } from "@/lib/format";
import type { ComputationNode, DeductionAdjustment, TaxResult } from "@/tax-engine";
import { Badge } from "../../components/ui/Badge";
import { IconChevronDown } from "../../components/ui/Icons";
import { SegmentedControl } from "../../components/ui/SegmentedControl";

// The computation sheet: the engine's two derivation trees, rendered as
// they were produced. Deductions and rebates are negative amounts, exactly as
// the engine stores them. Nothing here recomputes anything, which is also why
// a saved computation can be shown with this same component.
//
// Laid out the way a CA writes a computation of total income: the working
// first, then the figure it adds up to at the foot, below a single rule.
// The final tax carries the accounting double rule.
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
        <SegmentedControl
          label="Regime shown in the computation sheet"
          value={regime}
          onChange={setSelected}
          options={[
            { value: "old", label: "Old regime", disabled: !results.old },
            { value: "new", label: "New regime", disabled: !results.new },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="tax">Tax engine</Badge>
          <p className="font-mono text-micro text-foreground-muted">
            AY {result.assessmentYearLabel} · engine {result.engineVersion} · rules {result.rulesVersion}
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-x-12 gap-y-10 xl:grid-cols-2">
        <SheetBlock title="How your taxable income was worked out">
          <TreeNode node={result.taxableIncomeTree} depth={0} total="subtotal" />
          {result.deductionAdjustments.length > 0 && <LimitNotes adjustments={result.deductionAdjustments} />}
        </SheetBlock>

        <SheetBlock title="How the tax was worked out">
          <TreeNode node={result.tree} depth={0} total="settled" />
        </SheetBlock>
      </div>

      <p className="mt-6 max-w-3xl text-label text-foreground-muted">
        Taxable income and the final tax are rounded to the nearest ₹10 where the law requires it (Sections 288A and 288B). Those
        adjustments appear as their own rows when they change the figure.
      </p>
    </section>
  );
}

function SheetBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-panel border border-border bg-surface px-4 pb-2 pt-4 sm:px-5">
      <h3 className="mb-2 text-subheading font-semibold text-foreground">{title}</h3>
      <ul>{children}</ul>
    </div>
  );
}

function LimitNotes({ adjustments }: { adjustments: DeductionAdjustment[] }) {
  return (
    <li className="mb-3 mt-4 list-none rounded-md bg-tax-soft p-3.5">
      <p className="text-label font-medium text-foreground">Deduction limits applied</p>
      <ul className="mt-2 space-y-1.5 text-label text-foreground-secondary">
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

const depthStyle = (depth: number) => ({ "--depth": depth }) as CSSProperties;

// One row of a derivation tree. A tree's root is its total: its working
// (the children) is listed first and the total sits at the foot, below a
// rule. Inner rows with children can be collapsed.
function TreeNode({ node, depth, total }: { node: ComputationNode; depth: number; total?: "subtotal" | "settled" }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  if (total) {
    return (
      <>
        {node.children.map((child, i) => (
          <TreeNode key={`${child.label}-${i}`} node={child} depth={0} />
        ))}
        <li className="list-none">
          <div
            className={`rule-subtotal mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 py-3 ${
              total === "settled" ? "rule-settled mb-2" : ""
            }`}
          >
            <span className="min-w-0 text-body font-semibold text-foreground">
              {node.label}
              {node.sourceSection && <SectionRef value={node.sourceSection} />}
            </span>
            <span className={`font-numeric font-semibold text-foreground ${total === "settled" ? "text-heading" : "text-body"}`}>
              {formatRupees(node.amountPaise)}
            </span>
          </div>
        </li>
      </>
    );
  }

  return (
    <li className="list-none">
      <div
        className="tree-indent grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-b border-divider py-2.5"
        style={depthStyle(depth)}
      >
        <div className="flex min-w-0 items-baseline gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
              onClick={() => setOpen((v) => !v)}
              className="-ml-1 inline-flex h-6 w-6 shrink-0 translate-y-1 items-center justify-center rounded-xs text-foreground-muted transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken hover:text-foreground focus-visible:focus-ring"
            >
              <IconChevronDown
                width={14}
                height={14}
                className={`transition-transform duration-(--duration-normal) ease-standard ${open ? "" : "-rotate-90"}`}
              />
            </button>
          ) : (
            <span className="inline-block w-5 shrink-0" aria-hidden="true" />
          )}
          <span className={`min-w-0 text-body ${hasChildren ? "font-medium text-foreground" : "text-foreground-secondary"}`}>
            {node.label}
            {node.sourceSection && <SectionRef value={node.sourceSection} />}
          </span>
        </div>
        <span className={`font-numeric text-body ${hasChildren ? "font-medium text-foreground" : "text-foreground"}`}>
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

function SectionRef({ value }: { value: string }) {
  return <span className="ml-2 whitespace-nowrap font-mono text-micro font-normal text-foreground-muted">{value}</span>;
}
