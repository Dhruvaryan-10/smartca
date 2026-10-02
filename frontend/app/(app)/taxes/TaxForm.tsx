"use client";

import { useState } from "react";
import { deductionCapsFor, resolveAssessmentYearRules } from "@/tax-engine";
import type { AgeCategory, ComparisonInput } from "@/tax-engine";
import type { Form16Suggestion } from "@/services/form16";
import type { AssessmentYearInfo, LedgerIncomeSuggestion } from "@/services/tax";
import { formatDate, formatRupees } from "@/lib/format";
import { formatPaiseForInput, parseRupeesToPaise } from "@/lib/money-input";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { FieldMessage, Label, Select } from "../../components/ui/Input";
import { MoneyField } from "../../components/ui/MoneyField";

// ---------------------------------------------------------------------
// Form state and parsing (pure: no React, no network)
// ---------------------------------------------------------------------

export type TaxFormValues = {
  salary: string;
  business: string;
  other: string;
  ageCategory: AgeCategory;
  section80C: string;
  healthSelfFamily: string;
  healthParents: string;
  spouseIsSenior: boolean;
  anyParentIsSenior: boolean;
};

export const EMPTY_TAX_FORM: TaxFormValues = {
  salary: "",
  business: "",
  other: "",
  ageCategory: "below60",
  section80C: "",
  healthSelfFamily: "",
  healthParents: "",
  spouseIsSenior: false,
  anyParentIsSenior: false,
};

/** The body POSTed to /api/tax/compute. Inputs only; the server decides everything else. */
export type TaxRequestBody = {
  assessmentYear: string;
  ageCategory: AgeCategory;
  income: { salaryPaise: number; businessPaise: number; otherPaise: number };
  deductions: {
    section80CPaise: number;
    healthInsurance: {
      selfFamilyPaise: number;
      parentsPaise: number;
      spouseIsSenior: boolean;
      anyParentIsSenior: boolean;
    };
  };
};

export type TaxFormErrors = Partial<Record<Exclude<keyof TaxFormValues, "ageCategory" | "spouseIsSenior" | "anyParentIsSenior"> | "income", string>>;

export type ParsedTaxForm = { ok: true; request: TaxRequestBody } | { ok: false; errors: TaxFormErrors };

const MONEY_FIELDS = ["salary", "business", "other", "section80C", "healthSelfFamily", "healthParents"] as const;

/** Empty means zero; anything else must be an exact, non-negative amount. */
export function parseTaxForm(values: TaxFormValues, assessmentYear: string): ParsedTaxForm {
  const errors: TaxFormErrors = {};
  const paise = {} as Record<(typeof MONEY_FIELDS)[number], number>;

  for (const field of MONEY_FIELDS) {
    const parsed = parseRupeesToPaise(values[field]);
    if (parsed.ok) paise[field] = parsed.paise;
    else if (parsed.reason === "empty") paise[field] = 0;
    else {
      paise[field] = 0;
      errors[field] = parsed.message;
    }
  }

  if (!errors.salary && !errors.business && !errors.other && paise.salary + paise.business + paise.other === 0) {
    errors.income = "Enter at least one income amount.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    request: {
      assessmentYear,
      ageCategory: values.ageCategory,
      income: { salaryPaise: paise.salary, businessPaise: paise.business, otherPaise: paise.other },
      deductions: {
        section80CPaise: paise.section80C,
        healthInsurance: {
          selfFamilyPaise: paise.healthSelfFamily,
          parentsPaise: paise.healthParents,
          spouseIsSenior: values.spouseIsSenior,
          anyParentIsSenior: values.anyParentIsSenior,
        },
      },
    },
  };
}

/** Rebuild form values from a server-validated input (for reusing a saved computation's inputs). */
export function taxFormFromInput(input: ComparisonInput): TaxFormValues {
  const sum = (kind: "salary" | "business" | "other") =>
    input.incomeSources.filter((s) => s.kind === kind).reduce((total, s) => total + s.amountPaise, 0);
  const text = (paise: number) => (paise > 0 ? formatPaiseForInput(paise) : "");

  const c80 = input.deductions.find((d) => d.section === "80C");
  const d80 = input.deductions.find((d) => d.section === "80D");

  return {
    salary: text(sum("salary")),
    business: text(sum("business")),
    other: text(sum("other")),
    ageCategory: input.ageCategory,
    section80C: c80 && c80.section === "80C" ? text(c80.amountPaise) : "",
    healthSelfFamily: d80 && d80.section === "80D" ? text(d80.selfFamilyPaise) : "",
    healthParents: d80 && d80.section === "80D" ? text(d80.parentsPaise) : "",
    spouseIsSenior: d80 && d80.section === "80D" ? d80.spouseIsSenior === true : false,
    anyParentIsSenior: d80 && d80.section === "80D" ? d80.anyParentIsSenior === true : false,
  };
}

// ---------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------

const AGE_OPTIONS: Array<{ value: AgeCategory; label: string }> = [
  { value: "below60", label: "Below 60" },
  { value: "senior", label: "Senior citizen (60 to 79)" },
  { value: "superSenior", label: "Super senior citizen (80 or above)" },
];

type LedgerTarget = "salary" | "business" | "other";

export default function TaxForm({
  values,
  errors,
  onChange,
  onSubmit,
  calculating,
  assessmentYear,
  ledgerSuggestion,
  form16Suggestions,
  prefilledFromSaved,
}: {
  values: TaxFormValues;
  /** Errors to display; the page decides when they become visible. */
  errors: TaxFormErrors;
  onChange: (next: TaxFormValues) => void;
  onSubmit: () => void;
  calculating: boolean;
  assessmentYear: AssessmentYearInfo;
  ledgerSuggestion: LedgerIncomeSuggestion | null;
  /** Values the user confirmed in the Vault. Offered, never applied automatically. */
  form16Suggestions: Form16Suggestion[];
  prefilledFromSaved: boolean;
}) {
  const [ledgerTarget, setLedgerTarget] = useState<LedgerTarget>("salary");

  const set = <K extends keyof TaxFormValues>(key: K, value: TaxFormValues[K]) => onChange({ ...values, [key]: value });
  const text = (key: (typeof MONEY_FIELDS)[number]) => (value: string) => set(key, value);

  // The limits shown are read from the same rules data the engine enforces.
  const caps = deductionCapsFor(assessmentYear.label, {
    ageCategory: values.ageCategory,
    spouseIsSenior: values.spouseIsSenior,
    anyParentIsSenior: values.anyParentIsSenior,
  });
  const rules = resolveAssessmentYearRules(assessmentYear.label);

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-5"
      aria-label="Tax inputs"
    >
      {prefilledFromSaved && (
        <p className="rounded-md bg-info-soft px-3.5 py-2.5 text-label text-foreground">
          Filled in from your last saved computation. Change anything you like.
        </p>
      )}

      <FormPanel title="Income" aside={`Earned in FY ${assessmentYear.financialYearLabel}`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MoneyField id="tax-salary" label="Salary" value={values.salary} onChange={text("salary")} error={errors.salary} />
          <MoneyField
            id="tax-business"
            label="Business or professional"
            value={values.business}
            onChange={text("business")}
            error={errors.business}
          />
          <MoneyField id="tax-other" label="Other income" value={values.other} onChange={text("other")} error={errors.other} />
        </div>
        {errors.income && (
          <FieldMessage tone="error" role="alert">
            {errors.income}
          </FieldMessage>
        )}
        <p className="mt-3 text-label text-foreground-muted">
          Enter gross amounts before any deductions. Amounts like 1,50,000 or 1,50,000.50 are fine.
        </p>

        {(form16Suggestions.length > 0 || ledgerSuggestion) && (
          <div className="mt-5 space-y-3">
            {form16Suggestions.map((s) => (
              <Suggestion key={s.documentId} source={<Badge tone="tax">Form 16 · confirmed</Badge>}>
                <p className="text-foreground">
                  A Form 16 you confirmed{s.employerName ? ` (${s.employerName})` : ""} gives salary income of{" "}
                  <span className="font-numeric font-medium">{formatRupees(s.salaryIncomePaise)}</span>: gross salary{" "}
                  {formatRupees(s.grossSalaryPaise)} less {formatRupees(s.section10ExemptionsPaise)} exempt under Section 10.
                </p>
                <p className="mt-1 text-foreground-muted">
                  These are the values you confirmed in the Vault. Nothing is filled in until you choose. The standard deduction is
                  applied by the calculation itself.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => set("salary", formatPaiseForInput(s.salaryIncomePaise))}>
                    Use {formatRupees(s.salaryIncomePaise)} as salary
                  </Button>
                  {s.section80CPaise !== null && s.section80CPaise > 0 && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => set("section80C", formatPaiseForInput(s.section80CPaise as number))}
                    >
                      Use {formatRupees(s.section80CPaise)} as Section 80C
                    </Button>
                  )}
                </div>
              </Suggestion>
            ))}

            {ledgerSuggestion && (
              <Suggestion source={<Badge tone="income">From your ledger</Badge>}>
                <p className="text-foreground">
                  Your ledger records{" "}
                  <span className="font-numeric font-medium">{formatRupees(ledgerSuggestion.incomeTotalPaise)}</span> of income
                  between {formatDate(ledgerSuggestion.fromDate)} and {formatDate(ledgerSuggestion.toDate)} (
                  {ledgerSuggestion.transactionCount} {ledgerSuggestion.transactionCount === 1 ? "transaction" : "transactions"}:{" "}
                  {ledgerSuggestion.categories.map((c) => `${c.category} ${formatRupees(c.totalPaise)}`).join(", ")}).
                </p>
                <p className="mt-1 text-foreground-muted">
                  Ledger categories aren’t tax classifications, so nothing is filled in until you choose. Check it against your
                  payslips or Form 16 first.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="Which income field to use the ledger total for"
                    value={ledgerTarget}
                    onChange={(e) => setLedgerTarget(e.target.value as LedgerTarget)}
                    className="sm:w-auto"
                  >
                    <option value="salary">Salary</option>
                    <option value="business">Business or professional</option>
                    <option value="other">Other income</option>
                  </Select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => set(ledgerTarget, formatPaiseForInput(ledgerSuggestion.incomeTotalPaise))}
                  >
                    Use {formatRupees(ledgerSuggestion.incomeTotalPaise)}
                  </Button>
                </div>
              </Suggestion>
            )}
          </div>
        )}
      </FormPanel>

      <FormPanel title="About you">
        <div className="max-w-sm">
          <Label htmlFor="tax-age">Age category</Label>
          <Select
            id="tax-age"
            value={values.ageCategory}
            onChange={(e) => set("ageCategory", e.target.value as AgeCategory)}
            aria-describedby="tax-age-hint"
          >
            {AGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <FieldMessage id="tax-age-hint">
            Your age at any time during FY {assessmentYear.financialYearLabel}. It changes old-regime slabs and the 80D limit.
          </FieldMessage>
        </div>
      </FormPanel>

      <FormPanel title="Deductions" aside={<Badge>Old regime only</Badge>}>
        <p className="mb-4 text-label text-foreground-muted">
          The new regime allows none of these. Enter what you paid; anything above the legal limit is shown and left out of the
          calculation.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MoneyField
            id="tax-80c"
            label="Section 80C"
            value={values.section80C}
            onChange={text("section80C")}
            error={errors.section80C}
            hint={`Limit ${formatRupees(caps.section80CPaise)} combined (Section 80CCE).`}
          />
          <MoneyField
            id="tax-80d-self"
            label="80D: self and family"
            value={values.healthSelfFamily}
            onChange={text("healthSelfFamily")}
            error={errors.healthSelfFamily}
            hint={`Health insurance for you, your spouse and children. Limit ${formatRupees(caps.selfFamilyPaise)}.`}
          />
          <MoneyField
            id="tax-80d-parents"
            label="80D: parents"
            value={values.healthParents}
            onChange={text("healthParents")}
            error={errors.healthParents}
            hint={`Limit ${formatRupees(caps.parentsPaise)}.`}
          />
        </div>

        <div className="mt-4 space-y-1">
          <Checkbox
            id="tax-spouse-senior"
            checked={values.spouseIsSenior}
            onChange={(checked) => set("spouseIsSenior", checked)}
            label="My spouse is a senior citizen (60 or above)"
          />
          <Checkbox
            id="tax-parent-senior"
            checked={values.anyParentIsSenior}
            onChange={(checked) => set("anyParentIsSenior", checked)}
            label="A parent is a senior citizen (60 or above)"
          />
        </div>

        <p className="mt-4 border-t border-divider pt-4 text-label text-foreground-muted">
          The standard deduction is applied automatically to salary: {formatRupees(rules.regimes.new.standardDeductionPaise)} under
          the new regime and {formatRupees(rules.regimes.old.standardDeductionPaise)} under the old regime. It isn’t something you
          enter.
        </p>
      </FormPanel>

      <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
        <Button type="submit" size="lg" disabled={calculating} aria-busy={calculating} className="w-full sm:w-auto">
          {calculating ? "Calculating…" : "Calculate both regimes"}
        </Button>
        <p className="text-label text-foreground-muted">Calculated on SmartCA’s server. Nothing is saved until you choose to save it.</p>
      </div>
    </form>
  );
}

function FormPanel({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface p-5 sm:p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-subheading font-semibold text-foreground">{title}</h2>
        {aside && <div className="text-label text-foreground-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

// A value SmartCA can offer from elsewhere (a confirmed Form 16, the
// ledger). Marked with where it came from; never applied by itself.
function Suggestion({ source, children }: { source: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background p-4 text-label">
      <div className="mb-2">{source}</div>
      {children}
    </div>
  );
}

function Checkbox({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label
      htmlFor={id}
      className="-mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-control px-2 text-body text-foreground transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken sm:min-h-9"
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 rounded-xs accent-[var(--primary)] focus-visible:focus-ring"
      />
      {label}
    </label>
  );
}
