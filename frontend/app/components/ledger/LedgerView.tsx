"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { formatDate, formatMonthLabel } from "@/lib/format";
import {
  NO_FILTER,
  categorySuggestions,
  filterLedger,
  groupByMonth,
  isFiltered,
  ledgerStats,
  localDateKey,
  monthsPresent,
  type LedgerFilter,
  type LedgerTransaction,
  type LedgerType,
} from "@/lib/ledger-view";
import LedgerTabs from "../LedgerTabs";
import { Button, buttonClasses } from "../ui/Button";
import { ConfirmDialog } from "../ui/Dialog";
import { IconArrowDownLeft, IconArrowUpRight, IconPlus, IconSearch } from "../ui/Icons";
import { Input, Select } from "../ui/Input";
import { Money } from "../ui/Money";
import { PageHeader } from "../ui/PageHeader";
import { ErrorState, Skeleton } from "../ui/States";
import { messageOf, requestJson } from "../request";
import { LedgerList } from "./LedgerList";
import { TransactionDialog } from "./TransactionDialog";

const PAGE_SIZE = 60;

const COPY: Record<
  LedgerType,
  { tab: string; add: string; noun: string; plural: string; emptyTitle: string; emptyBody: string; defaults: string[] }
> = {
  income: {
    tab: "Income",
    add: "Add income",
    noun: "income",
    plural: "income entries",
    emptyTitle: "No income recorded yet",
    emptyBody: "Record your salary, freelance work or any money you receive. Your Summary and tax suggestions are built from these entries.",
    defaults: ["Job", "Salary", "Freelance", "Bonus", "Interest"],
  },
  expense: {
    tab: "Expenses",
    add: "Add expense",
    noun: "expense",
    plural: "expenses",
    emptyTitle: "No expenses recorded yet",
    emptyBody: "Record rent, groceries, bills and anything else you spend. Your Summary shows where the money goes.",
    defaults: ["Rent", "Food", "Transport", "Shopping", "Groceries", "Utilities"],
  },
};

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; rows: LedgerTransaction[] };

// The Ledger: one view for income and for expenses (the /income and
// /expenses routes each render it for their type). It loads the person's
// transactions from the existing API and filters, groups and totals them
// on the client (lib/ledger-view.ts). Adding, editing and deleting go
// through the existing transactions endpoints.
export function LedgerView({ type }: { type: LedgerType }) {
  const copy = COPY[type];
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [filter, setFilter] = useState<LedgerFilter>(NO_FILTER);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [dialog, setDialog] = useState<{ open: boolean; editing: LedgerTransaction | null }>({ open: false, editing: null });
  const [deleting, setDeleting] = useState<{ row: LedgerTransaction; busy: boolean; error: string | null } | null>(null);
  const [highlight, setHighlight] = useState<{ id: string; nonce: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    const data = await requestJson<unknown>("/api/transactions");
    if (!Array.isArray(data)) throw new Error("Unexpected response shape");
    return data as LedgerTransaction[];
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchRows()
      .then((rows) => !cancelled && setLoad({ status: "ready", rows }))
      .catch((err: unknown) => !cancelled && setLoad({ status: "error", message: messageOf(err) }));
    return () => {
      cancelled = true;
    };
  }, [fetchRows]);

  const reload = async () => {
    try {
      setLoad({ status: "ready", rows: await fetchRows() });
    } catch (err) {
      setNotice(`Saved, but the list couldn’t refresh: ${messageOf(err)}`);
    }
  };

  const rows = useMemo(() => (load.status === "ready" ? load.rows : []), [load]);
  const today = localDateKey();
  const stats = useMemo(() => ledgerStats(rows, type, today), [rows, type, today]);
  const visible = useMemo(() => filterLedger(rows, type, filter), [rows, type, filter]);
  const groups = useMemo(() => groupByMonth(visible.slice(0, limit)), [visible, limit]);
  const suggestions = useMemo(() => categorySuggestions(rows, type, copy.defaults), [rows, type, copy.defaults]);
  const categories = useMemo(() => categorySuggestions(rows, type, []), [rows, type]);
  const months = useMemo(() => monthsPresent(rows, type), [rows, type]);

  const openAdd = () => setDialog({ open: true, editing: null });

  const onSaved = async (id: string) => {
    const wasEditing = dialog.editing !== null;
    setDialog({ open: false, editing: null });
    await reload();
    setHighlight({ id, nonce: Date.now() });
    setNotice(wasEditing ? "Changes saved." : `${type === "income" ? "Income" : "Expense"} added.`);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: null });
    try {
      await requestJson<void>(`/api/transactions/${deleting.row.id}`, { method: "DELETE" });
      setDeleting(null);
      await reload();
      setNotice("Entry deleted.");
    } catch (err) {
      setDeleting({ ...deleting, busy: false, error: messageOf(err) });
    }
  };

  const ofType = stats.count;

  return (
    <>
      <PageHeader
        title="Ledger"
        description="Everything you’ve earned and spent, entry by entry."
        actions={
          <Button onClick={openAdd} disabled={load.status !== "ready"}>
            <IconPlus width={16} height={16} />
            {copy.add}
          </Button>
        }
      />
      <LedgerTabs />

      <p className="sr-only" role="status" aria-live="polite">
        {notice ?? ""}
      </p>

      {load.status === "loading" && <LedgerSkeleton />}

      {load.status === "error" && (
        <ErrorState
          title="Couldn’t load your ledger"
          message={load.message}
          onRetry={() => {
            setLoad({ status: "loading" });
            fetchRows()
              .then((rows) => setLoad({ status: "ready", rows }))
              .catch((err: unknown) => setLoad({ status: "error", message: messageOf(err) }));
          }}
        />
      )}

      {load.status === "ready" && ofType === 0 && <EmptyLedger type={type} onAdd={openAdd} />}

      {load.status === "ready" && ofType > 0 && (
        <div className="space-y-8">
          <dl className="grid grid-cols-2 border-y border-border sm:grid-cols-3">
            <Stat label={`Total ${copy.noun}`} detail={`${ofType} ${ofType === 1 ? "entry" : "entries"}, all time`}>
              <Money paise={stats.totalPaise} kind={type} />
            </Stat>
            <Stat
              label={`This month · ${formatMonthLabel(stats.monthKey, true)}`}
              detail={stats.monthCount === 0 ? "Nothing yet this month" : `${stats.monthCount} ${stats.monthCount === 1 ? "entry" : "entries"}`}
              className="border-l border-divider pl-5 sm:pl-8"
            >
              <Money paise={stats.monthPaise} kind={type} />
            </Stat>
            {stats.topCategory && (
              <Stat
                label={type === "income" ? "Largest source" : "Largest category"}
                detail={stats.topCategory.category}
                className="col-span-2 border-t border-divider sm:col-span-1 sm:border-l sm:border-t-0 sm:pl-8"
              >
                <Money paise={stats.topCategory.totalPaise} />
              </Stat>
            )}
          </dl>

          <FilterBar
            filter={filter}
            onChange={(next) => {
              setFilter(next);
              setLimit(PAGE_SIZE);
            }}
            categories={categories}
            months={months}
            plural={copy.plural}
          />

          <div className="flex items-baseline justify-between gap-4">
            <p className="text-label text-foreground-muted">
              {isFiltered(filter)
                ? `${visible.length} of ${ofType} ${copy.plural} match`
                : `${ofType} ${ofType === 1 ? copy.noun + " entry" : copy.plural}`}
            </p>
            {isFiltered(filter) && (
              <button
                type="button"
                onClick={() => setFilter(NO_FILTER)}
                className="rounded-xs text-label font-medium text-primary hover:underline focus-visible:focus-ring"
              >
                Clear filters
              </button>
            )}
          </div>

          {visible.length === 0 ? (
            <div className="rounded-panel border border-dashed border-border px-5 py-10 text-center">
              <p className="text-body font-medium text-foreground">No {copy.plural} match these filters</p>
              <p className="mt-1 text-label text-foreground-muted">Try another word, category or month.</p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => setFilter(NO_FILTER)}>
                Clear filters
              </Button>
            </div>
          ) : (
            <LedgerList
              type={type}
              groups={groups}
              highlight={highlight}
              onEdit={(row) => setDialog({ open: true, editing: row })}
              onDelete={(row) => setDeleting({ row, busy: false, error: null })}
            />
          )}

          {visible.length > limit && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                Show {Math.min(PAGE_SIZE, visible.length - limit)} more
              </Button>
            </div>
          )}
        </div>
      )}

      <TransactionDialog
        open={dialog.open}
        type={type}
        editing={dialog.editing}
        suggestions={suggestions}
        onClose={() => setDialog({ open: false, editing: null })}
        onSaved={(id) => void onSaved(id)}
        onDelete={(row) => {
          setDialog({ open: false, editing: null });
          setDeleting({ row, busy: false, error: null });
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Delete this entry?"
        confirmLabel="Delete entry"
        busyLabel="Deleting…"
        busy={deleting?.busy ?? false}
        error={deleting?.error}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleting(null)}
      >
        {deleting && (
          <>
            <p className="flex flex-wrap items-baseline gap-x-2 text-foreground">
              <Money paise={deleting.row.amountPaise} kind={type} className="font-semibold" />
              <span>
                {deleting.row.description?.trim() || deleting.row.category} · {formatDate(deleting.row.occurredOn)}
              </span>
            </p>
            <p>It’s removed from your ledger and from your Summary. This can’t be undone.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

function Stat({ label, detail, className = "", children }: { label: string; detail: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 py-4 pr-5 sm:pr-8 ${className}`}>
      <dt className="truncate text-label text-foreground-muted">{label}</dt>
      <dd className="mt-1 text-figure font-semibold">{children}</dd>
      <dd className="mt-0.5 truncate text-label text-foreground-muted">{detail}</dd>
    </div>
  );
}

function FilterBar({
  filter,
  onChange,
  categories,
  months,
  plural,
}: {
  filter: LedgerFilter;
  onChange: (next: LedgerFilter) => void;
  categories: string[];
  months: string[];
  plural: string;
}) {
  return (
    <div role="search" aria-label={`Filter ${plural}`} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_11rem]">
      <div className="relative">
        <IconSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground-muted" />
        <Input
          type="search"
          aria-label={`Search ${plural}`}
          placeholder="Search description or category"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
          className="pl-9"
        />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:contents">
        <Select aria-label="Category" value={filter.category} onChange={(e) => onChange({ ...filter, category: e.target.value })}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <Select aria-label="Month" value={filter.month} onChange={(e) => onChange({ ...filter, month: e.target.value })}>
          <option value="">All months</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {formatMonthLabel(m, true)}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function EmptyLedger({ type, onAdd }: { type: LedgerType; onAdd: () => void }) {
  const copy = COPY[type];
  const Icon = type === "income" ? IconArrowDownLeft : IconArrowUpRight;
  return (
    <section className="rounded-panel border border-border bg-surface px-5 py-10 sm:px-10 sm:py-14">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <span className={`flex h-12 w-12 items-center justify-center rounded-pill ${type === "income" ? "bg-income-soft text-income" : "bg-expense-soft text-expense"}`}>
          <Icon width={22} height={22} />
        </span>
        <h2 className="mt-5 text-heading font-semibold text-foreground">{copy.emptyTitle}</h2>
        <p className="mt-2 text-body text-foreground-secondary">{copy.emptyBody}</p>
        <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row">
          <Button onClick={onAdd}>
            <IconPlus width={16} height={16} />
            {copy.add}
          </Button>
          <Link href="/vault" className={buttonClasses("outline", "md")}>
            Import a bank statement
          </Link>
        </div>
      </div>
    </section>
  );
}

function LedgerSkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-8">
      <span className="sr-only">Loading your ledger…</span>
      <div className="grid grid-cols-2 gap-8 border-y border-border py-4 sm:grid-cols-3">
        <Skeleton className="h-14 w-40 max-w-full" />
        <Skeleton className="h-14 w-40 max-w-full" />
        <Skeleton className="hidden h-14 w-32 sm:block" />
      </div>
      <Skeleton className="h-10 w-full" />
      <div className="space-y-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-4 py-2">
            <Skeleton className="h-9 w-9 rounded-md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48 max-w-full" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
