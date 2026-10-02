"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { formatDate } from "@/lib/format";
import { Button, buttonClasses } from "../ui/Button";
import { IconArrowUp, IconAsk, IconClose } from "../ui/Icons";
import { AnswerView } from "./AnswerView";
import { ConsentReview } from "./ConsentReview";
import {
  deleteConsent,
  fetchConsentDisclosure,
  fetchConsentStatus,
  postConsentGrant,
  postQuestion,
  treatmentFor,
  type AssistantAnswer,
  type ClientError,
  type ConsentDisclosureView,
  type ConsentStatusView,
} from "./assistant-client";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "unavailable"; message: string }
  | { kind: "signin"; message: string }
  | { kind: "problem"; message: string }
  | { kind: "consent"; disclosure: ConsentDisclosureView | null; message: string | null; busy: boolean }
  | { kind: "ready"; consent: ConsentStatusView };

type Turn = {
  id: number;
  question: string;
  status: "pending" | "answered" | "failed";
  answer?: AssistantAnswer;
  error?: ClientError;
};

const EXAMPLES = [
  "Which tax regime works out lower for me this year?",
  "How much did I spend in the last three months?",
  "What can I claim under Section 80C?",
];

// The entry point to the real SmartCA assistant (POST /api/assistant and
// its consent endpoints), mounted once in the app shell. A floating button
// opens a native modal sheet: focus is trapped, the page is inert, and
// Escape or the close button returns focus to the button. The panel
// checks consent first; while the server refuses external mode, the
// honest state is "not switched on", with the rule-based Ask page still
// one link away. Conversation state lives only in memory.
export default function AssistantLauncher() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [tucked, setTucked] = useState(false);

  // On phones the button sits over the right-hand money column, so it
  // steps aside while you scroll down through figures and returns when you
  // scroll up, reach the end of the page, or tab to it.
  useEffect(() => {
    let lastY = window.scrollY;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const y = window.scrollY;
        const atEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 48;
        const phone = window.innerWidth < 640;
        if (!phone || atEnd || y < 80) setTucked(false);
        else if (y > lastY + 4) setTucked(true);
        else if (y < lastY - 4) setTucked(false);
        lastY = y;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const pending = turns.some((turn) => turn.status === "pending");
  const lastTurn = turns[turns.length - 1];
  // A short status for screen readers, instead of announcing the whole panel.
  const liveStatus =
    phase.kind === "checking"
      ? "Checking the assistant"
      : !lastTurn
        ? ""
        : lastTurn.status === "pending"
          ? "Working on your question"
          : lastTurn.status === "answered"
            ? "SmartCA answered your question"
            : (lastTurn.error?.message ?? "");

  const failWith = (error: ClientError, fallback: "problem" | "keep") => {
    const treatment = treatmentFor(error);
    if (treatment === "unavailable") setPhase({ kind: "unavailable", message: error.message });
    else if (treatment === "signin") setPhase({ kind: "signin", message: error.message });
    else if (treatment === "consent") void reviewConsent(error.message);
    else if (fallback === "problem") setPhase({ kind: "problem", message: error.message });
  };

  const reviewConsent = async (message: string | null) => {
    setPhase({ kind: "consent", disclosure: null, message, busy: false });
    const disclosure = await fetchConsentDisclosure();
    if (disclosure.ok) setPhase({ kind: "consent", disclosure: disclosure.value, message, busy: false });
    else failWith(disclosure.error, "problem");
  };

  const check = async () => {
    setPhase({ kind: "checking" });
    const status = await fetchConsentStatus();
    if (!status.ok) return failWith(status.error, "problem");
    if (status.value.valid) setPhase({ kind: "ready", consent: status.value });
    else await reviewConsent(null);
  };

  const openPanel = () => {
    dialogRef.current?.showModal();
    setOpen(true);
    // Re-check whenever the panel is not already usable.
    if (phase.kind !== "ready" && phase.kind !== "checking") void check();
  };

  const closePanel = () => dialogRef.current?.close();

  const grant = async () => {
    if (phase.kind !== "consent" || !phase.disclosure) return;
    const disclosure = phase.disclosure;
    setPhase({ ...phase, busy: true });
    const result = await postConsentGrant(disclosure.egress.inventoryVersion);
    if (result.ok) setPhase({ kind: "ready", consent: result.value });
    else if (result.error.code === "disclosure_outdated") void reviewConsent(result.error.message);
    else if (treatmentFor(result.error) === "retry" || treatmentFor(result.error) === "message") {
      setPhase({ kind: "consent", disclosure, message: result.error.message, busy: false });
    } else failWith(result.error, "problem");
  };

  const withdraw = async () => {
    const result = await deleteConsent();
    if (result.ok) void reviewConsent(null);
    else failWith(result.error, "problem");
  };

  const ask = async (question: string, priorTurns: Turn[]) => {
    const id = nextId.current++;
    const asked = [...priorTurns.filter((turn) => turn.status === "answered").map((turn) => turn.question), question];
    setTurns([...priorTurns, { id, question, status: "pending" }]);
    const controller = new AbortController();
    abortRef.current = controller;
    const result = await postQuestion(asked, controller.signal);
    abortRef.current = null;
    setTurns((current) =>
      current.map((turn) =>
        turn.id !== id ? turn : result.ok ? { ...turn, status: "answered", answer: result.value } : { ...turn, status: "failed", error: result.error },
      ),
    );
    if (!result.ok) failWith(result.error, "keep");
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const question = draft.trim();
    if (!question || pending) return;
    setDraft("");
    void ask(question, turns);
  };

  const retry = (turn: Turn) => {
    void ask(
      turn.question,
      turns.filter((t) => t.id !== turn.id),
    );
  };

  const onComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={openPanel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Ask SmartCA"
        data-tucked={tucked && !open ? "true" : undefined}
        className="assistant-fab group fixed bottom-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.75rem))] right-[max(1.25rem,calc(env(safe-area-inset-right)+0.75rem))] z-(--z-fab) flex h-14 w-14 items-center justify-center rounded-pill bg-assistant text-assistant-foreground print:hidden"
      >
        <IconAsk width={22} height={22} />
        <span
          aria-hidden="true"
          className="assistant-fab-tip pointer-events-none absolute right-full top-1/2 mr-3 whitespace-nowrap rounded-md bg-surface-elevated px-2.5 py-1.5 text-label font-medium text-foreground shadow-floating"
        >
          Ask SmartCA
        </span>
      </button>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="assistant-sheet"
        onClose={() => {
          abortRef.current?.abort();
          setOpen(false);
          buttonRef.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closePanel();
        }}
      >
        <div className="flex h-full flex-col">
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-divider px-5 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-pill bg-assistant-soft text-assistant">
                <IconAsk width={18} height={18} />
              </span>
              <h2 id={titleId} className="text-heading font-semibold text-foreground">
                Ask SmartCA
              </h2>
            </div>
            <button
              type="button"
              onClick={closePanel}
              aria-label="Close Ask SmartCA"
              className="inline-flex h-10 w-10 items-center justify-center rounded-control text-foreground-muted transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken hover:text-foreground focus-visible:focus-ring"
            >
              <IconClose />
            </button>
          </header>

          <p className="sr-only" aria-live="polite">
            {liveStatus}
          </p>
          <div className="flex-1 overflow-y-auto px-5 py-5" aria-busy={phase.kind === "checking" || pending}>
            {(phase.kind === "idle" || phase.kind === "checking") && (
              <p className="text-body text-foreground-muted">Checking the assistant…</p>
            )}

            {phase.kind === "unavailable" && (
              <StateMessage title={phase.message}>
                <p>
                  Ask SmartCA writes answers with an external language model, and this SmartCA deployment hasn&apos;t switched one on.
                  Nothing you entered has been shared with a model.
                </p>
                <p>
                  Your ledger, tax computation and documents work as usual.{" "}
                  <Link href="/insights" onClick={closePanel} className="rounded-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:focus-ring">
                    See your rule-based insights
                  </Link>
                  .
                </p>
              </StateMessage>
            )}

            {phase.kind === "signin" && (
              <StateMessage title={phase.message}>
                <Link href="/login" className={buttonClasses("primary", "md", "mt-1")}>
                  Sign in again
                </Link>
              </StateMessage>
            )}

            {phase.kind === "problem" && (
              <StateMessage title={phase.message}>
                <Button type="button" variant="secondary" onClick={() => void check()}>
                  Try again
                </Button>
              </StateMessage>
            )}

            {phase.kind === "consent" &&
              (phase.disclosure ? (
                <ConsentReview
                  disclosure={phase.disclosure}
                  message={phase.message}
                  busy={phase.busy}
                  onGrant={() => void grant()}
                  onDecline={closePanel}
                />
              ) : (
                <p className="text-body text-foreground-muted">Loading what Ask SmartCA shares…</p>
              ))}

            {phase.kind === "ready" && turns.length === 0 && (
              <div className="space-y-4">
                <p className="text-body text-foreground-secondary">
                  Ask about your income and expenses, your tax under either regime, or Indian income-tax rules. Figures come from
                  SmartCA&apos;s tax engine and your ledger.
                </p>
                <ul className="space-y-2" aria-label="Example questions">
                  {EXAMPLES.map((example) => (
                    <li key={example}>
                      <button
                        type="button"
                        onClick={() => {
                          setDraft(example);
                          inputRef.current?.focus();
                        }}
                        className="w-full rounded-md border border-border px-3.5 py-2.5 text-left text-body text-foreground transition-colors duration-(--duration-fast) ease-standard hover:border-border-strong hover:bg-surface-sunken focus-visible:focus-ring"
                      >
                        {example}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {phase.kind === "ready" && turns.length > 0 && (
              <ol className="space-y-6">
                {turns.map((turn) => (
                  <li key={turn.id} className="space-y-3">
                    <div>
                      <p className="text-micro font-medium text-foreground-muted">You asked</p>
                      <p className="mt-1 whitespace-pre-wrap break-words text-body font-medium text-foreground">{turn.question}</p>
                    </div>
                    <div className="border-l-2 border-assistant pl-3.5">
                      {turn.status === "pending" && (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-body text-foreground-muted">Working on your question…</p>
                          <Button type="button" variant="ghost" size="sm" onClick={() => abortRef.current?.abort()}>
                            Cancel
                          </Button>
                        </div>
                      )}
                      {turn.status === "answered" && turn.answer && <AnswerView answer={turn.answer} />}
                      {turn.status === "failed" && turn.error && (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-label text-foreground-secondary">{turn.error.message}</p>
                          {turn.error.retryable && (
                            <Button type="button" variant="secondary" size="sm" onClick={() => retry(turn)} disabled={pending}>
                              Try again
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {phase.kind === "ready" && (
            <footer className="shrink-0 border-t border-divider px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
              <form onSubmit={submit} className="flex items-end gap-2">
                <label htmlFor={`${titleId}-input`} className="sr-only">
                  Your question
                </label>
                <textarea
                  id={`${titleId}-input`}
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onComposerKeyDown}
                  rows={1}
                  placeholder="Ask about your money or tax"
                  className="field-sizing-content max-h-40 min-h-11 flex-1 resize-none rounded-control border border-field-border bg-surface-sunken px-3 py-2.5 text-base text-foreground placeholder:text-foreground-muted focus-visible:focus-ring sm:text-body"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() || pending}
                  aria-label="Send question"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-pill bg-assistant text-assistant-foreground transition-[background-color,opacity] duration-(--duration-fast) ease-standard hover:bg-primary-hover focus-visible:focus-ring disabled:opacity-40"
                >
                  <IconArrowUp />
                </button>
              </form>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-micro text-foreground-muted">
                <span>Explanations are written by a language model. Check them against the sources shown.</span>
                <span>
                  {phase.consent.expiresAt && <>Allowed until {formatDate(phase.consent.expiresAt)} · </>}
                  <button type="button" onClick={() => void withdraw()} className="rounded-xs font-medium text-primary hover:underline focus-visible:focus-ring">
                    Withdraw
                  </button>
                </span>
              </div>
            </footer>
          )}
        </div>
      </dialog>
    </>
  );
}

function StateMessage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-heading font-semibold text-foreground">{title}</h3>
      <div className="space-y-3 text-body text-foreground-secondary">{children}</div>
    </div>
  );
}
