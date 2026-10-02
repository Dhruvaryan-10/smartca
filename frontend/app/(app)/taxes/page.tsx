"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RegimeComparison as Comparison, RegimeOutcome, TaxResult } from "@/tax-engine";
import type { SavedTaxRun, TaxComputeResponse, TaxSaveResponse, TaxWorkspace } from "@/services/tax";
import { formatRupees } from "@/lib/format";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { PageHeader, Section } from "../../components/ui/PageHeader";
import { ErrorState, Skeleton } from "../../components/ui/States";
import { IconTax } from "../../components/ui/Icons";
import { messageOf, requestJson } from "../../components/request";
import { usePrefersReducedMotion } from "../../components/useReducedMotion";
import ComputationSheet from "./ComputationSheet";
import RegimeComparison from "./RegimeComparison";
import TaxForm, { EMPTY_TAX_FORM, parseTaxForm, taxFormFromInput } from "./TaxForm";
import type { TaxFormValues, TaxRequestBody } from "./TaxForm";

// The Tax page holds no tax logic. The browser sends inputs to the server;
// the server runs the deterministic engine and returns the result; this page
// renders it. Nothing here calculates, rounds or compares a tax figure.
//
// Layout: the inputs on the left, the result beside them (sticky from
// 1024px, so it stays in view while you edit), then the full computation
// sheet, saved computations, and what the calculation assumes.

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------

type WorkspaceState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; workspace: TaxWorkspace };
type CalcState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; id: number; response: TaxComputeResponse; request: TaxRequestBody };
type SaveState = { status: "idle" } | { status: "saving" } | { status: "saved"; savedAt: string } | { status: "error"; message: string };

const JSON_HEADERS = { "Content-Type": "application/json" };

export default function TaxesPage() {
  const [workspaceState, setWorkspaceState] = useState<WorkspaceState>({ status: "loading" });
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0);
  const [values, setValues] = useState<TaxFormValues>(EMPTY_TAX_FORM);
  const [prefilled, setPrefilled] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [calc, setCalc] = useState<CalcState>({ status: "idle" });
  const [save, setSave] = useState<SaveState>({ status: "idle" });
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<TaxWorkspace>("/api/tax/workspace", { signal: controller.signal })
      .then((workspace) => {
        setWorkspaceState({ status: "ready", workspace });
        // The user's own last saved inputs, never the ledger.
        const latest = workspace.savedRuns[0];
        if (latest) {
          setValues(taxFormFromInput(latest.input));
          setPrefilled(true);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setWorkspaceState({ status: "error", message: messageOf(err) });
      });
    return () => controller.abort();
  }, [workspaceAttempt]);

  const workspace = workspaceState.status === "ready" ? workspaceState.workspace : null;
  const parsed = useMemo(
    () => (workspace ? parseTaxForm(values, workspace.assessmentYear.label) : null),
    [values, workspace],
  );

  const stale =
    calc.status === "ready" && (!parsed || !parsed.ok || JSON.stringify(parsed.request) !== JSON.stringify(calc.request));

  const calculate = async () => {
    if (!workspace || !parsed) return;
    setSubmitted(true);
    if (!parsed.ok) return;

    setViewingRunId(null);
    setSave({ status: "idle" });
    setCalc({ status: "loading" });
    try {
      const response = await requestJson<TaxComputeResponse>("/api/tax/compute", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(parsed.request),
      });
      setCalc({ status: "ready", id: Date.now(), response, request: parsed.request });
    } catch (err) {
      setCalc({ status: "error", message: messageOf(err) });
    }
  };

  const saveComputation = async () => {
    // Always the request that produced the result on screen, never the (possibly edited) form.
    if (calc.status !== "ready" || stale || save.status === "saving") return;
    setSave({ status: "saving" });
    try {
      const saved = await requestJson<TaxSaveResponse>("/api/tax/compute", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ...calc.request, save: true }),
      });
      setSave({ status: "saved", savedAt: saved.saved.savedAt });
      const refreshed = await requestJson<TaxWorkspace>("/api/tax/workspace");
      setWorkspaceState({ status: "ready", workspace: refreshed });
    } catch (err) {
      setSave({ status: "error", message: messageOf(err) });
    }
  };

  const viewingRun = workspace?.savedRuns.find((run) => run.runId === viewingRunId) ?? null;
  const assessmentYear = workspace?.assessmentYear;

  const openAssumptions = () => {
    const details = document.getElementById("assumptions");
    if (details instanceof HTMLDetailsElement) details.open = true;
  };

  return (
    <>
      <div className="space-y-3">
        <PageHeader
          title="Tax"
          description={
            assessmentYear
              ? `Assessment year ${assessmentYear.label}, on income earned in FY ${assessmentYear.financialYearLabel}.`
              : "Compare the old and new tax regimes."
          }
          actions={assessmentYear && <Badge tone="tax">{`AY ${assessmentYear.label} · FY ${assessmentYear.financialYearLabel}`}</Badge>}
        />
        <p className="max-w-2xl text-label text-foreground-muted">
          This works out your tax liability for the year, before any TDS or advance tax you have already paid. It assumes a resident
          individual and covers the cases listed under{" "}
          <a href="#assumptions" onClick={openAssumptions} className="rounded-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:focus-ring">
            assumptions
          </a>
          .
        </p>
      </div>

      {workspaceState.status === "loading" && <WorkspaceSkeleton />}

      {workspaceState.status === "error" && (
        <ErrorState
          title="Couldn’t load your tax workspace"
          message={workspaceState.message}
          onRetry={() => {
            setWorkspaceState({ status: "loading" });
            setWorkspaceAttempt((n) => n + 1);
          }}
        />
      )}

      {workspace && parsed && (
        <div className="space-y-section">
          <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
            <div className="lg:col-span-7">
              <TaxForm
                values={values}
                errors={submitted && !parsed.ok ? parsed.errors : {}}
                onChange={setValues}
                onSubmit={calculate}
                calculating={calc.status === "loading"}
                assessmentYear={workspace.assessmentYear}
                ledgerSuggestion={workspace.ledgerSuggestion}
                form16Suggestions={workspace.form16Suggestions}
                prefilledFromSaved={prefilled}
              />
            </div>

            <aside aria-label="Result" className="lg:col-span-5">
              <div className="lg:sticky lg:top-20">
                {viewingRun ? (
                  <SavedRunSummary
                    run={viewingRun}
                    onBack={() => setViewingRunId(null)}
                    onUseInputs={() => {
                      setValues(taxFormFromInput(viewingRun.input));
                      setPrefilled(false);
                      setViewingRunId(null);
                    }}
                  />
                ) : (
                  <LiveResult calc={calc} stale={stale} save={save} onSave={saveComputation} onRetry={calculate} />
                )}
              </div>
            </aside>
          </div>

          {viewingRun ? (
            <Section title="Computation sheet" aside="As saved" className="reveal">
              <ComputationSheet key={viewingRun.runId} results={viewingRun.results} />
            </Section>
          ) : (
            calc.status === "ready" && (
              <Section title="Computation sheet" aside="Every step, as the engine worked it out" className="reveal">
                <div className={`transition-opacity duration-(--duration-normal) ease-standard ${stale ? "opacity-60" : ""}`}>
                  <ComputationSheet key={calc.id} results={resultsOf(calc.response.comparison)} />
                </div>
              </Section>
            )
          )}

          {workspace.savedRuns.length > 0 && (
            <Section title="Saved computations" aside="Shown exactly as saved" className="reveal">
              <ul className="divide-y divide-divider rounded-panel border border-border bg-surface">
                {workspace.savedRuns.map((run) => {
                  const viewing = run.runId === viewingRunId;
                  return (
                    <li key={run.runId} className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5 ${viewing ? "bg-accent" : ""}`}>
                      <div className="min-w-0">
                        <p className="text-body font-medium text-foreground">{formatDateTime(run.savedAt)}</p>
                        <p className="mt-0.5 font-numeric text-label text-foreground-muted">{describeRunTotals(run)}</p>
                      </div>
                      <Button
                        variant={viewing ? "outline" : "secondary"}
                        size="sm"
                        aria-pressed={viewing}
                        onClick={() => setViewingRunId(viewing ? null : run.runId)}
                      >
                        {viewing ? "Viewing" : "View"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          <Assumptions />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------

function LiveResult({
  calc,
  stale,
  save,
  onSave,
  onRetry,
}: {
  calc: CalcState;
  stale: boolean;
  save: SaveState;
  onSave: () => void;
  onRetry: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const reduceMotion = usePrefersReducedMotion();
  const readyId = calc.status === "ready" ? calc.id : null;

  // Below 1024px the result sits under the form: bring it into view (and
  // focus) when a new one arrives, so a calculation never happens off screen.
  useEffect(() => {
    if (readyId === null || !headingRef.current) return;
    if (!window.matchMedia("(max-width: 1023px)").matches) return;
    headingRef.current.focus({ preventScroll: true });
    headingRef.current.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    // Only when a new result arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyId]);

  return (
    <section aria-labelledby="tax-result" className="space-y-4">
      <h2 id="tax-result" ref={headingRef} tabIndex={-1} className="text-subheading font-semibold text-foreground outline-none">
        Result
      </h2>

      {calc.status === "idle" && (
        <div className="rounded-panel border border-dashed border-border bg-surface px-5 py-8">
          <span className="flex h-10 w-10 items-center justify-center rounded-pill bg-tax-soft text-tax">
            <IconTax />
          </span>
          <p className="mt-4 text-body font-medium text-foreground">Nothing calculated yet</p>
          <p className="mt-1 text-label text-foreground-muted">
            Enter your income and choose Calculate to see the old and new regimes side by side, with every step shown.
          </p>
        </div>
      )}

      {calc.status === "loading" && (
        <div role="status" aria-live="polite" className="space-y-3">
          <span className="sr-only">Calculating…</span>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-panel border border-border bg-surface p-4">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="mt-3 h-8 w-32" />
                <Skeleton className="mt-5 h-3.5 w-full" />
                <Skeleton className="mt-2 h-3.5 w-full" />
              </div>
            ))}
          </div>
          <Skeleton className="h-4 w-64 max-w-full" />
        </div>
      )}

      {calc.status === "error" && <ErrorState title="Couldn’t calculate" message={calc.message} onRetry={onRetry} />}

      {calc.status === "ready" && (
        <>
          {stale && (
            <p role="status" className="rounded-md bg-warning-soft px-3.5 py-2.5 text-label text-foreground">
              You’ve changed your inputs since this was calculated. Choose Calculate to update it.
            </p>
          )}
          <div className={`transition-opacity duration-(--duration-normal) ease-standard ${stale ? "opacity-60" : ""}`}>
            <RegimeComparison comparison={calc.response.comparison} washKey={calc.id} />
          </div>
          <SaveControls save={save} stale={stale} onSave={onSave} />
        </>
      )}
    </section>
  );
}

function SaveControls({ save, stale, onSave }: { save: SaveState; stale: boolean; onSave: () => void }) {
  const saved = save.status === "saved";
  return (
    <div className="flex flex-col gap-2 border-t border-divider pt-4">
      <div>
        <Button variant="secondary" size="sm" onClick={onSave} disabled={stale || saved || save.status === "saving"}>
          {save.status === "saving" ? "Saving…" : saved ? "Saved" : "Save computation"}
        </Button>
      </div>
      <p className={`text-label ${save.status === "error" ? "text-danger" : "text-foreground-muted"}`} role={save.status === "error" ? "alert" : "status"}>
        {save.status === "error"
          ? save.message
          : saved
            ? `Saved ${formatDateTime(save.savedAt)}. You can find it under Saved computations.`
            : stale
              ? "Calculate again to save these inputs."
              : "Nothing is saved until you choose this. It stores these inputs and the result shown."}
      </p>
    </div>
  );
}

function SavedRunSummary({ run, onBack, onUseInputs }: { run: SavedTaxRun; onBack: () => void; onUseInputs: () => void }) {
  const sample = run.results.new ?? run.results.old;
  return (
    <section aria-labelledby="saved-run" className="space-y-4">
      <h2 id="saved-run" className="text-subheading font-semibold text-foreground">
        Saved computation
      </h2>
      <div role="status" className="rounded-md bg-info-soft p-4 text-label">
        <p className="text-foreground">
          Saved on {formatDateTime(run.savedAt)}. This is the result exactly as it was calculated and stored
          {sample ? ` (engine ${sample.engineVersion}, rules ${sample.rulesVersion})` : ""}. It is not recalculated.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={onBack}>
            Back to current calculation
          </Button>
          <Button size="sm" variant="ghost" onClick={onUseInputs}>
            Use these inputs
          </Button>
        </div>
      </div>
      <RegimeComparison comparison={comparisonOfRun(run)} washKey={run.runId} />
    </section>
  );
}

const resultsOf = (comparison: Comparison): { old: TaxResult | null; new: TaxResult | null } => ({
  old: comparison.old.status === "ok" ? comparison.old.result : null,
  new: comparison.new.status === "ok" ? comparison.new.result : null,
});

/** A stored run has only the regimes that produced a result; say so for the missing one. */
function comparisonOfRun(run: SavedTaxRun): Comparison {
  const outcome = (result: TaxResult | null): RegimeOutcome =>
    result
      ? { status: "ok", result }
      : { status: "refused", refusal: { kind: "unsupported_rule", message: "No result was saved for this regime." } };
  return { old: outcome(run.results.old), new: outcome(run.results.new), numbers: run.numbers };
}

function describeRunTotals(run: SavedTaxRun): string {
  const total = (result: TaxResult | null) => (result ? formatRupees(result.totalTaxPaise) : "no result");
  return `Old regime ${total(run.results.old)} · New regime ${total(run.results.new)}`;
}

// ---------------------------------------------------------------------
// Static content
// ---------------------------------------------------------------------

function WorkspaceSkeleton() {
  return (
    <div role="status" aria-live="polite" className="grid gap-8 lg:grid-cols-12 lg:gap-10">
      <span className="sr-only">Loading your tax workspace…</span>
      <div className="space-y-5 lg:col-span-7">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-panel border border-border bg-surface p-5 sm:p-6">
            <Skeleton className="h-4 w-28" />
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
        ))}
      </div>
      <div className="lg:col-span-5">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="mt-4 h-40 w-full rounded-panel" />
      </div>
    </div>
  );
}

const NOT_COVERED = [
  "Capital gains and other special-rate income.",
  "House rent allowance (HRA), leave travel allowance, and interest on a home loan.",
  "Deductions other than Section 80C and Section 80D, including 80CCD(1B), 80CCD(2), 80G and 80TTA.",
  "Presumptive taxation for business (Sections 44AD and 44ADA), business losses, and carry-forward of losses.",
  "TDS, advance tax and self-assessment tax already paid, and any interest or fees for late payment.",
  "Agricultural income, foreign income, and alternative minimum tax.",
];

function Assumptions() {
  return (
    <details id="assumptions" className="group rounded-panel border border-border bg-surface">
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 rounded-panel px-5 text-subheading font-semibold text-foreground focus-visible:focus-ring sm:px-6 [&::-webkit-details-marker]:hidden">
        Assumptions and what isn’t covered
        <span aria-hidden="true" className="text-label font-normal text-foreground-muted group-open:hidden">
          Show
        </span>
        <span aria-hidden="true" className="hidden text-label font-normal text-foreground-muted group-open:inline">
          Hide
        </span>
      </summary>
      <div className="grid gap-6 border-t border-divider px-5 pb-6 pt-5 text-body sm:px-6 md:grid-cols-2">
        <div>
          <p className="font-medium text-foreground">What this assumes</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-foreground-secondary">
            <li>You are a resident individual. Section 87A rebate is available to residents only.</li>
            <li>Amounts you enter are the eligible amounts for the year. Deductions are checked against their legal limits only.</li>
            <li>Section 80D covers premiums for you, your family and your parents. The preventive health check-up limit sits inside those limits and isn’t tracked separately.</li>
            <li>Salary gets a standard deduction; other income does not.</li>
          </ul>
        </div>
        <div>
          <p className="font-medium text-foreground">Not covered</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-foreground-secondary">
            {NOT_COVERED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3 text-foreground-muted">
            If any of these apply to you, this result is not complete. It isn’t tax advice; check with a chartered accountant before
            you file.
          </p>
        </div>
      </div>
    </details>
  );
}
