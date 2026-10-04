"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Form16Detail } from "@/services/form16";
import { deriveSalaryIncome, salaryConsistency } from "@/lib/form16-extract";
import type { Form16Confirmed, Form16Field, Form16FieldKey } from "@/lib/form16-extract";
import { formatRupees } from "@/lib/format";
import { formatPaiseForInput, parseRupeesToPaise } from "@/lib/money-input";
import { Badge } from "../../components/ui/Badge";
import { Button, buttonClasses } from "../../components/ui/Button";
import { FieldMessage, Input, Label, Select } from "../../components/ui/Input";
import { ErrorState, LoadingState } from "../../components/ui/States";
import { ApiFailure, formatUploaded, messageOf, requestJson } from "./api";

// Review and confirm the values read from a Form 16.
//
// What the parser read is shown as a CANDIDATE, each with the line it came
// from. Nothing here is used for anything until the person confirms. Where
// the parser found several different values it picks none of them. The
// salary figure SmartCA will use is derived, visibly, from the confirmed
// gross salary minus the Section 10 exemptions.
//
// Shown inside the Vault's review sheet (components/ui/Dialog), which gives
// it its title, focus handling and close button; the confirm action stays
// pinned to the bottom of the sheet while the values scroll.

type Values = { assessmentYear: string; employerName: string; gross: string; exemptions: string; section80C: string };

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; detail: Form16Detail };
type Confirm = { status: "idle" } | { status: "saving" } | { status: "error"; message: string } | { status: "done"; confirmed: Form16Confirmed };

const EMPTY: Values = { assessmentYear: "", employerName: "", gross: "", exemptions: "", section80C: "" };

function fieldOf(detail: Form16Detail, key: Form16FieldKey): Form16Field | undefined {
  return detail.extraction.extracted.fields.find((f) => f.key === key);
}

function initialValues(detail: Form16Detail): Values {
  const confirmed = detail.extraction.confirmed;
  if (confirmed) {
    return {
      assessmentYear: confirmed.assessmentYear,
      employerName: confirmed.employerName ?? "",
      gross: formatPaiseForInput(confirmed.grossSalaryPaise),
      exemptions: formatPaiseForInput(confirmed.section10ExemptionsPaise),
      section80C: confirmed.section80CPaise === null ? "" : formatPaiseForInput(confirmed.section80CPaise),
    };
  }
  // Only a single, unambiguous reading is pre-filled. Ambiguous and missing fields start empty.
  const money = (key: Form16FieldKey) => {
    const f = fieldOf(detail, key);
    return f?.status === "found" && f.valuePaise !== null ? formatPaiseForInput(f.valuePaise) : "";
  };
  const ay = fieldOf(detail, "assessmentYear");
  const employer = fieldOf(detail, "employerName");
  return {
    assessmentYear: ay?.status === "found" && ay.value && detail.supportedAssessmentYears.includes(ay.value) ? ay.value : "",
    employerName: employer?.status === "found" && employer.value ? employer.value : "",
    gross: money("grossSalary"),
    exemptions: money("section10Exemptions"),
    section80C: money("section80C"),
  };
}

type Parsed = { paise: number | null; error: string | null };
function parseMoney(text: string, { required, emptyMessage }: { required: boolean; emptyMessage: string }): Parsed {
  const parsed = parseRupeesToPaise(text);
  if (parsed.ok) return { paise: parsed.paise, error: null };
  if (parsed.reason === "empty") return { paise: null, error: required ? emptyMessage : null };
  return { paise: null, error: parsed.message };
}

export default function Form16Review({
  documentId,
  onClose,
  onConfirmed,
}: {
  documentId: string;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [values, setValues] = useState<Values>(EMPTY);
  const [confirm, setConfirm] = useState<Confirm>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<Form16Detail>(`/api/documents/${documentId}`, { signal: controller.signal })
      .then((detail) => {
        setValues(initialValues(detail));
        setConfirm({ status: "idle" });
        setLoad({ status: "ready", detail });
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setLoad({ status: "error", message: messageOf(err) });
      });
    return () => controller.abort();
  }, [documentId, attempt]);

  const detail = load.status === "ready" ? load.detail : null;

  const checks = useMemo(() => {
    const gross = parseMoney(values.gross, { required: true, emptyMessage: "Enter the gross salary." });
    const exemptions = parseMoney(values.exemptions, {
      required: true,
      emptyMessage: "Enter the total exempt under Section 10. Use 0 if there is none.",
    });
    const c80 = parseMoney(values.section80C, { required: false, emptyMessage: "" });

    let grossError = gross.error;
    let exemptionsError = exemptions.error;
    if (!grossError && gross.paise === 0) grossError = "Gross salary must be more than zero.";
    if (!grossError && !exemptionsError && gross.paise !== null && exemptions.paise !== null && exemptions.paise > gross.paise) {
      exemptionsError = "Exemptions can’t be more than the gross salary.";
    }
    const yearError = values.assessmentYear ? null : "Choose the assessment year this Form 16 is for.";

    const derived =
      !grossError && !exemptionsError && gross.paise !== null && exemptions.paise !== null
        ? deriveSalaryIncome(gross.paise, exemptions.paise)
        : null;

    const stated = detail ? fieldOf(detail, "salaryFromCurrentEmployer") : undefined;
    const consistency =
      derived !== null && gross.paise !== null && exemptions.paise !== null
        ? salaryConsistency(gross.paise, exemptions.paise, stated?.status === "found" ? stated.valuePaise : null)
        : null;

    return {
      gross,
      exemptions,
      c80,
      errors: { gross: grossError, exemptions: exemptionsError, section80C: c80.error, year: yearError },
      derived,
      consistency,
      valid: !grossError && !exemptionsError && !c80.error && !yearError && derived !== null,
    };
  }, [values, detail]);

  const submit = async () => {
    if (!checks.valid || checks.gross.paise === null || checks.exemptions.paise === null) return;
    setConfirm({ status: "saving" });
    try {
      const confirmed = await requestJson<Form16Confirmed>(`/api/documents/${documentId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assessmentYear: values.assessmentYear,
          employerName: values.employerName.trim() === "" ? null : values.employerName.trim(),
          grossSalaryPaise: checks.gross.paise,
          section10ExemptionsPaise: checks.exemptions.paise,
          section80CPaise: checks.c80.paise,
        }),
      });
      setConfirm({ status: "done", confirmed });
      onConfirmed();
    } catch (err) {
      setConfirm({ status: "error", message: err instanceof ApiFailure ? err.message : "Couldn’t save. Try again." });
    }
  };

  const set = (patch: Partial<Values>) => {
    setValues((v) => ({ ...v, ...patch }));
    if (confirm.status === "done" || confirm.status === "error") setConfirm({ status: "idle" });
  };

  return (
    <div className="space-y-6">
      {detail && <p className="truncate text-label text-foreground-muted">{detail.document.filename}</p>}

      {load.status === "loading" && <LoadingState label="Opening…" />}
      {load.status === "error" && (
        <ErrorState
          title="Couldn’t open this document"
          message={load.message}
          onRetry={() => {
            setLoad({ status: "loading" });
            setAttempt((n) => n + 1);
          }}
        />
      )}

      {detail && detail.extraction.status === "failed" && (
        <div role="status" className="rounded-md bg-danger-soft p-4 text-body text-foreground">
          {detail.extraction.failureMessage ?? "This document couldn’t be read."}
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}

      {detail && detail.extraction.status !== "failed" && (
        <>
          <p className="rounded-md bg-warning-soft px-4 py-3 text-label text-foreground">
            SmartCA read these values from your PDF. <strong className="font-semibold">Nothing is used until you confirm them.</strong> Check
            each against your document; you can change any of them.
          </p>

          {detail.extraction.confirmed && (
            <p role="status" className="flex items-center gap-2 text-label text-foreground">
              <Badge tone="success">Confirmed</Badge>
              on {formatUploaded(detail.document.confirmedAt ?? detail.document.uploadedAt)}. Change anything and confirm again to update it.
            </p>
          )}
          {!detail.extraction.extracted.recognised.partB && (
            <p role="status" className="rounded-md border border-border px-4 py-3 text-label text-foreground">
              The salary details (Part B) weren’t found in this file. Upload the full Form 16, or enter the figures yourself from your copy.
            </p>
          )}

          <fieldset className="space-y-6">
            <legend className="mb-4 text-subheading font-semibold text-foreground">Values SmartCA can use</legend>

            <ReviewRow
              id="f16-year"
              label="Assessment year"
              field={fieldOf(detail, "assessmentYear")}
              error={checks.errors.year}
              control={
                <Select id="f16-year" value={values.assessmentYear} onChange={(e) => set({ assessmentYear: e.target.value })} aria-invalid={checks.errors.year ? true : undefined}>
                  <option value="">Choose…</option>
                  {detail.supportedAssessmentYears.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
              }
              onPick={(c) => c.value && detail.supportedAssessmentYears.includes(c.value) && set({ assessmentYear: c.value })}
              candidateLabel={(c) => c.value ?? ""}
            />

            <ReviewRow
              id="f16-employer"
              label="Employer name (for your reference)"
              field={fieldOf(detail, "employerName")}
              error={null}
              control={<Input id="f16-employer" value={values.employerName} onChange={(e) => set({ employerName: e.target.value })} autoComplete="off" maxLength={100} />}
              onPick={(c) => c.value && set({ employerName: c.value })}
              candidateLabel={(c) => c.value ?? ""}
            />

            <ReviewRow
              id="f16-gross"
              label="Gross salary"
              field={fieldOf(detail, "grossSalary")}
              error={checks.errors.gross}
              control={<MoneyInput id="f16-gross" value={values.gross} onChange={(v) => set({ gross: v })} invalid={!!checks.errors.gross} />}
              onPick={(c) => c.valuePaise !== null && set({ gross: formatPaiseForInput(c.valuePaise) })}
              candidateLabel={(c) => (c.valuePaise === null ? "" : formatRupees(c.valuePaise))}
            />

            <ReviewRow
              id="f16-exempt"
              label="Exempt under Section 10 (total)"
              field={fieldOf(detail, "section10Exemptions")}
              error={checks.errors.exemptions}
              hint="Allowances such as HRA that are exempt. Enter 0 if there are none."
              control={<MoneyInput id="f16-exempt" value={values.exemptions} onChange={(v) => set({ exemptions: v })} invalid={!!checks.errors.exemptions} />}
              onPick={(c) => c.valuePaise !== null && set({ exemptions: formatPaiseForInput(c.valuePaise) })}
              candidateLabel={(c) => (c.valuePaise === null ? "" : formatRupees(c.valuePaise))}
            />

            <ReviewRow
              id="f16-80c"
              label="Section 80C deduction (optional)"
              field={fieldOf(detail, "section80C")}
              error={checks.errors.section80C}
              hint="Only what your employer recorded. You can add more in the Tax workspace. Leave blank for none."
              control={<MoneyInput id="f16-80c" value={values.section80C} onChange={(v) => set({ section80C: v })} invalid={!!checks.errors.section80C} />}
              onPick={(c) => c.valuePaise !== null && set({ section80C: formatPaiseForInput(c.valuePaise) })}
              candidateLabel={(c) => (c.valuePaise === null ? "" : formatRupees(c.valuePaise))}
            />
          </fieldset>

          <section aria-label="Salary income SmartCA will use" className="rounded-panel border border-border bg-surface p-4 sm:p-5">
            <h3 className="text-subheading font-semibold text-foreground">Salary income SmartCA will use</h3>
            <p className="mt-1 text-label text-foreground-muted">
              Gross salary minus the Section 10 exemptions. The tax calculation applies the standard deduction itself.
            </p>
            {checks.derived !== null ? (
              <dl className="mt-4 text-body">
                <DerivationRow label="Gross salary" value={formatRupees(checks.gross.paise ?? 0)} />
                <DerivationRow label="Less: exempt under Section 10" value={formatRupees(-(checks.exemptions.paise ?? 0))} />
                <div className="rule-subtotal rule-settled mt-1 flex items-baseline justify-between gap-4 py-2.5">
                  <dt className="font-semibold text-foreground">Salary income</dt>
                  <dd className="font-numeric text-heading font-semibold text-foreground">{formatRupees(checks.derived)}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-label text-foreground-muted">Enter the gross salary and the Section 10 exemptions to see it.</p>
            )}
            {checks.consistency && !checks.consistency.matches && (
              <p role="status" className="mt-3 rounded-md bg-warning-soft px-4 py-3 text-label text-foreground">
                Your Form 16 states {formatRupees(checks.consistency.statedPaise)} as salary from the current employer, but these figures give{" "}
                {formatRupees(checks.consistency.derivedPaise)}. Check the values above.
              </p>
            )}
          </section>

          <details className="group rounded-panel border border-border">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 rounded-panel px-4 text-body font-medium text-foreground focus-visible:focus-ring sm:px-5 [&::-webkit-details-marker]:hidden">
              Read for reference, not used
              <span aria-hidden="true" className="text-label font-normal text-foreground-muted group-open:hidden">
                Show
              </span>
              <span aria-hidden="true" className="hidden text-label font-normal text-foreground-muted group-open:inline">
                Hide
              </span>
            </summary>
            <ul className="space-y-3 border-t border-divider px-4 py-4 sm:px-5">
              {detail.extraction.extracted.fields
                .filter((f) => f.usage === "not_used")
                .map((f) => (
                  <li key={f.key} className="text-label">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-foreground">{f.label}</span>
                      <span className="font-numeric text-foreground-muted">
                        {f.status === "found" && f.valuePaise !== null
                          ? formatRupees(f.valuePaise)
                          : f.status === "ambiguous"
                            ? "Several values"
                            : "Not found"}
                      </span>
                    </div>
                    {f.note && <p className="mt-0.5 text-foreground-muted">{f.note}</p>}
                  </li>
                ))}
            </ul>
          </details>

          <div className="sticky -bottom-5 -mx-5 -mb-5 space-y-2 border-t border-divider bg-surface-elevated px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:-mx-6 sm:px-6 sm:pb-5">
            {confirm.status === "error" && (
              <p role="alert" className="text-label text-danger">
                {confirm.message}
              </p>
            )}
            {confirm.status === "done" ? (
              <div role="status" className="flex flex-wrap items-center gap-3">
                <p className="text-label text-foreground">
                  <Badge tone="success">Confirmed</Badge> The Tax page will offer these values as a suggestion; nothing is filled in for you.
                </p>
                <Link href="/taxes" className={buttonClasses("secondary", "sm")}>
                  Open the Tax page
                </Link>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <Button onClick={submit} disabled={!checks.valid || confirm.status === "saving"} aria-busy={confirm.status === "saving"} className="w-full sm:w-auto">
                  {confirm.status === "saving" ? "Saving…" : detail.extraction.confirmed ? "Update confirmed values" : "Confirm these values"}
                </Button>
                {!checks.valid && <p className="text-label text-foreground-muted">Fix the highlighted values to continue.</p>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DerivationRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-divider py-2">
      <dt className="text-foreground-secondary">{label}</dt>
      <dd className="font-numeric text-foreground">{value}</dd>
    </div>
  );
}

function MoneyInput({ id, value, onChange, invalid }: { id: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-body text-foreground-muted">
        ₹
      </span>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        placeholder="0"
        className="pl-7 text-right font-numeric"
        aria-invalid={invalid ? true : undefined}
      />
    </div>
  );
}

const STATUS_BADGE: Record<Form16Field["status"], { label: string; tone: "neutral" | "warning" }> = {
  found: { label: "Read from PDF", tone: "neutral" },
  ambiguous: { label: "Check: several values", tone: "warning" },
  missing: { label: "Not found", tone: "neutral" },
};

// One reviewable value: the input, how confidently it was read, the line it
// came from, and (when the parser found several) each candidate to choose from.
function ReviewRow({
  id,
  label,
  field,
  control,
  error,
  hint,
  onPick,
  candidateLabel,
}: {
  id: string;
  label: string;
  field: Form16Field | undefined;
  control: React.ReactNode;
  error: string | null;
  hint?: string;
  onPick: (candidate: Form16Field["candidates"][number]) => void;
  candidateLabel: (candidate: Form16Field["candidates"][number]) => string;
}) {
  const status = STATUS_BADGE[field?.status ?? "missing"];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {control}
      {error ? (
        <FieldMessage tone="error" role="alert">
          {error}
        </FieldMessage>
      ) : hint ? (
        <FieldMessage>{hint}</FieldMessage>
      ) : null}

      {field?.status === "ambiguous" && (
        <div className="mt-3 rounded-md bg-warning-soft p-3">
          <p className="text-label text-foreground">Several different values were found. Choose the right one, or type your own:</p>
          <ul className="mt-2 space-y-2">
            {field.candidates.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-label">
                <Button type="button" variant="secondary" size="sm" onClick={() => onPick(c)}>
                  Use {candidateLabel(c)}
                </Button>
                <span className="min-w-0 text-foreground-secondary">
                  Page {c.page}: “{c.text}”
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {field?.status === "found" && field.evidence && (
        <p className="mt-2 border-l-2 border-border pl-3 text-micro text-foreground-muted">
          From page {field.evidence.page}: “{field.evidence.text}”
        </p>
      )}
    </div>
  );
}
