"use client";

import AppShell from "../components/AppShell";
import { PageHeader } from "../components/ui/PageHeader";
import { EmptyState } from "../components/ui/States";

export default function VaultPage() {
  return (
    <AppShell>
      <PageHeader title="Vault" description="Secure document storage for your financial records." />
      <EmptyState
        title="Vault is coming soon"
        description="Form 16s, statements and receipts will live here once document storage ships. No files are stored yet."
      />
    </AppShell>
  );
}
