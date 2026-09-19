"use client";

import { useState } from "react";
import type { ChangeEvent } from "react";
import { deductionCapsFor, resolveAssessmentYearRules } from "@/tax-engine";
import type { AgeCategory, ComparisonInput } from "@/tax-engine";
import type { AssessmentYearInfo, LedgerIncomeSuggestion } from "@/services/tax";
import { formatDate, formatRupees } from "@/lib/format";
import { formatPaiseForInput, parseRupeesToPaise } from "@/lib/money-input";
import { Button } from "../components/ui/Button";
import { FieldMessage, Input, Label, Select } from "../components/ui/Input";
import { Section } from "../components/ui/PageHeader";

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
  prefilledFromSaved: boolean;
}) {
  const [ledgerTarget, setLedgerTarget] = useState<LedgerTarget>("salary");

  const set = <K extends keyof TaxFormValues>(key: K, value: TaxFormValues[K]) => onChange({ ...values, [key]: value });
  const text = (key: (typeof MONEY_FIELDS)[number]) => (e: ChangeEvent<HTMLInputElement>) => set(key, e.target.value);

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
      className="space-y-10"
    >
      {prefilledFromSaved && (
        <p className="text-[13px] text-muted-foreground">Filled in from your last saved computation. Change anything you like.</p>
      )}

      <Section title="Income" aside={`Earned in FY ${assessmentYear.financialYearLabel}`}>
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
        <p className="mt-3 text-[13px] text-muted-foreground">
          Enter gross amounts before any deductions. Amounts like 1,50,000 or 1,50,000.50 are fine.
        </p>

        {ledgerSuggestion && (
          <div className="mt-5 rounded-[var(--radius-md)] border border-border p-4 text-[13px]">
            <p className="text-foreground">
              Your ledger records{" "}
              <span className="font-numeric font-medium">{formatRupees(ledgerSuggestion.incomeTotalPaise)}</span> of income
              between {formatDate(ledgerSuggestion.fromDate)} and {formatDate(ledgerSuggestion.toDate)} (
              {ledgerSuggestion.transactionCount} {ledgerSuggestion.transactionCount === 1 ? "transaction" : "transactions"}:{" "}
              {ledgerSuggestion.categories.map((c) => `${c.category} ${formatRupees(c.totalPaise)}`).join(", ")}).
            </p>
            <p className="mt-1 text-muted-foreground">
              Ledger categories aren’t tax classifications, so nothing is filled in until you choose. Check it against your
              payslips or Form 16 first.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select
                aria-label="Which income field to use the ledger total for"
                value={ledgerTarget}
                onChange={(e) => setLedgerTarget(e.target.value as LedgerTarget)}
                className="w-auto"
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
          </div>
        )}
      </Section>

      <Section title="About you">
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
      </Section>

      <Section title="Deductions" aside="Old regime only">
        <p className="mb-4 text-[13px] text-muted-foreground">
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
            label="Section 80D: self and family"
            value={values.healthSelfFamily}
            onChange={text("healthSelfFamily")}
            error={errors.healthSelfFamily}
            hint={`Health insurance for you, your spouse and children. Limit ${formatRupees(caps.selfFamilyPaise)}.`}
          />
          <MoneyField
            id="tax-80d-parents"
            label="Section 80D: parents"
            value={values.healthParents}
            onChange={text("healthParents")}
            error={errors.healthParents}
            hint={`Limit ${formatRupees(caps.parentsPaise)}.`}
          />
        </div>

        <div className="mt-4 space-y-2">
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

        <p className="mt-4 text-[13px] text-muted-foreground">
          The standard deduction is applied automatically to salary: {formatRupees(rules.regimes.new.standardDeductionPaise)} under
          the new regime and {formatRupees(rules.regimes.old.standardDeductionPaise)} under the old regime. It isn’t something you
          enter.
        </p>
      </Section>

      <div>
        <Button type="submit" disabled={calculating}>
          {calculating ? "Calculating…" : "Calculate"}
        </Button>
      </div>
    </form>
  );
}

function MoneyField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  hint?: string;
}) {
  const messageId = `${id}-message`;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={onChange}
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        placeholder="₹0"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        className="font-numeric"
      />
      {error ? (
        <FieldMessage id={messageId} tone="error" aria-live="polite">
          {error}
        </FieldMessage>
      ) : hint ? (
        <FieldMessage id={messageId}>{hint}</FieldMessage>
      ) : null}
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
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded-[4px] accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      {label}
    </label>
  );
}
