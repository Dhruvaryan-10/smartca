# Tax-law corpus

The curated, versioned source text behind SmartCA's tax-law retrieval (Phase 5A).
It is **reference data**: global, read-only to the app, and containing nothing
about any user.

## Layout

```
rag-corpus/
  README.md
  ay-2026-27/
    manifest.json          what the corpus is, and metadata for every source
    sources/*.txt          the source text, one file per source
    retrieval-tests.json   small pass/fail regression cases for retrieval
```

## Rules

- **Official sources only.** Every source URL must be an `https` address on a
  `.gov.in` or `.nic.in` host. There is no tier for commentary, blogs or
  secondary summaries.
- **Verbatim text.** Source files are copied from the official page as it read on
  the `retrievedAt` date. Nothing is paraphrased, summarised or written from
  memory. The only edits are structural headings (`#`, `##`, `###`) added by the
  curator so passages have a heading path, and footnote asterisks removed from the
  start of a line. Each source's `notes` field says exactly what was changed.
- **One governing act per corpus.** AY 2026-27 (FY 2025-26) is governed by the
  **Income-tax Act, 1961**. Text or section numbers from the Income-tax Act, 2025
  must not be added; the manifest is refused if `governingAct` says otherwise.
- **If it cannot be sourced, it is left out.** A section with no safely obtainable
  official source is listed under `knownGaps` in the manifest. It is not filled in
  from memory.
- **Pinned.** Each source pins the SHA-256 of its normalised text (no byte-order
  mark, LF line endings, one trailing newline), so an accidental edit is caught at
  ingestion and CRLF checkouts hash identically.
- **Immutable versions.** `corpusVersion` names one manifest for good. Changing any
  source or metadata means a new version.

## Adding or updating a source (by hand)

1. Read the official page yourself and copy the passages you need into
   `sources/<name>.txt`, under headings. Do not automate fetching the Income Tax
   Department's sites: the ingestion script reads local files only.
2. Add the source to `manifest.json`: key, title, publisher, URL, authority tier,
   `sourceDate` (as the page states it), `retrievedAt` (UTC), file, pinned
   `sha256`, and a `sections` rule for each heading (section reference, regime,
   topics, verification status).
3. Raise `corpusVersion`.
4. `npm run rag:ingest -- --check` validates without touching the database;
   `npm run rag:ingest` writes it (idempotent).
5. Add retrieval cases to `retrieval-tests.json` for what the new source covers.

## Authority tiers

| Tier | Meaning |
|---|---|
| `statute` | The text of the Act or a Finance Act. |
| `notification_circular` | A CBDT circular or notification. |
| `official_guidance` | Income Tax Department guidance (for example the e-Filing portal help pages). |

The seed corpus contains **official guidance only**. The pages themselves say
they are an overview and are not exhaustive, and refer to the Act, Forms, Rules
and Notifications for complete details.

## Verification status

- `primary_verified`: verbatim from the official source named in the manifest.
- `engine_not_modelled`: also verbatim, but SmartCA's deterministic tax engine does
  not model this provision, so retrieval may cite it and must never imply the
  engine computes it.

## What retrieval does not do

Retrieval returns evidence (exact quotes with their source). It writes no prose
and computes no tax. The deterministic tax engine is the only source of tax
arithmetic.
