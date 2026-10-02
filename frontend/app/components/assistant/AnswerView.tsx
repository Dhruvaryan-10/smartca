import { Badge } from "../ui/Badge";
import { safeExternalUrl, type AnswerState, type AnswerTaxValue, type AssistantAnswer } from "./assistant-client";

const STATE_COPY: Record<Exclude<AnswerState, "answered">, { title: string; body: string }> = {
  insufficient_evidence: {
    title: "Not enough evidence to answer",
    body: "SmartCA couldn't find sources that support an answer. Try naming the section, deduction or period you mean.",
  },
  unsupported: {
    title: "Outside what SmartCA can answer",
    body: "This question needs something SmartCA doesn't cover yet. Try asking about your ledger, your tax computation or Indian income-tax rules.",
  },
  withheld: {
    title: "Answer withheld",
    body: "SmartCA wrote an answer but held it back because it didn't pass its accuracy checks. Try rephrasing the question.",
  },
};

const TAX_SHAPE: Record<AnswerTaxValue["shape"], string> = {
  single_regime: "Tax computed by the SmartCA tax engine",
  regime_comparison: "Regime comparison from the SmartCA tax engine",
  scenario: "Scenario computed by the SmartCA tax engine",
};

// One answer, laid out like a CA's working papers: the explanation (the
// model's prose, always plain text, never HTML or markdown), then where
// its facts came from (tax engine, ledger, cited law), then any notices
// exactly as the server sent them.
export function AnswerView({ answer }: { answer: AssistantAnswer }) {
  const { text, citations, facts, notices, authority } = answer;
  const stateCopy = answer.state === "answered" ? null : STATE_COPY[answer.state];

  return (
    <div className="space-y-4">
      {stateCopy && (
        <div className="rounded-md bg-warning-soft px-3.5 py-3">
          <p className="text-body font-medium text-foreground">{stateCopy.title}</p>
          <p className="mt-1 text-label text-foreground-secondary">{stateCopy.body}</p>
        </div>
      )}

      {text && (
        <div>
          <div className="flex items-center gap-2">
            <p className="text-micro font-medium text-foreground-muted">Explanation</p>
            {authority.guidanceOnly && <Badge tone="info">Guidance only</Badge>}
          </div>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-body-lg text-foreground">{text.content}</p>
        </div>
      )}

      {(facts.taxValues.length > 0 || facts.ledger.length > 0) && (
        <ul className="space-y-2" aria-label="Figures used">
          {facts.taxValues.map((fact) => (
            <li key={`${fact.callId}-${fact.round}`} className="border-l-2 border-tax pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="tax">Tax engine</Badge>
                <span className="text-label text-foreground">{TAX_SHAPE[fact.shape]}</span>
              </div>
              <p className="mt-1 font-mono text-micro text-foreground-muted">
                AY {fact.assessmentYear}
                {fact.engineVersion && ` · engine ${fact.engineVersion}`}
                {fact.rulesVersion && ` · rules ${fact.rulesVersion}`}
              </p>
              {fact.notice && <p className="mt-1 text-label text-foreground-secondary">{fact.notice}</p>}
            </li>
          ))}
          {facts.ledger.map((fact) => (
            <li key={`${fact.callId}-${fact.round}`} className="border-l-2 border-income pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="income">Your ledger</Badge>
                <span className="text-label text-foreground">
                  {fact.shape === "summary" ? "Summary of your income and expenses" : "Transactions from your ledger"}
                </span>
              </div>
              {fact.notice && <p className="mt-1 text-label text-foreground-secondary">{fact.notice}</p>}
            </li>
          ))}
        </ul>
      )}

      {facts.refusals.length > 0 && (
        <ul className="space-y-1.5">
          {facts.refusals.map((refusal) => (
            <li key={`${refusal.callId}-${refusal.round}`} className="text-label text-foreground-secondary">
              {refusal.message}
            </li>
          ))}
        </ul>
      )}

      {citations.length > 0 && (
        <div>
          <p className="text-micro font-medium text-foreground-muted">Sources</p>
          <ol className="mt-1.5 space-y-2.5">
            {citations.map(({ evidenceId, evidence }, index) => {
              const href = safeExternalUrl(evidence.url);
              return (
                <li key={evidenceId} className="flex gap-2.5">
                  <span className="font-numeric text-label text-foreground-muted">{index + 1}.</span>
                  <div className="min-w-0">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-xs text-label font-medium text-primary underline-offset-2 hover:underline focus-visible:focus-ring"
                      >
                        {evidence.title}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    ) : (
                      <p className="text-label font-medium text-foreground">{evidence.title}</p>
                    )}
                    <p className="text-micro text-foreground-muted">
                      {evidence.publisher}
                      {evidence.sectionRef && ` · ${evidence.sectionRef}`} · AY {evidence.assessmentYear}
                    </p>
                    <p className="mt-1 line-clamp-3 text-label text-foreground-secondary">{evidence.quote}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {notices.length > 0 && (
        <ul className="space-y-1.5 rounded-md bg-info-soft px-3.5 py-3">
          {notices.map((notice) => (
            <li key={notice} className="text-label text-foreground">
              {notice}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
