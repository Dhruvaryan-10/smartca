import { formatDate } from "@/lib/format";
import type { SummaryTransaction } from "@/lib/summary";
import { Money } from "../../components/ui/Money";
import { IconArrowDownLeft, IconArrowUpRight } from "../../components/ui/Icons";

// The latest entries, newest first. Direction is said three ways: the
// arrow (in or out), the sign on the amount, and its colour.
export function RecentActivity({ items }: { items: SummaryTransaction[] }) {
  return (
    <ul className="divide-y divide-divider">
      {items.map((t) => {
        const isIncome = t.type === "income";
        const description = t.description?.trim() ?? "";
        // A description that just repeats the category adds nothing — show the date alone.
        const hasDistinctDescription = description !== "" && description.toLowerCase() !== t.category.toLowerCase();
        const title = hasDistinctDescription ? description : t.category;
        const detail = hasDistinctDescription ? `${t.category} · ${formatDate(t.occurredOn)}` : formatDate(t.occurredOn);
        const Icon = isIncome ? IconArrowDownLeft : IconArrowUpRight;
        return (
          <li key={t.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-pill ${
                isIncome ? "bg-income-soft text-income" : "bg-expense-soft text-expense"
              }`}
            >
              <Icon width={16} height={16} />
              <span className="sr-only">{isIncome ? "Income" : "Expense"}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-foreground">{title}</p>
              <p className="mt-0.5 truncate text-label text-foreground-muted">{detail}</p>
            </div>
            <Money paise={t.amountPaise} kind={isIncome ? "income" : "expense"} signed className="shrink-0 text-body font-medium" />
          </li>
        );
      })}
    </ul>
  );
}
