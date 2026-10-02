"use client";

import { useId, useState } from "react";
import { formatPaiseForInput } from "@/lib/money-input";
import {
  localDateKey,
  parseTransactionForm,
  type LedgerTransaction,
  type LedgerType,
  type TransactionFormErrors,
  type TransactionFormValues,
} from "@/lib/ledger-view";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { FieldMessage, Input, Label } from "../ui/Input";
import { MoneyField } from "../ui/MoneyField";
import { requestJson, messageOf } from "../request";

const NOUN: Record<LedgerType, string> = { income: "income", expense: "expense" };

// Add or edit one ledger entry. It sends exactly the fields the ledger has
// always sent (type, amount in paise, category, description, date) to the
// existing transactions API: POST to add, PATCH to edit. The server
// validates everything again.
export function TransactionDialog({
  open,
  type,
  editing,
  suggestions,
  onClose,
  onSaved,
  onDelete,
}: {
  open: boolean;
  type: LedgerType;
  /** The entry being edited, or null to add a new one. */
  editing: LedgerTransaction | null;
  suggestions: string[];
  onClose: () => void;
  onSaved: (id: string) => void;
  /** Offered while editing: hands the entry back to the page's delete confirmation. */
  onDelete: (row: LedgerTransaction) => void;
}) {
  const formId = useId();
  const title = editing ? `Edit ${NOUN[type]}` : `Add ${NOUN[type]}`;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={type === "income" ? "Money you received." : "Money you spent."}
      footer={
        <>
          {editing && (
            <Button
              type="button"
              variant="ghost"
              className="text-danger hover:bg-danger-soft hover:text-danger sm:mr-auto"
              onClick={() => onDelete(editing)}
            >
              Delete entry
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            {editing ? "Save changes" : `Add ${NOUN[type]}`}
          </Button>
        </>
      }
    >
      <TransactionForm formId={formId} type={type} editing={editing} suggestions={suggestions} onSaved={onSaved} />
    </Dialog>
  );
}

function initialValues(editing: LedgerTransaction | null): TransactionFormValues {
  if (!editing) return { amount: "", occurredOn: localDateKey(), category: "", description: "" };
  return {
    amount: formatPaiseForInput(editing.amountPaise),
    occurredOn: editing.occurredOn.slice(0, 10),
    category: editing.category,
    description: editing.description ?? "",
  };
}

function TransactionForm({
  formId,
  type,
  editing,
  suggestions,
  onSaved,
}: {
  formId: string;
  type: LedgerType;
  editing: LedgerTransaction | null;
  suggestions: string[];
  onSaved: (id: string) => void;
}) {
  const [values, setValues] = useState<TransactionFormValues>(() => initialValues(editing));
  const [errors, setErrors] = useState<TransactionFormErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const listId = `${formId}-categories`;

  const set = (patch: Partial<TransactionFormValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    // Once someone has tried to save, problems clear as they are fixed.
    if (attempted) {
      const parsed = parseTransactionForm(next, type);
      setErrors(parsed.ok ? {} : parsed.errors);
    }
  };

  const submit = async () => {
    setAttempted(true);
    const parsed = parseTransactionForm(values, type);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      const first = (["amount", "occurredOn", "category"] as const).find((key) => parsed.errors[key]);
      if (first) document.getElementById(`${formId}-${first}`)?.focus();
      return;
    }
    setSaving(true);
    setServerError(null);
    try {
      const row = await requestJson<LedgerTransaction>(editing ? `/api/transactions/${editing.id}` : "/api/transactions", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.body),
      });
      onSaved(row?.id ?? editing?.id ?? "");
    } catch (err) {
      setServerError(messageOf(err));
      setSaving(false);
    }
  };

  const quickPicks = suggestions.slice(0, 6);

  return (
    <form
      id={formId}
      noValidate
      aria-busy={saving}
      onSubmit={(e) => {
        e.preventDefault();
        if (!saving) void submit();
      }}
      className="space-y-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <MoneyField
          id={`${formId}-amount`}
          label="Amount"
          value={values.amount}
          onChange={(amount) => set({ amount })}
          error={errors.amount}
          autoFocus
        />
        <div>
          <Label htmlFor={`${formId}-occurredOn`}>Date</Label>
          <Input
            id={`${formId}-occurredOn`}
            type="date"
            value={values.occurredOn}
            onChange={(e) => set({ occurredOn: e.target.value })}
            aria-invalid={errors.occurredOn ? true : undefined}
            aria-describedby={errors.occurredOn ? `${formId}-occurredOn-message` : undefined}
            className="font-numeric"
          />
          {errors.occurredOn && (
            <FieldMessage id={`${formId}-occurredOn-message`} tone="error">
              {errors.occurredOn}
            </FieldMessage>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor={`${formId}-category`}>Category</Label>
        <Input
          id={`${formId}-category`}
          value={values.category}
          onChange={(e) => set({ category: e.target.value })}
          list={listId}
          autoComplete="off"
          maxLength={100}
          placeholder={type === "income" ? "Salary" : "Groceries"}
          aria-invalid={errors.category ? true : undefined}
          aria-describedby={`${formId}-category-message`}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        {errors.category ? (
          <FieldMessage id={`${formId}-category-message`} tone="error">
            {errors.category}
          </FieldMessage>
        ) : (
          <FieldMessage id={`${formId}-category-message`}>Type your own, or pick one you’ve used.</FieldMessage>
        )}
        {quickPicks.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Categories you can pick">
            {quickPicks.map((s) => {
              const chosen = values.category.trim() === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={chosen}
                  onClick={() => set({ category: s })}
                  className={`h-8 rounded-xs px-2.5 text-label transition-colors duration-(--duration-fast) ease-standard focus-visible:focus-ring ${
                    chosen
                      ? type === "income"
                        ? "bg-income-soft font-medium text-income"
                        : "bg-expense-soft font-medium text-expense"
                      : "bg-surface-sunken text-foreground-secondary hover:text-foreground"
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <Label htmlFor={`${formId}-description`}>
          Description <span className="font-normal text-foreground-muted">(optional)</span>
        </Label>
        <Input
          id={`${formId}-description`}
          value={values.description}
          onChange={(e) => set({ description: e.target.value })}
          autoComplete="off"
          maxLength={200}
          placeholder={type === "income" ? "September salary" : "Weekly groceries"}
        />
      </div>

      {serverError && (
        <p role="alert" className="rounded-md bg-danger-soft px-3.5 py-2.5 text-label text-foreground">
          {serverError}
        </p>
      )}
      {saving && (
        <p role="status" className="text-label text-foreground-muted">
          Saving…
        </p>
      )}
    </form>
  );
}
