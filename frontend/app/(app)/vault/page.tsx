"use client";

import { useCallback, useEffect, useState } from "react";
import type { DocumentSummary } from "@/services/documents";
import { PageHeader, Section } from "../../components/ui/PageHeader";
import { Dialog } from "../../components/ui/Dialog";
import { DropZone } from "../../components/ui/DropZone";
import { IconDocument } from "../../components/ui/Icons";
import { ErrorState, Skeleton } from "../../components/ui/States";
import { CsvImportFlow, CsvImportTile, useCsvImport } from "./CsvImport";
import DocumentList from "./DocumentList";
import Form16Review from "./Form16Review";
import { messageOf, requestJson } from "./api";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; documents: DocumentSummary[] };

const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// The Vault: bring documents in (a Form 16 PDF, a bank statement CSV), see
// each one's status, and review what was read before anything is used.
// Uploading, deleting, reviewing and importing all use the existing APIs;
// dropping a file is only another way to choose it.
export default function VaultPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const csv = useCsvImport();

  const fetchDocuments = useCallback(
    () => requestJson<{ documents: DocumentSummary[] }>("/api/documents").then((r) => r.documents),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetchDocuments()
      .then((documents) => !cancelled && setLoad({ status: "ready", documents }))
      .catch((err: unknown) => !cancelled && setLoad({ status: "error", message: messageOf(err) }));
    return () => {
      cancelled = true;
    };
  }, [fetchDocuments]);

  // Refresh after something changed. A failed refresh keeps the list already on screen.
  const refresh = useCallback(async () => {
    try {
      const documents = await fetchDocuments();
      setLoad({ status: "ready", documents });
    } catch (err) {
      setActionError(messageOf(err));
    }
  }, [fetchDocuments]);

  const upload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setActionError(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("documentType", "form16");
      const created = await requestJson<DocumentSummary>("/api/documents", { method: "POST", body });
      await refresh();
      // Open the review straight away: reading it is the point of uploading it.
      setReviewingId(created.id);
    } catch (err) {
      setUploadError(messageOf(err));
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: string) => {
    setActionError(null);
    try {
      await requestJson<void>(`/api/documents/${id}`, { method: "DELETE" });
      if (reviewingId === id) setReviewingId(null);
      await refresh();
    } catch (err) {
      setActionError(messageOf(err));
    }
  };

  const documents = load.status === "ready" ? load.documents : [];
  const needReview = documents.filter((d) => d.reviewState === "needs_review").length;
  const confirmed = documents.filter((d) => d.reviewState === "confirmed").length;

  return (
    <>
      <PageHeader title="Vault" description="Your documents and imports. Nothing here is used for tax until you confirm it." />

      <div className="space-y-section">
        <section aria-label="Add to your Vault" className="grid gap-4 lg:grid-cols-2">
          <DropZone
            id="vault-upload"
            accept="application/pdf,.pdf"
            acceptsFile={isPdf}
            onFile={(file) => void upload(file)}
            onReject={() => setUploadError("Choose a PDF file. Form 16 is read from digital PDFs.")}
            busy={uploading}
            icon={<IconDocument />}
            title="Upload a Form 16"
            description="Digital PDFs only, up to 5 MB. Scanned or password-protected files can’t be read. You review every value before it’s used."
            buttonLabel="Choose PDF"
            busyLabel="Uploading and reading…"
          >
            {uploadError && (
              <p role="alert" className="mt-4 rounded-md bg-danger-soft px-3.5 py-2.5 text-label text-foreground">
                {uploadError}
              </p>
            )}
          </DropZone>
          <CsvImportTile csv={csv} />
        </section>

        <CsvImportFlow csv={csv} />

        <Section
          title="Documents"
          className="reveal"
          aside={
            load.status === "ready" && documents.length > 0
              ? [
                  `${documents.length} ${documents.length === 1 ? "document" : "documents"}`,
                  needReview > 0 ? `${needReview} to review` : null,
                  confirmed > 0 ? `${confirmed} confirmed` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
        >
          {actionError && (
            <p role="alert" className="mb-4 rounded-md bg-danger-soft px-3.5 py-2.5 text-label text-foreground">
              {actionError}
            </p>
          )}
          {load.status === "loading" && <DocumentsSkeleton />}
          {load.status === "error" && (
            <ErrorState
              title="Couldn’t load your documents"
              message={load.message}
              onRetry={() => {
                setLoad({ status: "loading" });
                fetchDocuments()
                  .then((docs) => setLoad({ status: "ready", documents: docs }))
                  .catch((err: unknown) => setLoad({ status: "error", message: messageOf(err) }));
              }}
            />
          )}
          {load.status === "ready" && documents.length === 0 && (
            <div className="rounded-panel border border-dashed border-border px-5 py-10 text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-md bg-surface-sunken text-foreground-secondary">
                <IconDocument />
              </span>
              <p className="mt-4 text-body font-medium text-foreground">No documents yet</p>
              <p className="mx-auto mt-1 max-w-sm text-label text-foreground-muted">
                Upload your Form 16 to read its salary figures. Nothing from it is used in your tax calculation until you review and confirm it.
              </p>
            </div>
          )}
          {load.status === "ready" && documents.length > 0 && (
            <DocumentList documents={documents} onReview={(id) => setReviewingId(id)} onDelete={remove} reviewingId={reviewingId} />
          )}
        </Section>
      </div>

      <Dialog open={reviewingId !== null} onClose={() => setReviewingId(null)} title="Review Form 16" size="lg">
        {reviewingId && (
          <Form16Review
            key={reviewingId}
            documentId={reviewingId}
            onClose={() => setReviewingId(null)}
            onConfirmed={() => void refresh()}
          />
        )}
      </Dialog>
    </>
  );
}

function DocumentsSkeleton() {
  return (
    <div role="status" aria-live="polite" className="divide-y divide-divider rounded-panel border border-border bg-surface">
      <span className="sr-only">Loading your documents…</span>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-start gap-4 px-5 py-4">
          <Skeleton className="h-11 w-11 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-56 max-w-full" />
            <Skeleton className="h-3 w-72 max-w-full" />
            <Skeleton className="mt-3 h-8 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}
