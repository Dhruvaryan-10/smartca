"use client";

import { useState } from "react";
import type { DocumentSummary, ReviewState } from "@/services/documents";
import { Badge } from "../../components/ui/Badge";
import { Button, buttonClasses } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/Dialog";
import { IconDocument, IconDownload, IconTrash } from "../../components/ui/Icons";
import { formatFileSize, formatUploaded } from "./api";

type Tone = "neutral" | "success" | "destructive" | "warning";

const STATE: Record<ReviewState | "uploaded", { label: string; tone: Tone; dot: string; hint: string }> = {
  uploaded: { label: "Uploaded", tone: "neutral", dot: "bg-foreground-muted", hint: "Stored. Not read yet." },
  processing: { label: "Reading", tone: "neutral", dot: "bg-info status-pulse", hint: "SmartCA is reading this file." },
  needs_review: { label: "Needs review", tone: "warning", dot: "bg-warning", hint: "Check the values read from it before they can be used." },
  confirmed: { label: "Confirmed", tone: "success", dot: "bg-success", hint: "Its values are offered on the Tax page." },
  failed: { label: "Couldn’t read", tone: "destructive", dot: "bg-danger", hint: "This file couldn’t be read." },
};

// The stored documents. Each row keeps two things visibly apart: the
// SOURCE file (download it exactly as uploaded) and its extracted values,
// whose status (needs review, confirmed) says whether anything from them
// can be used. Status is always a word, a dot and a sentence — never
// colour alone.
export default function DocumentList({
  documents,
  onReview,
  onDelete,
  reviewingId,
}: {
  documents: DocumentSummary[];
  onReview: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  reviewingId: string | null;
}) {
  const [confirming, setConfirming] = useState<DocumentSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!confirming) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(confirming.id);
      setConfirming(null);
    } catch {
      setDeleteError("Couldn’t delete this document. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <ul className="divide-y divide-divider rounded-panel border border-border bg-surface">
        {documents.map((doc) => {
          const state = STATE[doc.reviewState ?? "uploaded"];
          const reviewable = doc.reviewState === "needs_review" || doc.reviewState === "confirmed";
          const needsReview = doc.reviewState === "needs_review";
          return (
            <li key={doc.id} className={`px-4 py-4 sm:px-5 ${reviewingId === doc.id ? "bg-accent" : ""}`}>
              <div className="flex items-start gap-3.5 sm:gap-4">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-foreground-secondary">
                  <IconDocument />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p className="min-w-0 truncate text-body font-medium text-foreground">{doc.filename}</p>
                    <Badge tone={state.tone}>
                      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-pill ${state.dot}`} />
                      {state.label}
                    </Badge>
                  </div>
                  <p className="mt-1 text-label text-foreground-muted">
                    Form 16{doc.assessmentYear ? ` · AY ${doc.assessmentYear}` : ""} · {formatFileSize(doc.sizeBytes)} · Uploaded{" "}
                    {formatUploaded(doc.uploadedAt)}
                  </p>
                  <p className="mt-0.5 text-label text-foreground-secondary">{state.hint}</p>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {reviewable && (
                      <Button variant={needsReview ? "primary" : "secondary"} size="sm" onClick={() => onReview(doc.id)}>
                        {needsReview ? "Review values" : "View values"}
                      </Button>
                    )}
                    {doc.reviewState === "failed" && (
                      <Button variant="secondary" size="sm" onClick={() => onReview(doc.id)}>
                        Why?
                      </Button>
                    )}
                    <a href={`/api/documents/${doc.id}/file`} className={buttonClasses("ghost", "sm")} download>
                      <IconDownload width={16} height={16} />
                      <span>
                        Download<span className="sr-only"> {doc.filename}</span>
                        <span className="hidden sm:inline"> original</span>
                      </span>
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="hover:bg-danger-soft hover:text-danger"
                      onClick={() => {
                        setDeleteError(null);
                        setConfirming(doc);
                      }}
                    >
                      <IconTrash width={16} height={16} />
                      Delete<span className="sr-only"> {doc.filename}</span>
                    </Button>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirming !== null}
        title="Delete this document?"
        confirmLabel="Delete document"
        busyLabel="Deleting…"
        busy={deleting}
        error={deleteError}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirming(null)}
      >
        {confirming && (
          <>
            <p className="font-medium text-foreground">{confirming.filename}</p>
            <p>The file and everything read from it are deleted. This can’t be undone.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}
