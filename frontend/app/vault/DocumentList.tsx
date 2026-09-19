"use client";

import { useRef, useState } from "react";
import type { DocumentSummary, ReviewState } from "@/services/documents";
import { Badge } from "../components/ui/Badge";
import { Button, buttonClasses } from "../components/ui/Button";
import { EmptyState } from "../components/ui/States";
import { formatFileSize, formatUploaded } from "./api";

const STATE_LABEL: Record<ReviewState | "uploaded", { label: string; tone: "neutral" | "success" | "destructive" | "warning" }> = {
  uploaded: { label: "Uploaded", tone: "neutral" },
  processing: { label: "Reading", tone: "neutral" },
  needs_review: { label: "Needs review", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "success" },
  failed: { label: "Couldn’t read", tone: "destructive" },
};

// The list of stored documents. Each row keeps two things visibly apart: the
// SOURCE file (download it as uploaded) and its extracted values, whose state
// (needs review, confirmed) says whether anything from them can be used.
export default function DocumentList({
  documents,
  uploading,
  uploadError,
  actionError,
  onUpload,
  onReview,
  onDelete,
  reviewingId,
}: {
  documents: DocumentSummary[];
  uploading: boolean;
  uploadError: string | null;
  actionError: string | null;
  onUpload: (file: File) => void;
  onReview: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  reviewingId: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await onDelete(id);
    } finally {
      setDeleting(false);
      setConfirmingDelete(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          id="vault-upload"
          aria-label="Choose a Form 16 PDF to upload"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ""; // allow choosing the same file again after an error
            if (file) onUpload(file);
          }}
        />
        <Button type="button" onClick={() => inputRef.current?.click()} disabled={uploading}>
          {uploading ? "Uploading and reading…" : "Upload Form 16"}
        </Button>
        <p className="text-[13px] text-muted-foreground">
          Digital PDFs only, up to 5 MB. Scanned or password-protected files can’t be read.
        </p>
      </div>

      {uploadError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {uploadError}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {actionError}
        </p>
      )}

      <div className="mt-6">
        {documents.length === 0 ? (
          <EmptyState
            compact
            title="No documents yet"
            description="Upload your Form 16 to read its salary figures. Nothing from it is used in your tax calculation until you review and confirm it."
          />
        ) : (
          <ul>
            {documents.map((doc) => {
              const state = STATE_LABEL[doc.reviewState ?? "uploaded"];
              const reviewable = doc.reviewState === "needs_review" || doc.reviewState === "confirmed";
              const isConfirming = confirmingDelete === doc.id;
              return (
                <li key={doc.id} className="border-b border-border py-4 first:pt-0 last:border-0">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{doc.filename}</p>
                      <p className="mt-0.5 text-[13px] text-muted-foreground">
                        Form 16 · {formatFileSize(doc.sizeBytes)} · Uploaded {formatUploaded(doc.uploadedAt)}
                        {doc.assessmentYear ? ` · AY ${doc.assessmentYear}` : ""}
                      </p>
                    </div>
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </div>

                  {isConfirming ? (
                    <div role="alertdialog" aria-label={`Delete ${doc.filename}`} className="mt-3 rounded-[var(--radius-md)] border border-border p-3">
                      <p className="text-sm text-foreground">
                        Delete this document and everything read from it? This can’t be undone.
                      </p>
                      <div className="mt-3 flex gap-2">
                        <Button variant="destructive" size="sm" disabled={deleting} onClick={() => handleDelete(doc.id)}>
                          {deleting ? "Deleting…" : "Delete"}
                        </Button>
                        <Button variant="secondary" size="sm" disabled={deleting} onClick={() => setConfirmingDelete(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {reviewable && (
                        <Button
                          variant={doc.reviewState === "needs_review" ? "primary" : "secondary"}
                          size="sm"
                          aria-expanded={reviewingId === doc.id}
                          onClick={() => onReview(doc.id)}
                        >
                          {doc.reviewState === "needs_review" ? "Review values" : "View values"}
                        </Button>
                      )}
                      {doc.reviewState === "failed" && (
                        <Button variant="secondary" size="sm" onClick={() => onReview(doc.id)}>
                          Why?
                        </Button>
                      )}
                      <a href={`/api/documents/${doc.id}/file`} className={buttonClasses("ghost", "sm")} download>
                        Download original
                      </a>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(doc.id)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
