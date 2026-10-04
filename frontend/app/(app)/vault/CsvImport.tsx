"use client";

import { useState } from "react";
import Link from "next/link";
import type { CsvImportSummary, CsvPreview, MatchedRow } from "@/services/imports";
import type { AmountMode, ColumnRole, CsvMapping, SignedConvention } from "@/lib/csv-import";
import { DATE_FORMATS } from "@/lib/date-parse";
import type { DateFormatId } from "@/lib/date-parse";
import { formatDate, formatRupees } from "@/lib/format";
import { Badge } from "../../components/ui/Badge";
import { Button, buttonClasses } from "../../components/ui/Button";
import { DropZone } from "../../components/ui/DropZone";
import { IconCheck, IconTable } from "../../components/ui/Icons";
import { FieldMessage, Input, Label, Select } from "../../components/ui/Input";
import { Money } from "../../components/ui/Money";
import { messageOf, requestJson } from "./api";

// Import transactions from a CSV in two steps: check, then confirm.
//
// Nothing is guessed. Every interpretation that changes what gets imported
// (the amount layout, what a positive amount means, the date format, the
// default category) is a visible choice the person makes. The file's own
// headers may pre-select a column, and the choice is shown as a suggestion to
// check. Checking a file writes nothing. Importing sends the same file and
// the same mapping again, and the server re-validates everything.
//
// The state and requests live in useCsvImport(); the Vault page renders the
// file tile (CsvImportTile) beside the Form 16 upload and the full flow
// (CsvImportFlow) below, once a file has been chosen.

type Delimiter = CsvMapping["delimiter"];

type Form = {
  delimiter: Delimiter;
  dateFormat: DateFormatId | "";
  amountMode: AmountMode | "";
  signedConvention: SignedConvention | "";
  columns: Record<ColumnRole, number | null>;
  defaultCategory: string;
};

const NO_COLUMNS: Form["columns"] = { date: null, description: null, category: null, amount: null, debit: null, credit: null, type: null };

const DELIMITER_LABEL: Record<Delimiter, string> = { ",": "Comma", ";": "Semicolon", "\t": "Tab", "|": "Pipe" };

// Which columns each layout needs. Mirrors what the server requires.
const ROLES_BY_MODE: Record<AmountMode, ColumnRole[]> = {
  signed: ["date", "description", "category", "amount"],
  debit_credit: ["date", "description", "category", "debit", "credit"],
  amount_with_type: ["date", "description", "category", "amount", "type"],
};
const ROLE_LABEL: Record<ColumnRole, string> = {
  date: "Date",
  description: "Description",
  category: "Category",
  amount: "Amount",
  debit: "Debit (money out)",
  credit: "Credit (money in)",
  type: "Type (income or expense)",
};
const OPTIONAL: ColumnRole[] = ["description", "category"];

type Step =
  | { name: "choose" }
  | { name: "map" }
  | { name: "done"; summary: CsvImportSummary };

type Checked = Extract<NonNullable<CsvPreview["mapping"]>, { status: "checked" }>;

const BLANK_FORM: Form = {
  delimiter: ",",
  dateFormat: "",
  amountMode: "",
  signedConvention: "",
  columns: NO_COLUMNS,
  defaultCategory: "Uncategorized",
};

function initialForm(preview: CsvPreview): Form {
  const columns = { ...NO_COLUMNS };
  for (const [role, index] of Object.entries(preview.suggestion.columns)) columns[role as ColumnRole] = index;
  return {
    delimiter: preview.delimiter,
    dateFormat: preview.suggestion.dateFormat ?? "",
    amountMode: preview.suggestion.amountMode ?? "",
    signedConvention: "",
    columns,
    defaultCategory: "Uncategorized",
  };
}

// Only the columns for the chosen layout are sent; the rest would be ignored anyway.
function toMapping(form: Form) {
  return {
    delimiter: form.delimiter,
    dateFormat: form.dateFormat || undefined,
    amountMode: form.amountMode || undefined,
    signedConvention: form.amountMode === "signed" ? form.signedConvention || undefined : undefined,
    columns: form.columns,
    defaultCategory: form.defaultCategory,
  };
}

function send(path: "preview" | "commit", file: File, mapping?: ReturnType<typeof toMapping>, includeLines?: number[]) {
  const body = new FormData();
  body.append("file", file);
  if (mapping) body.append("mapping", JSON.stringify(mapping));
  // Lines of rows that match earlier imports but were ticked to import anyway. Absent means none.
  if (includeLines && includeLines.length > 0) body.append("includeLines", JSON.stringify(includeLines));
  return requestJson<CsvPreview & CsvImportSummary>(`/api/imports/csv/${path}`, { method: "POST", body });
}

const NO_LINES: ReadonlySet<number> = new Set();

export function useCsvImport() {
  const [step, setStep] = useState<Step>({ name: "choose" });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [form, setForm] = useState<Form>(BLANK_FORM);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [selection, setSelection] = useState<{ source: Checked; lines: ReadonlySet<number> } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState<"reading" | "checking" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which matched rows are ticked to import anyway. Tied to the check it was made on, so any new check
  // or changed choice starts again with nothing ticked (the default: matched rows are skipped).
  const chosen: ReadonlySet<number> = checked && selection?.source === checked ? selection.lines : NO_LINES;
  const toggleLine = (line: number) => {
    if (!checked) return;
    const next = new Set(chosen);
    if (!next.delete(line)) next.add(line);
    setSelection({ source: checked, lines: next });
  };
  const chooseAll = (on: boolean) => {
    if (checked) setSelection({ source: checked, lines: on ? new Set(checked.matchedRows.map((r) => r.line)) : new Set() });
  };

  const reset = () => {
    setStep({ name: "choose" });
    setFile(null);
    setPreview(null);
    setChecked(null);
    setProblems([]);
    setError(null);
  };

  const readFile = async (chosenFile: File) => {
    setBusy("reading");
    setError(null);
    try {
      const result = await send("preview", chosenFile);
      setFile(chosenFile);
      setPreview(result);
      setForm(initialForm(result));
      setChecked(null);
      setProblems([]);
      setStep({ name: "map" });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  // Changing any choice invalidates a previous check: what was checked is no longer what would be imported.
  const change = (patch: Partial<Form>) => {
    setForm((f) => ({ ...f, ...patch }));
    setChecked(null);
    setProblems([]);
    setError(null);
  };
  const setColumn = (role: ColumnRole, value: string) => change({ columns: { ...form.columns, [role]: value === "" ? null : Number(value) } });

  // A different delimiter changes which columns exist, so the file is re-read.
  const changeDelimiter = async (delimiter: Delimiter) => {
    if (!file) return;
    setBusy("reading");
    setError(null);
    try {
      const result = await send("preview", file, { delimiter } as ReturnType<typeof toMapping>);
      setPreview(result);
      setForm({ ...initialForm(result), delimiter, defaultCategory: form.defaultCategory });
      setChecked(null);
      setProblems([]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!file) return;
    setBusy("checking");
    setError(null);
    try {
      const result = await send("preview", file, toMapping(form));
      if (result.mapping?.status === "checked") {
        setChecked(result.mapping);
        setProblems([]);
      } else {
        setChecked(null);
        setProblems(result.mapping?.status === "incomplete" ? result.mapping.problems : ["The file couldn’t be checked."]);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const commit = async () => {
    if (!file || !checked?.valid) return;
    setBusy("importing");
    setError(null);
    try {
      const summary = await send("commit", file, toMapping(form), [...chosen].sort((a, b) => a - b));
      setStep({ name: "done", summary });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  return {
    step,
    file,
    preview,
    form,
    checked,
    chosen,
    problems,
    busy,
    error,
    setError,
    toggleLine,
    chooseAll,
    reset,
    readFile,
    change,
    setColumn,
    changeDelimiter,
    check,
    commit,
  };
}

export type CsvImportState = ReturnType<typeof useCsvImport>;

const isCsv = (file: File) => /\.csv$/i.test(file.name) || file.type === "text/csv" || file.type === "application/vnd.ms-excel";

// The tile beside the Form 16 upload: choose or drop a CSV. Once a file is
// being worked on, it says so and points to the steps below.
export function CsvImportTile({ csv }: { csv: CsvImportState }) {
  if (csv.step.name !== "choose" && csv.file) {
    return (
      <div className="flex h-full flex-col rounded-panel border border-border bg-surface p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-accent text-primary">
            <IconTable />
          </span>
          <div className="min-w-0">
            <h3 className="text-subheading font-semibold text-foreground">
              {csv.step.name === "done" ? "Import finished" : "Importing a bank statement"}
            </h3>
            <p className="mt-1 truncate text-label text-foreground-muted">{csv.file.name}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3 sm:mt-auto sm:pt-5">
          <a href="#csv-import" className={buttonClasses("secondary", "md")}>
            {csv.step.name === "done" ? "See what was imported" : "Continue below"}
          </a>
          <Button variant="ghost" onClick={csv.reset} disabled={csv.busy !== null}>
            {csv.step.name === "done" ? "Import another file" : "Start again"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <DropZone
      id="vault-csv"
      accept=".csv,text/csv"
      acceptsFile={isCsv}
      onFile={(file) => void csv.readFile(file)}
      onReject={() => csv.setError("Choose a CSV file. Export your statement from your bank as CSV, then try again.")}
      busy={csv.busy === "reading"}
      icon={<IconTable />}
      title="Import a bank statement"
      description="A CSV of transactions, up to 2 MB and 5,000 rows. It’s checked first; nothing is imported until you confirm."
      buttonLabel="Choose CSV"
      busyLabel="Reading…"
    >
      {csv.error && csv.step.name === "choose" && (
        <p role="alert" className="mt-4 rounded-md bg-danger-soft px-3.5 py-2.5 text-label text-foreground">
          {csv.error}
        </p>
      )}
    </DropZone>
  );
}

const STEPS = ["Choose a file", "Match columns", "Check and import"];

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-label" aria-label="Import steps">
      {STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-pill text-micro font-semibold ${
                done ? "bg-primary text-primary-foreground" : active ? "bg-accent text-primary ring-1 ring-primary" : "bg-surface-sunken text-foreground-muted"
              }`}
            >
              {done ? <IconCheck width={14} height={14} /> : index + 1}
              <span className="sr-only">{done ? " (done)" : active ? " (current)" : ""}</span>
            </span>
            <span className={active ? "font-medium text-foreground" : "text-foreground-muted"}>{label}</span>
            {index < STEPS.length - 1 && <span aria-hidden="true" className="mx-1 hidden h-px w-6 bg-border sm:block" />}
          </li>
        );
      })}
    </ol>
  );
}

// The import steps after a file is chosen: how to read it, the check, and
// the result.
export function CsvImportFlow({ csv }: { csv: CsvImportState }) {
  const { step, preview, file, form, checked, chosen, problems, busy, error } = csv;
  if (step.name === "choose" || !file) return null;

  if (step.name === "done") {
    const s = step.summary;
    return (
      <section id="csv-import" aria-labelledby="csv-import-title" className="reveal space-y-5 rounded-panel border border-border bg-surface p-5 sm:p-6">
        <StepIndicator current={3} />
        <div role="status">
          <h2 id="csv-import-title" className="text-heading font-semibold text-foreground">
            Imported {s.insertedCount} {s.insertedCount === 1 ? "transaction" : "transactions"}
          </h2>
          <dl className="mt-4 max-w-xl space-y-2 text-body">
            <Row label="Rows in the file" value={String(s.rowCount)} />
            <Row label="Already imported earlier, skipped" value={String(s.skippedDuplicateCount)} />
            {s.forcedCount > 0 && <Row label="Imported although they matched earlier rows" value={String(s.forcedCount)} />}
            <Row label="Income added" value={`${s.incomeCount} · ${formatRupees(s.incomeTotalPaise)}`} tone="income" />
            <Row label="Expenses added" value={`${s.expenseCount} · ${formatRupees(s.expenseTotalPaise)}`} tone="expense" />
            {s.defaultCategoryCount > 0 && <Row label="Given the default category" value={String(s.defaultCategoryCount)} />}
          </dl>
        </div>
        {s.skippedRows.length > 0 && (
          <div>
            <p className="text-label text-foreground-muted">These rows matched transactions you had already imported, so they were not imported again:</p>
            <MatchedRowsTable rows={s.skippedRows} caption="Rows skipped because they match earlier imports" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-divider pt-5">
          <Link href="/income" className={buttonClasses("secondary", "sm")}>
            View income
          </Link>
          <Link href="/expenses" className={buttonClasses("secondary", "sm")}>
            View expenses
          </Link>
          <Button variant="ghost" size="sm" onClick={csv.reset}>
            Import another file
          </Button>
        </div>
      </section>
    );
  }

  // step.name === "map"
  if (!preview) return null;
  const headers = preview.headers;
  const columnOptions = (
    <>
      <option value="">Not in this file</option>
      {headers.map((h, i) => (
        <option key={i} value={i}>
          {h === "" ? `Column ${i + 1}` : h}
        </option>
      ))}
    </>
  );
  const roles = form.amountMode ? ROLES_BY_MODE[form.amountMode] : [];
  const notDetected = preview.detectedDateFormats.length === 0;
  const importCount = checked ? checked.newRowCount + chosen.size : 0;

  return (
    <section id="csv-import" aria-labelledby="csv-import-title" className="space-y-8 rounded-panel border border-border bg-surface p-5 sm:p-6">
      <div className="space-y-4">
        <StepIndicator current={checked?.valid ? 2 : 1} />
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div className="min-w-0">
            <h2 id="csv-import-title" className="truncate text-heading font-semibold text-foreground">
              {preview.filename}
            </h2>
            <p className="text-label text-foreground-muted">
              {preview.totalRows} {preview.totalRows === 1 ? "row" : "rows"} · {preview.headers.length} columns
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={csv.reset}>
            Choose a different file
          </Button>
        </div>
      </div>

      <TableFrame>
        <table className="w-full text-left text-label">
          <caption className="sr-only">First rows of the file, as they appear in it</caption>
          <thead className="sticky top-0 bg-surface-sunken">
            <tr className="text-foreground-muted">
              {headers.map((h, i) => (
                <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                  {h === "" ? `Column ${i + 1}` : h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-divider">
            {preview.sampleRows.slice(0, 5).map((row, r) => (
              <tr key={r}>
                {headers.map((_, i) => (
                  <td key={i} className="max-w-[16rem] truncate whitespace-nowrap px-3 py-2 text-foreground">
                    {row[i] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>

      <fieldset className="space-y-5">
        <legend className="mb-1 text-subheading font-semibold text-foreground">How to read this file</legend>
        <p className="max-w-2xl text-label text-foreground-muted">
          Some choices below were suggested from the column names. Check every one against the rows above; SmartCA doesn’t guess what’s left open.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="csv-delimiter">Columns are separated by</Label>
            <Select id="csv-delimiter" value={form.delimiter} disabled={busy !== null} onChange={(e) => void csv.changeDelimiter(e.target.value as Delimiter)}>
              {(Object.keys(DELIMITER_LABEL) as Delimiter[]).map((d) => (
                <option key={d} value={d}>
                  {DELIMITER_LABEL[d]}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="csv-date-format">Dates are written as</Label>
            <Select id="csv-date-format" value={form.dateFormat} onChange={(e) => csv.change({ dateFormat: e.target.value as DateFormatId | "" })}>
              <option value="">Choose…</option>
              {DATE_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} · e.g. {f.example}
                </option>
              ))}
            </Select>
            <FieldMessage>
              {preview.detectedDateFormats.length === 1
                ? "Only this format fits every date in the file."
                : preview.detectedDateFormats.length > 1
                  ? "More than one format fits these dates (such as 05/03/2026), so it’s your call. Pick the one your bank uses."
                  : notDetected && form.columns.date === null
                    ? "Choose the date column first."
                    : "No supported format reads every date in the file. Check the date column."}
            </FieldMessage>
          </div>

          <div>
            <Label htmlFor="csv-amount-mode">Amounts are laid out as</Label>
            <Select id="csv-amount-mode" value={form.amountMode} onChange={(e) => csv.change({ amountMode: e.target.value as AmountMode | "" })}>
              <option value="">Choose…</option>
              <option value="signed">One amount column, with a sign</option>
              <option value="debit_credit">Separate debit and credit columns</option>
              <option value="amount_with_type">Amount column plus a type column</option>
            </Select>
          </div>

          {form.amountMode === "signed" && (
            <div>
              <Label htmlFor="csv-convention">In the amount column, a positive number is</Label>
              <Select
                id="csv-convention"
                value={form.signedConvention}
                onChange={(e) => csv.change({ signedConvention: e.target.value as SignedConvention | "" })}
              >
                <option value="">Choose…</option>
                <option value="positive_is_income">Income (and negative is an expense)</option>
                <option value="positive_is_expense">An expense (and negative is income)</option>
              </Select>
              <FieldMessage>Banks differ, so SmartCA asks rather than assumes.</FieldMessage>
            </div>
          )}

          <div>
            <Label htmlFor="csv-default-category">Category for rows without one</Label>
            <Input
              id="csv-default-category"
              value={form.defaultCategory}
              maxLength={100}
              autoComplete="off"
              onChange={(e) => csv.change({ defaultCategory: e.target.value })}
            />
            <FieldMessage>Used for any row whose category is empty or not mapped.</FieldMessage>
          </div>
        </div>

        {roles.length > 0 && (
          <div className="grid gap-5 border-t border-divider pt-5 sm:grid-cols-2">
            {roles.map((role) => (
              <div key={role}>
                <Label htmlFor={`csv-col-${role}`}>
                  {ROLE_LABEL[role]}
                  {OPTIONAL.includes(role) ? <span className="font-normal text-foreground-muted"> (optional)</span> : ""}
                </Label>
                <Select id={`csv-col-${role}`} value={form.columns[role] ?? ""} onChange={(e) => csv.setColumn(role, e.target.value)}>
                  {columnOptions}
                </Select>
                {role === "type" && (
                  <FieldMessage>Values such as income, credit, cr or expense, debit, dr. Anything else blocks the import.</FieldMessage>
                )}
              </div>
            ))}
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void csv.check()} disabled={busy !== null} aria-busy={busy === "checking"}>
          {busy === "checking" ? "Checking…" : checked ? "Check again" : "Check the file"}
        </Button>
        <p className="text-label text-foreground-muted">Checking writes nothing.</p>
      </div>

      {problems.length > 0 && (
        <div role="alert" className="rounded-md bg-warning-soft p-4 text-label text-foreground">
          <p className="font-medium">Finish these choices first:</p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-danger-soft px-3.5 py-2.5 text-label text-foreground">
          {error}
        </p>
      )}

      {checked && !checked.valid && <RowProblems checked={checked} />}
      {checked && checked.valid && checked.summary && (
        <div className="space-y-6 border-t border-divider pt-6">
          <div>
            <h3 className="text-subheading font-semibold text-foreground">Ready to import</h3>
            <dl className="mt-3 max-w-xl space-y-2 text-body">
              <Row label="Rows in the file" value={String(checked.summary.rowCount)} />
              <Row label="Income" value={`${checked.summary.incomeCount} · ${formatRupees(checked.summary.incomeTotalPaise)}`} tone="income" />
              <Row label="Expenses" value={`${checked.summary.expenseCount} · ${formatRupees(checked.summary.expenseTotalPaise)}`} tone="expense" />
              {checked.summary.defaultCategoryCount > 0 && (
                <Row label={`Will be categorised “${form.defaultCategory.trim()}”`} value={String(checked.summary.defaultCategoryCount)} />
              )}
              {checked.alreadyImportedCount > 0 && (
                <Row label="Match earlier imports, will be skipped unless ticked" value={String(checked.alreadyImportedCount - chosen.size)} />
              )}
            </dl>
          </div>

          <div>
            <p className="mb-2 text-label text-foreground-muted">
              {checked.previewRows.length < checked.summary.rowCount
                ? `First ${checked.previewRows.length} of ${checked.summary.rowCount} rows, as they will be imported`
                : "All rows, as they will be imported"}
            </p>
            <TableFrame>
              <table className="w-full text-left text-label">
                <caption className="sr-only">Rows as they will be imported</caption>
                <thead className="sticky top-0 bg-surface-sunken">
                  <tr className="text-foreground-muted">
                    <th scope="col" className="px-3 py-2 font-medium">Date</th>
                    <th scope="col" className="px-3 py-2 font-medium">Description</th>
                    <th scope="col" className="px-3 py-2 font-medium">Category</th>
                    <th scope="col" className="px-3 py-2 font-medium">Type</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-divider">
                  {checked.previewRows.map((row) => (
                    <tr key={row.line}>
                      <td className="whitespace-nowrap px-3 py-2 text-foreground">{formatDate(row.occurredOn)}</td>
                      <td className="max-w-[16rem] truncate px-3 py-2 text-foreground">{row.description ?? "—"}</td>
                      <td className="px-3 py-2 text-foreground">{row.category}</td>
                      <td className="px-3 py-2">
                        <TypeBadge type={row.type} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        <Money paise={row.amountPaise} kind={row.type === "income" ? "income" : "expense"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          </div>

          {checked.matchedRows.length > 0 && (
            <div>
              <h3 className="text-subheading font-semibold text-foreground">Rows that match earlier imports</h3>
              <p className="mt-1 max-w-2xl text-label text-foreground-muted">
                These have the same date, type, amount and description as transactions you already imported. They are skipped unless you tick them, for
                example if you really did make the same purchase twice.
              </p>
              <div className="mt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => csv.chooseAll(chosen.size < checked.matchedRows.length)}>
                  {chosen.size < checked.matchedRows.length ? "Tick all" : "Untick all"}
                </Button>
              </div>
              <MatchedRowsTable
                rows={checked.matchedRows}
                chosen={chosen}
                onToggle={csv.toggleLine}
                caption="Rows that match earlier imports. Tick a row to import it anyway."
              />
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-divider pt-5 sm:flex-row sm:flex-wrap sm:items-center">
            <Button onClick={() => void csv.commit()} disabled={busy !== null || importCount === 0} aria-busy={busy === "importing"} size="lg" className="w-full sm:w-auto">
              {busy === "importing" ? "Importing…" : `Import ${importCount} ${importCount === 1 ? "transaction" : "transactions"}`}
            </Button>
            {importCount === 0 && (
              <p className="text-label text-foreground-muted">Every row matches an earlier import. Nothing will be imported unless you tick some above.</p>
            )}
            <p className="text-label text-foreground-muted">All rows are imported together, or none are.</p>
          </div>
        </div>
      )}
    </section>
  );
}

// Wide tables scroll inside their own frame, never the page, with the header kept in view.
function TableFrame({ children }: { children: React.ReactNode }) {
  return <div className="max-h-80 overflow-auto rounded-md border border-border">{children}</div>;
}

function TypeBadge({ type }: { type: string }) {
  return type === "income" ? <Badge tone="income">Income</Badge> : <Badge tone="expense">Expense</Badge>;
}

// Rows of the file that match earlier imports, with what identifies each one. With `onToggle`, each row has a
// checkbox (unticked = skipped, the default); without it the table is read-only.
function MatchedRowsTable({
  rows,
  caption,
  chosen,
  onToggle,
}: {
  rows: MatchedRow[];
  caption: string;
  chosen?: ReadonlySet<number>;
  onToggle?: (line: number) => void;
}) {
  return (
    <div className="mt-2">
      <TableFrame>
        <table className="w-full text-left text-label">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-surface-sunken">
            <tr className="text-foreground-muted">
              {onToggle && (
                <th scope="col" className="w-10 px-3 py-2 font-medium">
                  <span className="sr-only">Import anyway</span>
                </th>
              )}
              <th scope="col" className="px-3 py-2 font-medium">Line</th>
              <th scope="col" className="px-3 py-2 font-medium">Date</th>
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Description</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-divider">
            {rows.map((row) => (
              <tr key={row.line} className={chosen?.has(row.line) ? "bg-accent" : undefined}>
                {onToggle && (
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={chosen?.has(row.line) ?? false}
                      onChange={() => onToggle(row.line)}
                      aria-label={`Import line ${row.line} anyway`}
                      className="h-4 w-4 rounded-xs accent-[var(--primary)] focus-visible:focus-ring"
                    />
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-2 font-numeric text-foreground-muted">{row.line}</td>
                <td className="whitespace-nowrap px-3 py-2 text-foreground">{formatDate(row.occurredOn)}</td>
                <td className="px-3 py-2">
                  <TypeBadge type={row.type} />
                </td>
                <td className="max-w-[16rem] truncate px-3 py-2 text-foreground">{row.description ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Money paise={row.amountPaise} kind={row.type === "income" ? "income" : "expense"} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "income" | "expense" }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-divider pb-2 last:border-0 last:pb-0">
      <dt className="flex items-center gap-2 text-foreground-muted">
        {tone && <span aria-hidden="true" className={`h-2 w-2 rounded-xs ${tone === "income" ? "bg-income" : "bg-expense"}`} />}
        {label}
      </dt>
      <dd className="font-numeric text-foreground">{value}</dd>
    </div>
  );
}

function RowProblems({ checked }: { checked: Checked }) {
  return (
    <div role="alert" className="rounded-md border border-border bg-danger-soft p-4">
      <h3 className="text-subheading font-semibold text-foreground">
        {checked.errorCount === 0
          ? "There are no rows to import"
          : `${checked.errorCount} ${checked.errorCount === 1 ? "row has a problem" : "rows have problems"}. Nothing was imported.`}
      </h3>
      <p className="mt-1 text-label text-foreground-secondary">
        Fix the file, or change the choices above, then check it again. A file is imported only when every row is valid.
      </p>
      <ul className="mt-3 space-y-1.5 text-label">
        {checked.errors.map((e, i) => (
          <li key={i} className="text-foreground">
            <span className="font-numeric text-foreground-muted">Line {e.line}</span>
            {e.column ? ` · ${e.column}` : ""}: {e.message}
          </li>
        ))}
      </ul>
      {checked.errorCount > checked.errors.length && (
        <p className="mt-2 text-label text-foreground-muted">
          Showing the first {checked.errors.length} of {checked.errorCount}.
        </p>
      )}
    </div>
  );
}
