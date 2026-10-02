import { formatMonthLabel } from "@/lib/format";
import type { LedgerTransaction, LedgerType, MonthGroup } from "@/lib/ledger-view";
import { Money } from "../ui/Money";
import { IconTrash } from "../ui/Icons";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function weekdayOf(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  // Built from the parts (not parsed), so the day never shifts with the time zone.
  return WEEKDAY[new Date(y, m - 1, d).getDay()];
}

function monthHeading(key: string): string {
  const month = Number(key.slice(5, 7));
  return MONTH_LONG[month - 1] ? `${MONTH_LONG[month - 1]} ${key.slice(0, 4)}` : formatMonthLabel(key, true);
}

function spokenDate(isoDate: string): string {
  const month = Number(isoDate.slice(5, 7));
  return `${Number(isoDate.slice(8, 10))} ${MONTH_LONG[month - 1] ?? ""} ${isoDate.slice(0, 4)}`;
}

// The entries, grouped by month with each month's total, newest first.
// Each row is one button that opens the entry to edit (tap, click or
// keyboard): the day in its own column, the description and category in
// the middle, the amount on the right edge (the money column). From 640px
// a delete button follows the row; on phones delete lives in the edit
// sheet, so rows stay one line tall.
export function LedgerList({
  type,
  groups,
  highlight,
  onEdit,
  onDelete,
}: {
  type: LedgerType;
  groups: MonthGroup[];
  /** The entry just added or changed: it gets the recompute wash once. */
  highlight: { id: string; nonce: number } | null;
  onEdit: (row: LedgerTransaction) => void;
  onDelete: (row: LedgerTransaction) => void;
}) {
  return (
    <div className="space-y-8">
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`month-${group.key}`}>
          <div className="sticky top-(--header-height) z-[5] -mx-1 flex items-baseline justify-between gap-4 border-b border-border bg-background px-1 py-2.5">
            <h3 id={`month-${group.key}`} className="text-label font-semibold text-foreground">
              {monthHeading(group.key)}
              <span className="ml-2 font-normal text-foreground-muted">
                {group.rows.length} {group.rows.length === 1 ? "entry" : "entries"}
              </span>
            </h3>
            <Money paise={group.totalPaise} kind={type} className="text-label font-semibold" />
          </div>
          <ul className="divide-y divide-divider">
            {group.rows.map((row) => {
              const description = row.description?.trim() ?? "";
              const title = description || row.category;
              const showCategory = description !== "" && description.toLowerCase() !== row.category.toLowerCase();
              const washed = highlight?.id === row.id;
              return (
                <li
                  key={washed ? `${row.id}-${highlight.nonce}` : row.id}
                  className={`flex items-center gap-1 rounded-md py-1 ${washed ? "recompute-wash" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => onEdit(row)}
                    aria-label={`Edit ${title}, ${spokenDate(row.occurredOn)}`}
                    className="-mx-2 grid min-h-14 min-w-0 flex-1 grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-2 text-left transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken focus-visible:focus-ring sm:grid-cols-[3.25rem_minmax(0,1fr)_auto] sm:gap-x-4"
                  >
                    <time dateTime={row.occurredOn.slice(0, 10)} className="flex flex-col items-center leading-none">
                      <span className="font-numeric text-subheading font-semibold text-foreground">{Number(row.occurredOn.slice(8, 10))}</span>
                      <span className="mt-1 text-micro text-foreground-muted">{weekdayOf(row.occurredOn)}</span>
                    </time>
                    <span className="min-w-0">
                      <span className="block truncate text-body text-foreground">{title}</span>
                      <span className="mt-0.5 block truncate text-label text-foreground-muted">
                        {showCategory ? row.category : type === "income" ? "Income" : "Expense"}
                      </span>
                    </span>
                    <Money paise={row.amountPaise} kind={type} className="text-body font-medium" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(row)}
                    aria-label={`Delete ${title}`}
                    title="Delete"
                    className="ml-2 hidden h-9 w-9 shrink-0 items-center justify-center rounded-control text-foreground-muted transition-colors duration-(--duration-fast) ease-standard hover:bg-danger-soft hover:text-danger focus-visible:focus-ring sm:inline-flex"
                  >
                    <IconTrash width={16} height={16} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
