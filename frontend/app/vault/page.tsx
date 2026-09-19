"use client";

import { useCallback, useEffect, useState } from "react";
import type { DocumentSummary } from "@/services/documents";
import AppShell from "../components/AppShell";
import { PageHeader, Section } from "../components/ui/PageHeader";
import { ErrorState, LoadingState } from "../components/ui/States";
import CsvImport from "./CsvImport";
import DocumentList from "./DocumentList";
import Form16Review from "./Form16Review";
import { messageOf, requestJson } from "./api";

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; documents: DocumentSummary[] };

export default function VaultPage() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  return (
    <AppShell>
      <PageHeader title="Vault" description="Your documents and imports. Nothing here is used for tax until you confirm it." />

      <div className="mt-8 space-y-10">
        <Section title="Documents">
          {load.status === "loading" && <LoadingState label="Loading your documents…" />}
          {load.status === "error" && (
            <ErrorState
              title="Couldn’t load your documents"
              message={load.message}
              onRetry={() => {
                setLoad({ status: "loading" });
                fetchDocuments()
                  .then((documents) => setLoad({ status: "ready", documents }))
                  .catch((err: unknown) => setLoad({ status: "error", message: messageOf(err) }));
              }}
            />
          )}
          {load.status === "ready" && (
            <DocumentList
              documents={load.documents}
              uploading={uploading}
              uploadError={uploadError}
              actionError={actionError}
              onUpload={upload}
              onReview={(id) => setReviewingId((current) => (current === id ? null : id))}
              onDelete={remove}
              reviewingId={reviewingId}
            />
          )}
        </Section>

        {reviewingId && (
          <Form16Review
            key={reviewingId}
            documentId={reviewingId}
            onClose={() => setReviewingId(null)}
            onConfirmed={() => void refresh()}
          />
        )}

        <Section title="Import transactions from a CSV">
          <CsvImport />
        </Section>
      </div>
    </AppShell>
  );
}
