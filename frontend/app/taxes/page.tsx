"use client";

import { useEffect, useMemo, useState } from "react";
import type { RegimeComparison as Comparison, RegimeOutcome, TaxResult } from "@/tax-engine";
import type { SavedTaxRun, TaxComputeResponse, TaxSaveResponse, TaxWorkspace } from "@/services/tax";
import { formatRupees } from "@/lib/format";
import AppShell from "../components/AppShell";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { PageHeader, Section } from "../components/ui/PageHeader";
import { EmptyState, ErrorState, LoadingState, Skeleton } from "../components/ui/States";
import ComputationSheet from "./ComputationSheet";
import RegimeComparison from "./RegimeComparison";
import TaxForm, { EMPTY_TAX_FORM, parseTaxForm, taxFormFromInput } from "./TaxForm";
import type { TaxFormValues, TaxRequestBody } from "./TaxForm";

// The Tax page holds no tax logic. The browser sends inputs to the server;
// the server runs the deterministic engine and returns the result; this page
// renders it. Nothing here calculates, rounds or compares a tax figure.

// ---------------------------------------------------------------------
// Talking to the API
// ---------------------------------------------------------------------

class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiFailure("Couldn’t reach SmartCA. Check your connection and try again.");
  }

  // An expired session is redirected to the login page, which is HTML, not JSON.
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) {
    throw new ApiFailure("Your session may have expired. Log in again to continue.", "session");
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const body = (data ?? {}) as { error?: unknown; code?: unknown };
    throw new ApiFailure(
      typeof body.error === "string" ? body.error : "Something went wrong. Please try again.",
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return data as T;
}

const messageOf = (err: unknown) => (err instanceof ApiFailure ? err.message : "Something went wrong. Please try again.");

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

  return (
    <AppShell>
      <PageHeader
        title="Tax"
        description={
          assessmentYear
            ? `Assessment year ${assessmentYear.label}, on income earned in FY ${assessmentYear.financialYearLabel}.`
            : "Compare the old and new tax regimes."
        }
        actions={assessmentYear && <Badge>{`AY ${assessmentYear.label} · FY ${assessmentYear.financialYearLabel}`}</Badge>}
      />
      <p className="-mt-4 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
        This works out your tax liability for the year, before any TDS or advance tax you have already paid. It assumes a resident
        individual and covers the cases listed under{" "}
        <a href="#assumptions" className="text-foreground underline underline-offset-2">
          assumptions
        </a>
        .
      </p>

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
        <div className="space-y-12">
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

          {viewingRun ? (
            <SavedRunView
              run={viewingRun}
              onBack={() => setViewingRunId(null)}
              onUseInputs={() => {
                setValues(taxFormFromInput(viewingRun.input));
                setPrefilled(false);
                setViewingRunId(null);
              }}
            />
          ) : (
            <LiveResults
              calc={calc}
              stale={stale}
              save={save}
              onSave={saveComputation}
              onRetry={calculate}
            />
          )}

          {workspace.savedRuns.length > 0 && (
            <Section title="Saved computations" aside="Shown exactly as saved">
              <ul>
                {workspace.savedRuns.map((run) => (
                  <li key={run.runId} className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 first:pt-0 last:border-0">
                    <div className="min-w-0">
                      <p className="text-sm text-foreground">{formatDateTime(run.savedAt)}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{describeRunTotals(run)}</p>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => setViewingRunId(run.runId)}>
                      View
                    </Button>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Assumptions />
        </div>
      )}
    </AppShell>
  );
}

// ---------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------

function LiveResults({
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
  if (calc.status === "idle") {
    return (
      <Section title="Results">
        <EmptyState
          compact
          title="Nothing calculated yet"
          description="Enter your income and choose Calculate to see the old and new regimes side by side, with every step shown."
        />
      </Section>
    );
  }
  if (calc.status === "loading") {
    return (
      <Section title="Results">
        <LoadingState label="Calculating…" />
      </Section>
    );
  }
  if (calc.status === "error") {
    return (
      <Section title="Results">
        <ErrorState title="Couldn’t calculate" message={calc.message} onRetry={onRetry} />
      </Section>
    );
  }

  const { comparison } = calc.response;
  return (
    <>
      <Section title="Old and new regime">
        {stale && (
          <p role="status" className="mb-4 rounded-[var(--radius-md)] border border-border px-4 py-3 text-[13px] text-foreground">
            You’ve changed your inputs since this was calculated. Choose Calculate to update it.
          </p>
        )}
        <div className={stale ? "opacity-60" : undefined}>
          <RegimeComparison comparison={comparison} />
        </div>
        <SaveControls save={save} stale={stale} onSave={onSave} />
      </Section>

      <Section title="Computation sheet">
        <div className={stale ? "opacity-60" : undefined}>
          <ComputationSheet key={calc.id} results={resultsOf(comparison)} />
        </div>
      </Section>
    </>
  );
}

function SaveControls({ save, stale, onSave }: { save: SaveState; stale: boolean; onSave: () => void }) {
  const saved = save.status === "saved";
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button variant="secondary" size="sm" onClick={onSave} disabled={stale || saved || save.status === "saving"}>
        {save.status === "saving" ? "Saving…" : saved ? "Saved" : "Save computation"}
      </Button>
      <p className="text-[13px] text-muted-foreground" role={save.status === "error" ? "alert" : "status"}>
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

function SavedRunView({ run, onBack, onUseInputs }: { run: SavedTaxRun; onBack: () => void; onUseInputs: () => void }) {
  const sample = run.results.new ?? run.results.old;
  return (
    <>
      <Section title="Saved computation">
        <div role="status" className="mb-6 rounded-[var(--radius-md)] border border-border p-4 text-[13px]">
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
        <RegimeComparison comparison={comparisonOfRun(run)} />
      </Section>
      <Section title="Computation sheet">
        <ComputationSheet key={run.runId} results={run.results} />
      </Section>
    </>
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
    <div role="status" aria-live="polite" className="space-y-10">
      <span className="sr-only">Loading your tax workspace…</span>
      {[0, 1, 2].map((i) => (
        <div key={i}>
          <Skeleton className="h-4 w-28" />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
      ))}
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
    <Section title="Assumptions and what isn’t covered">
      <div id="assumptions" className="space-y-5 text-sm">
        <div>
          <p className="font-medium text-foreground">What this assumes</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li>You are a resident individual. Section 87A rebate is available to residents only.</li>
            <li>Amounts you enter are the eligible amounts for the year. Deductions are checked against their legal limits only.</li>
            <li>Section 80D covers premiums for you, your family and your parents. The preventive health check-up limit sits inside those limits and isn’t tracked separately.</li>
            <li>Salary gets a standard deduction; other income does not.</li>
          </ul>
        </div>
        <div>
          <p className="font-medium text-foreground">Not covered</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            {NOT_COVERED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3 text-muted-foreground">
            If any of these apply to you, this result is not complete. It isn’t tax advice; check with a chartered accountant before
            you file.
          </p>
        </div>
      </div>
    </Section>
  );
}
