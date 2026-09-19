"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { CsvImportSummary, CsvPreview, MatchedRow } from "@/services/imports";
import type { AmountMode, ColumnRole, CsvMapping, SignedConvention } from "@/lib/csv-import";
import { DATE_FORMATS } from "@/lib/date-parse";
import type { DateFormatId } from "@/lib/date-parse";
import { formatDate, formatRupees } from "@/lib/format";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { FieldMessage, Input, Label, Select } from "../components/ui/Input";
import { messageOf, requestJson } from "./api";

// Import transactions from a CSV in two steps: check, then confirm.
//
// Nothing is guessed. Every interpretation that changes what gets imported
// (the amount layout, what a positive amount means, the date format, the
// default category) is a visible choice the person makes. The file's own
// headers may pre-select a column, and the choice is shown as a suggestion to
// check. Checking a file writes nothing. Importing sends the same file and
// the same mapping again, and the server re-validates everything.

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

export default function CsvImport() {
  const inputRef = useRef<HTMLInputElement>(null);
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

  const readFile = async (chosen: File) => {
    setBusy("reading");
    setError(null);
    try {
      const result = await send("preview", chosen);
      setFile(chosen);
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

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept=".csv,text/csv"
      className="sr-only"
      id="vault-csv"
      aria-label="Choose a CSV file of transactions"
      tabIndex={-1}
      onChange={(e) => {
        const chosen = e.target.files?.[0];
        e.target.value = "";
        if (chosen) void readFile(chosen);
      }}
    />
  );

  if (step.name === "choose") {
    return (
      <div>
        {fileInput}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy === "reading"}>
            {busy === "reading" ? "Reading…" : "Choose a CSV file"}
          </Button>
          <p className="text-[13px] text-muted-foreground">Up to 2 MB and 5,000 rows. The file is checked first; nothing is imported until you confirm.</p>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (step.name === "done") {
    const s = step.summary;
    return (
      <div role="status">
        <p className="text-[15px] font-semibold tracking-tight text-foreground">
          Imported {s.insertedCount} {s.insertedCount === 1 ? "transaction" : "transactions"}
        </p>
        <dl className="mt-3 space-y-1.5 text-sm">
          <Row label="Rows in the file" value={String(s.rowCount)} />
          <Row label="Already imported earlier, skipped" value={String(s.skippedDuplicateCount)} />
          {s.forcedCount > 0 && <Row label="Imported although they matched earlier rows" value={String(s.forcedCount)} />}
          <Row label="Income added" value={`${s.incomeCount} · ${formatRupees(s.incomeTotalPaise)}`} />
          <Row label="Expenses added" value={`${s.expenseCount} · ${formatRupees(s.expenseTotalPaise)}`} />
          {s.defaultCategoryCount > 0 && <Row label="Given the default category" value={String(s.defaultCategoryCount)} />}
        </dl>
        {s.skippedRows.length > 0 && (
          <div className="mt-4">
            <p className="text-[13px] text-muted-foreground">These rows matched transactions you had already imported, so they were not imported again:</p>
            <MatchedRowsTable rows={s.skippedRows} caption="Rows skipped because they match earlier imports" />
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Link href="/income" className="text-sm text-foreground underline underline-offset-2">
            View income
          </Link>
          <Link href="/expenses" className="text-sm text-foreground underline underline-offset-2">
            View expenses
          </Link>
          <Button variant="secondary" size="sm" onClick={reset}>
            Import another file
          </Button>
        </div>
      </div>
    );
  }

  // step.name === "map"
  if (!preview || !file) return null;
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

  return (
    <div className="space-y-8">
      {fileInput}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{preview.filename}</p>
          <p className="text-[13px] text-muted-foreground">
            {preview.totalRows} {preview.totalRows === 1 ? "row" : "rows"} · {preview.headers.length} columns
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={reset}>
          Choose a different file
        </Button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <caption className="sr-only">First rows of the file, as they appear in it</caption>
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {headers.map((h, i) => (
                <th key={i} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">
                  {h === "" ? `Column ${i + 1}` : h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.sampleRows.slice(0, 5).map((row, r) => (
              <tr key={r} className="border-b border-border last:border-0">
                {headers.map((_, i) => (
                  <td key={i} className="max-w-[16rem] truncate whitespace-nowrap px-2 py-1.5 text-foreground">
                    {row[i] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <fieldset className="space-y-5">
        <legend className="mb-1 text-[15px] font-semibold tracking-tight text-foreground">How to read this file</legend>
        <p className="max-w-2xl text-[13px] text-muted-foreground">
          Some choices below were suggested from the column names. Check every one against the rows above; SmartCA doesn’t guess what’s left open.
        </p>

        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <Label htmlFor="csv-delimiter">Columns are separated by</Label>
            <Select id="csv-delimiter" value={form.delimiter} disabled={busy !== null} onChange={(e) => void changeDelimiter(e.target.value as Delimiter)}>
              {(Object.keys(DELIMITER_LABEL) as Delimiter[]).map((d) => (
                <option key={d} value={d}>
                  {DELIMITER_LABEL[d]}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="csv-date-format">Dates are written as</Label>
            <Select id="csv-date-format" value={form.dateFormat} onChange={(e) => change({ dateFormat: e.target.value as DateFormatId | "" })}>
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
            <Select id="csv-amount-mode" value={form.amountMode} onChange={(e) => change({ amountMode: e.target.value as AmountMode | "" })}>
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
                onChange={(e) => change({ signedConvention: e.target.value as SignedConvention | "" })}
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
              onChange={(e) => change({ defaultCategory: e.target.value })}
            />
            <FieldMessage>Used for any row whose category is empty or not mapped.</FieldMessage>
          </div>
        </div>

        {roles.length > 0 && (
          <div className="grid gap-5 sm:grid-cols-2">
            {roles.map((role) => (
              <div key={role}>
                <Label htmlFor={`csv-col-${role}`}>
                  {ROLE_LABEL[role]}
                  {OPTIONAL.includes(role) ? " (optional)" : ""}
                </Label>
                <Select id={`csv-col-${role}`} value={form.columns[role] ?? ""} onChange={(e) => setColumn(role, e.target.value)}>
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
        <Button onClick={check} disabled={busy !== null}>
          {busy === "checking" ? "Checking…" : checked ? "Check again" : "Check the file"}
        </Button>
      </div>

      {problems.length > 0 && (
        <div role="alert" className="text-sm text-destructive">
          <p className="font-medium">Finish these choices first:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {checked && !checked.valid && <RowProblems checked={checked} />}
      {checked && checked.valid && checked.summary && (
        <div className="space-y-5 border-t border-border pt-5">
          <div>
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Ready to import</h3>
            <dl className="mt-3 space-y-1.5 text-sm">
              <Row label="Rows in the file" value={String(checked.summary.rowCount)} />
              <Row label="Income" value={`${checked.summary.incomeCount} · ${formatRupees(checked.summary.incomeTotalPaise)}`} />
              <Row label="Expenses" value={`${checked.summary.expenseCount} · ${formatRupees(checked.summary.expenseTotalPaise)}`} />
              {checked.summary.defaultCategoryCount > 0 && (
                <Row label={`Will be categorised “${form.defaultCategory.trim()}”`} value={String(checked.summary.defaultCategoryCount)} />
              )}
              {checked.alreadyImportedCount > 0 && (
                <Row label="Match earlier imports, will be skipped unless ticked" value={String(checked.alreadyImportedCount - chosen.size)} />
              )}
            </dl>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <caption className="mb-1 text-left text-muted-foreground">
                {checked.previewRows.length < checked.summary.rowCount
                  ? `First ${checked.previewRows.length} of ${checked.summary.rowCount} rows, as they will be imported`
                  : "All rows, as they will be imported"}
              </caption>
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th scope="col" className="px-2 py-1.5 font-medium">Date</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Description</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Category</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">Type</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {checked.previewRows.map((row) => (
                  <tr key={row.line} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-2 py-1.5 text-foreground">{formatDate(row.occurredOn)}</td>
                    <td className="max-w-[16rem] truncate px-2 py-1.5 text-foreground">{row.description ?? "—"}</td>
                    <td className="px-2 py-1.5 text-foreground">{row.category}</td>
                    <td className="px-2 py-1.5">
                      <Badge tone={row.type === "income" ? "success" : "neutral"}>{row.type === "income" ? "Income" : "Expense"}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right font-numeric text-foreground">{formatRupees(row.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {checked.matchedRows.length > 0 && (
            <div>
              <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Rows that match earlier imports</h3>
              <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
                These have the same date, type, amount and description as transactions you already imported. They are skipped unless you tick them, for
                example if you really did make the same purchase twice.
              </p>
              <div className="mt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => chooseAll(chosen.size < checked.matchedRows.length)}>
                  {chosen.size < checked.matchedRows.length ? "Tick all" : "Untick all"}
                </Button>
              </div>
              <MatchedRowsTable
                rows={checked.matchedRows}
                chosen={chosen}
                onToggle={toggleLine}
                caption="Rows that match earlier imports. Tick a row to import it anyway."
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={commit} disabled={busy !== null || checked.newRowCount + chosen.size === 0}>
              {busy === "importing"
                ? "Importing…"
                : `Import ${checked.newRowCount + chosen.size} ${checked.newRowCount + chosen.size === 1 ? "transaction" : "transactions"}`}
            </Button>
            {checked.newRowCount + chosen.size === 0 && (
              <p className="text-[13px] text-muted-foreground">Every row matches an earlier import. Nothing will be imported unless you tick some above.</p>
            )}
            <p className="text-[13px] text-muted-foreground">All rows are imported together, or none are.</p>
          </div>
        </div>
      )}
    </div>
  );
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
    <div className="mt-2 max-h-64 overflow-auto">
      <table className="w-full text-left text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            {onToggle && (
              <th scope="col" className="w-8 px-2 py-1.5 font-medium">
                <span className="sr-only">Import anyway</span>
              </th>
            )}
            <th scope="col" className="px-2 py-1.5 font-medium">Line</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Date</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Type</th>
            <th scope="col" className="px-2 py-1.5 font-medium">Description</th>
            <th scope="col" className="px-2 py-1.5 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.line} className="border-b border-border last:border-0">
              {onToggle && (
                <td className="px-2 py-1.5">
                  <input
                    type="checkbox"
                    checked={chosen?.has(row.line) ?? false}
                    onChange={() => onToggle(row.line)}
                    aria-label={`Import line ${row.line} anyway`}
                    className="h-4 w-4 rounded-[4px] accent-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  />
                </td>
              )}
              <td className="whitespace-nowrap px-2 py-1.5 font-numeric text-muted-foreground">{row.line}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-foreground">{formatDate(row.occurredOn)}</td>
              <td className="px-2 py-1.5">
                <Badge tone={row.type === "income" ? "success" : "neutral"}>{row.type === "income" ? "Income" : "Expense"}</Badge>
              </td>
              <td className="max-w-[16rem] truncate px-2 py-1.5 text-foreground">{row.description ?? "—"}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-numeric text-foreground">{formatRupees(row.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-numeric text-foreground">{value}</dd>
    </div>
  );
}

function RowProblems({ checked }: { checked: Checked }) {
  return (
    <div role="alert" className="border-t border-border pt-5">
      <h3 className="text-[15px] font-semibold tracking-tight text-destructive">
        {checked.errorCount === 0
          ? "There are no rows to import"
          : `${checked.errorCount} ${checked.errorCount === 1 ? "row has a problem" : "rows have problems"}. Nothing was imported.`}
      </h3>
      <p className="mt-1 text-[13px] text-muted-foreground">
        Fix the file, or change the choices above, then check it again. A file is imported only when every row is valid.
      </p>
      <ul className="mt-3 space-y-1.5 text-[13px]">
        {checked.errors.map((e, i) => (
          <li key={i} className="text-foreground">
            <span className="font-numeric text-muted-foreground">Line {e.line}</span>
            {e.column ? ` · ${e.column}` : ""}: {e.message}
          </li>
        ))}
      </ul>
      {checked.errorCount > checked.errors.length && (
        <p className="mt-2 text-[13px] text-muted-foreground">
          Showing the first {checked.errors.length} of {checked.errorCount}.
        </p>
      )}
    </div>
  );
}
