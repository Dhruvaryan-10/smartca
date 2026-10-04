"use client";

import { useRef, useState } from "react";
import type { ReactNode } from "react";

// A calm file target: choose a file with the button, or drop one on the
// zone. Either way the file goes to `onFile`, the same handler the page
// already uses for uploads; the zone adds no capability of its own. The
// visible button is the keyboard and screen-reader path; dropping is a
// pointer convenience. Files whose type does not match `accept` are
// reported through `onReject` instead of being sent.
export function DropZone({
  id,
  accept,
  acceptsFile,
  onFile,
  onReject,
  busy,
  icon,
  title,
  description,
  buttonLabel,
  busyLabel,
  children,
}: {
  id: string;
  accept: string;
  acceptsFile: (file: File) => boolean;
  onFile: (file: File) => void;
  onReject: (file: File) => void;
  busy: boolean;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  buttonLabel: string;
  busyLabel: string;
  children?: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const take = (file: File | undefined) => {
    if (!file || busy) return;
    if (acceptsFile(file)) onFile(file);
    else onReject(file);
  };

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        take(e.dataTransfer.files?.[0]);
      }}
      aria-busy={busy}
      className={`relative flex h-full flex-col rounded-panel border border-dashed p-5 transition-[background-color,border-color] duration-(--duration-fast) ease-standard sm:p-6 ${
        dragging ? "border-primary bg-accent" : "border-field-border bg-surface"
      }`}
    >
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // allow choosing the same file again after an error
          take(file);
        }}
      />
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-foreground">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-subheading font-semibold text-foreground">{title}</h3>
          <div className="mt-1 text-label text-foreground-muted">{description}</div>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 sm:mt-auto sm:pt-5">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-control bg-primary px-4 text-body font-medium text-primary-foreground transition-[background-color,transform] duration-(--duration-fast) ease-standard hover:bg-primary-hover focus-visible:focus-ring active:scale-98 disabled:pointer-events-none disabled:opacity-60"
        >
          {busy ? busyLabel : buttonLabel}
        </button>
        <span className="hidden text-label text-foreground-muted sm:inline">{dragging ? "Drop to add it" : "or drop a file here"}</span>
      </div>
      {busy && (
        <div className="mt-4 h-1 overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
          <div className="progress-indeterminate h-full w-1/3 rounded-pill bg-primary" />
        </div>
      )}
      {children}
    </div>
  );
}
