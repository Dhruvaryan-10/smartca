import { Button } from "../ui/Button";
import type { ConsentDisclosureView, DisclosedFieldView } from "./assistant-client";

const CLASS_LABEL: Record<string, string> = {
  user_free_text: "Text you wrote",
  user_financial_data: "Your financial data",
  tax_corpus_text: "Tax law text",
  system_value: "System values",
};

const TOOL_LABEL: Record<string, string> = {
  search_tax_law: "Searching tax law",
  query_transactions: "Looking up your transactions",
  get_financial_summary: "Summarising your finances",
  calculate_tax: "Calculating your tax",
  compare_tax_regimes: "Comparing tax regimes",
  simulate_tax: "Simulating tax scenarios",
};

const label = (map: Record<string, string>, key: string) => map[key] ?? key.replace(/_/g, " ");

// The disclosure, exactly as the server derived it, before the person
// decides (generative AI: ask permission before using personal data, and
// disclose how it is used). The field lists sit behind disclosures so
// the decision itself stays short; nothing here is summarised away.
export function ConsentReview({
  disclosure,
  message,
  busy,
  onGrant,
  onDecline,
}: {
  disclosure: ConsentDisclosureView;
  message: string | null;
  busy: boolean;
  onGrant: () => void;
  onDecline: () => void;
}) {
  const { recipient, validForDays, egress } = disclosure;
  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-heading font-semibold text-foreground">Before you ask</h3>
        <p className="mt-1.5 text-body text-foreground-secondary">
          Ask SmartCA writes its answers with an external language model, <span className="font-medium text-foreground">{recipient}</span>.
          To answer, it shares parts of your question and of SmartCA&apos;s results with that model. You can withdraw this permission at any time.
        </p>
      </div>

      {message && <p className="rounded-md bg-warning-soft px-3.5 py-3 text-label text-foreground">{message}</p>}

      <div className="space-y-3">
        <p className="text-label font-medium text-foreground">Always shared</p>
        <p className="text-label text-foreground-secondary">
          Your questions, earlier answers in this conversation, and the assistant&apos;s own requests to SmartCA&apos;s tools.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-label font-medium text-foreground">Shared from SmartCA&apos;s tools</p>
        <ul className="divide-y divide-divider rounded-md border border-border">
          {egress.tools.map(({ tool, sent, withheld }) => (
            <li key={tool}>
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 text-label text-foreground focus-visible:focus-ring [&::-webkit-details-marker]:hidden">
                  <span>{label(TOOL_LABEL, tool)}</span>
                  <span className="shrink-0 text-micro text-foreground-muted">
                    {sent.length} shared · {withheld.length} never shared
                  </span>
                </summary>
                <div className="space-y-3 px-3 pb-3">
                  <FieldList title="Shared" fields={sent} />
                  <FieldList title="Never shared" fields={withheld} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onDecline} disabled={busy}>
          Not now
        </Button>
        <Button type="button" onClick={onGrant} disabled={busy} aria-busy={busy}>
          {busy ? "Saving…" : `Allow for ${validForDays} days`}
        </Button>
      </div>
    </div>
  );
}

function FieldList({ title, fields }: { title: string; fields: readonly DisclosedFieldView[] }) {
  if (fields.length === 0) return null;
  return (
    <div>
      <p className="text-micro font-medium text-foreground-muted">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {fields.map((field) => (
          <li key={field.path} className="flex items-baseline justify-between gap-3">
            <span className="break-all font-mono text-micro text-foreground-secondary">{field.path}</span>
            <span className="shrink-0 text-micro text-foreground-muted">{label(CLASS_LABEL, field.class)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
