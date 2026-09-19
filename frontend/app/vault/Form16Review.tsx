"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Form16Detail } from "@/services/form16";
import { deriveSalaryIncome, salaryConsistency } from "@/lib/form16-extract";
import type { Form16Confirmed, Form16Field, Form16FieldKey } from "@/lib/form16-extract";
import { formatRupees } from "@/lib/format";
import { formatPaiseForInput, parseRupeesToPaise } from "@/lib/money-input";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { FieldMessage, Input, Label, Select } from "../components/ui/Input";
import { ErrorState, LoadingState } from "../components/ui/States";
import { ApiFailure, formatUploaded, messageOf, requestJson } from "./api";

// Review and confirm the values read from a Form 16.
//
// What the parser read is shown as a CANDIDATE, each with the line it came
// from. Nothing here is used for anything until the person confirms. Where
// the parser found several different values it picks none of them. The
// salary figure SmartCA will use is derived, visibly, from the confirmed
// gross salary minus the Section 10 exemptions.

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
  const headingRef = useRef<HTMLHeadingElement>(null);

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

  useEffect(() => {
    if (load.status === "ready") headingRef.current?.focus();
  }, [load.status]);

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
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-[17px] font-semibold tracking-tight text-foreground focus:outline-none">
            Review Form 16 values
          </h2>
          {detail && <p className="mt-0.5 truncate text-[13px] text-muted-foreground">{detail.document.filename}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {load.status === "loading" && <LoadingState label="Opening…" />}
      {load.status === "error" && (
        <div className="mt-4">
          <ErrorState
            title="Couldn’t open this document"
            message={load.message}
            onRetry={() => {
              setLoad({ status: "loading" });
              setAttempt((n) => n + 1);
            }}
          />
        </div>
      )}

      {detail && detail.extraction.status === "failed" && (
        <p role="status" className="mt-4 text-sm text-foreground">
          {detail.extraction.failureMessage ?? "This document couldn’t be read."}
        </p>
      )}

      {detail && detail.extraction.status !== "failed" && (
        <div className="mt-4 space-y-8">
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            SmartCA read these values from your PDF. <strong className="font-medium text-foreground">Nothing is used until you confirm them.</strong>{" "}
            Check each against your document; you can change any of them.
          </p>

          {detail.extraction.confirmed && (
            <p role="status" className="text-[13px] text-foreground">
              Confirmed on {formatUploaded(detail.document.confirmedAt ?? detail.document.uploadedAt)}. Change anything and confirm again to update it.
            </p>
          )}
          {!detail.extraction.extracted.recognised.partB && (
            <p role="status" className="rounded-[var(--radius-md)] border border-border px-4 py-3 text-[13px] text-foreground">
              The salary details (Part B) weren’t found in this file. Upload the full Form 16, or enter the figures yourself from your copy.
            </p>
          )}

          <fieldset className="space-y-6">
            <legend className="mb-3 text-[15px] font-semibold tracking-tight text-foreground">Values SmartCA can use</legend>

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

          <section aria-label="Salary income SmartCA will use" className="border-t border-border pt-5">
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Salary income SmartCA will use</h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Gross salary minus the Section 10 exemptions. The tax calculation applies the standard deduction itself.
            </p>
            {checks.derived !== null ? (
              <dl className="mt-3 space-y-1.5 text-sm">
                <DerivationRow label="Gross salary" value={formatRupees(checks.gross.paise ?? 0)} />
                <DerivationRow label="Less: exempt under Section 10" value={formatRupees(-(checks.exemptions.paise ?? 0))} />
                <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
                  <dt className="font-medium text-foreground">Salary income</dt>
                  <dd className="font-numeric text-lg font-semibold text-foreground">{formatRupees(checks.derived)}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-[13px] text-muted-foreground">Enter the gross salary and the Section 10 exemptions to see it.</p>
            )}
            {checks.consistency && !checks.consistency.matches && (
              <p role="status" className="mt-3 rounded-[var(--radius-md)] border border-border px-4 py-3 text-[13px] text-foreground">
                Your Form 16 states {formatRupees(checks.consistency.statedPaise)} as salary from the current employer, but these figures give{" "}
                {formatRupees(checks.consistency.derivedPaise)}. Check the values above.
              </p>
            )}
          </section>

          <section aria-label="Read but not used" className="border-t border-border pt-5">
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Read for reference, not used</h3>
            <ul className="mt-3 space-y-3">
              {detail.extraction.extracted.fields
                .filter((f) => f.usage === "not_used")
                .map((f) => (
                  <li key={f.key} className="text-[13px]">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-foreground">{f.label}</span>
                      <span className="font-numeric text-muted-foreground">
                        {f.status === "found" && f.valuePaise !== null
                          ? formatRupees(f.valuePaise)
                          : f.status === "ambiguous"
                            ? "Several values"
                            : "Not found"}
                      </span>
                    </div>
                    {f.note && <p className="mt-0.5 text-muted-foreground">{f.note}</p>}
                  </li>
                ))}
            </ul>
          </section>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
            <Button onClick={submit} disabled={!checks.valid || confirm.status === "saving"}>
              {confirm.status === "saving" ? "Saving…" : detail.extraction.confirmed ? "Update confirmed values" : "Confirm these values"}
            </Button>
            {!checks.valid && <p className="text-[13px] text-muted-foreground">Fix the highlighted values to continue.</p>}
          </div>

          {confirm.status === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {confirm.message}
            </p>
          )}
          {confirm.status === "done" && (
            <p role="status" className="text-sm text-foreground">
              Confirmed. The Tax page will offer these values as a suggestion; nothing is filled in for you.{" "}
              <Link href="/taxes" className="text-foreground underline underline-offset-2">
                Open the Tax page
              </Link>
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

function DerivationRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-numeric text-foreground">{value}</dd>
    </div>
  );
}

function MoneyInput({ id, value, onChange, invalid }: { id: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      placeholder="₹0"
      className="font-numeric"
      aria-invalid={invalid ? true : undefined}
    />
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
        <div className="mt-2">
          <p className="text-[13px] text-muted-foreground">Several different values were found. Choose the right one, or type your own:</p>
          <ul className="mt-1.5 space-y-1.5">
            {field.candidates.map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]">
                <Button type="button" variant="secondary" size="sm" onClick={() => onPick(c)}>
                  Use {candidateLabel(c)}
                </Button>
                <span className="min-w-0 text-muted-foreground">
                  Page {c.page}: “{c.text}”
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {field?.status === "found" && field.evidence && (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
          From page {field.evidence.page}: “{field.evidence.text}”
        </p>
      )}
    </div>
  );
}
