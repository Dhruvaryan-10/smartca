"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { IconClose } from "./Icons";

// A native modal <dialog>: focus is trapped, the page behind is inert and
// Escape closes it, all from the platform; focus returns to whatever
// opened it. Centred from 640px, a bottom sheet below. Content renders
// only while open, so a reopened form always starts fresh. An element
// marked `data-autofocus` receives focus on open; otherwise the first
// focusable element does.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={`app-dialog ${size === "lg" ? "app-dialog--lg" : ""}`}
    >
      {open && (
        <>
          <header className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-5 sm:px-6">
            <div className="min-w-0">
              <h2 id={titleId} className="text-heading font-semibold text-foreground">
                {title}
              </h2>
              {description && <div className="mt-1 text-label text-foreground-muted">{description}</div>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-2 -mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-foreground-muted transition-colors duration-(--duration-fast) ease-standard hover:bg-surface-sunken hover:text-foreground focus-visible:focus-ring"
            >
              <IconClose />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6">{children}</div>
          {footer && (
            <footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-divider px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:flex-row sm:justify-end sm:px-6 sm:pb-4">
              {footer}
            </footer>
          )}
        </>
      )}
    </dialog>
  );
}

// A destructive confirmation: the consequence in one sentence, a danger
// button named for the action, and focus starting on Cancel.
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={() => !busy && onCancel()}
      title={title}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy} data-autofocus>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={busy} aria-busy={busy}>
            {busy ? busyLabel : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-body text-foreground-secondary">{children}</div>
      {error && (
        <p role="alert" className="mt-3 text-label text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
