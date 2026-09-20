// SmartCA — PostgreSQL / Drizzle schema (Phase 1A foundation).
//
// MONEY CONVENTION: every monetary column is an integer number of paise
// (₹1 = 100 paise). Never store money as a float/numeric-with-decimals.
// Convert to rupees only at the application/UI boundary when displaying
// values — never in the database or in stored computation results.
//
// ASSESSMENT YEAR: represented by the `assessmentYears` lookup table
// rather than an enum or a free-text column, so a new assessment year
// (e.g. AY 2027-28) is added by inserting one row — no schema change,
// no migration to widen an enum. Every AY-scoped table references it by
// foreign key instead of duplicating the "2026-27"-style label.
//
// OWNERSHIP: every user-owned table has a NOT NULL `userId` foreign key
// to `users`, `ON DELETE CASCADE`, so deleting a user cannot leave
// orphaned financial records behind.

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------
// Phase 1B: Auth.js uses email/password (Credentials provider) as the
// sign-in method, so `email` is now the required identifier and
// `passwordHash` holds a bcrypt hash — never a plaintext password, and
// never anything else that looks like a password. `phone` is kept as an
// optional legacy field (carried over from the v1 OTP flow); it is not
// used for authentication in this phase.
//
// No Auth.js adapter tables (accounts/sessions/verification_tokens) are
// needed: Credentials-based sign-in only supports JWT sessions, not
// database sessions, so this table alone is sufficient as the identity
// store — see frontend/auth.ts.

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  phone: text("phone"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("users_email_unique").on(table.email),
  uniqueIndex("users_phone_unique").on(table.phone),
]);

// ---------------------------------------------------------------------
// Assessment years
// ---------------------------------------------------------------------
// Small reference table, not user-owned — a plain serial id is enough
// (uuid would be needless indirection for a handful of lookup rows).

export const assessmentYears = pgTable("assessment_years", {
  id: uuid("id").primaryKey().defaultRandom(),
  // e.g. "2026-27"
  label: text("label").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("assessment_years_label_unique").on(table.label),
]);

// ---------------------------------------------------------------------
// Transactions (income / expense ledger)
// ---------------------------------------------------------------------
// Carries forward the useful concepts from the v1 models (see
// MIGRATION-CHECKPOINT.md): type, amount, category, date from the old
// Mongoose schema; title/description and per-user ownership from the
// old Flask/PyMongo income & expense collections. Not a blind copy —
// relational constraints and a real user FK replace what neither v1
// model had.

export const transactionType = pgEnum("transaction_type", ["income", "expense"]);

export const transactions = pgTable("transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: transactionType("type").notNull(),
  amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
  category: text("category").notNull(),
  description: text("description"),
  // where this transaction came from: "manual", "csv_import", "form16", etc.
  // free text on purpose — the set of sources will grow before it stabilizes.
  source: text("source"),
  occurredOn: date("occurred_on").notNull(),
  // Set only on rows created by a CSV import. The fingerprint is a
  // deterministic hash of the row's values plus its occurrence index within
  // the file (see lib/csv-import.ts), unique per user, so re-importing the
  // same file cannot create the same row twice. Manual rows leave both null.
  importFingerprint: text("import_fingerprint"),
  importBatchId: uuid("import_batch_id").references(() => importBatches.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("transactions_user_id_idx").on(table.userId),
  index("transactions_user_id_occurred_on_idx").on(table.userId, table.occurredOn),
  index("transactions_user_id_type_idx").on(table.userId, table.type),
  // Null fingerprints (manual rows) never collide: Postgres treats NULLs as distinct.
  uniqueIndex("transactions_user_id_import_fingerprint_unique").on(table.userId, table.importFingerprint),
  index("transactions_import_batch_id_idx").on(table.importBatchId),
]);

// ---------------------------------------------------------------------
// Import batches (CSV import metadata; the CSV file itself is never kept)
// ---------------------------------------------------------------------

export const importBatches = pgTable("import_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // sanitized display name only — never used as a path
  filename: text("filename").notNull(),
  rowCount: integer("row_count").notNull(),
  insertedCount: integer("inserted_count").notNull(),
  skippedDuplicateCount: integer("skipped_duplicate_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("import_batches_user_id_idx").on(table.userId),
]);

// ---------------------------------------------------------------------
// Deductions (declared, per assessment year)
// ---------------------------------------------------------------------

export const deductions = pgTable("deductions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assessmentYearId: uuid("assessment_year_id").notNull().references(() => assessmentYears.id, { onDelete: "restrict" }),
  // e.g. "80C", "80D", "HRA"
  section: text("section").notNull(),
  amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("deductions_user_id_idx").on(table.userId),
  index("deductions_assessment_year_id_idx").on(table.assessmentYearId),
  // One declaration per user/year/section — resubmitting the same
  // section for the same year should update the existing row, not
  // create a duplicate.
  uniqueIndex("deductions_user_year_section_unique").on(
    table.userId,
    table.assessmentYearId,
    table.section,
  ),
]);

// ---------------------------------------------------------------------
// Tax computations (persisted results — no engine yet, Phase 1A is
// storage shape only)
// ---------------------------------------------------------------------
// A row represents one completed computation run. Deliberately NOT
// unique per (user, year, regime) — old-vs-new comparison and
// simulation (P1 product features) mean a user may have several
// computations for the same year/regime over time; `createdAt` orders
// them, the most recent being authoritative unless the application
// says otherwise.

export const taxRegime = pgEnum("tax_regime", ["old", "new"]);

export const taxComputations = pgTable("tax_computations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assessmentYearId: uuid("assessment_year_id").notNull().references(() => assessmentYears.id, { onDelete: "restrict" }),
  regime: taxRegime("regime").notNull(),
  // identifies which version of the (not-yet-built) tax engine and
  // which version of the tax rules produced this result, so historical
  // computations stay interpretable after either changes.
  engineVersion: text("engine_version").notNull(),
  rulesVersion: text("rules_version").notNull(),
  resultTaxPaise: bigint("result_tax_paise", { mode: "number" }).notNull(),
  // full computation tree / intermediate steps, opaque to the schema —
  // shape is owned by the tax engine, not the database.
  computationData: jsonb("computation_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("tax_computations_user_id_idx").on(table.userId),
  index("tax_computations_user_id_assessment_year_id_idx").on(table.userId, table.assessmentYearId),
]);

// ---------------------------------------------------------------------
// Documents (Form 16 etc. — upload/metadata shape only, no extraction
// in this phase)
// ---------------------------------------------------------------------

export const documentProcessingStatus = pgEnum("document_processing_status", [
  "uploaded",
  "processing",
  "extracted",
  "failed",
]);

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // nullable: not every document type is necessarily tied to one AY.
  assessmentYearId: uuid("assessment_year_id").references(() => assessmentYears.id, { onDelete: "restrict" }),
  // free text on purpose — "form16" today, more types later, without an
  // enum migration each time.
  documentType: text("document_type").notNull(),
  filename: text("filename").notNull(),
  // opaque reference to wherever the file bytes actually live (object
  // storage key, path, etc.) — storage backend is not decided in this
  // phase, so this is intentionally just a string.
  storageRef: text("storage_ref").notNull(),
  // Set by the server from the file's real bytes, never from what the browser claimed.
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  // hex SHA-256 of the file bytes; with user_id it stops the same file being stored twice
  sha256: text("sha256").notNull(),
  processingStatus: documentProcessingStatus("processing_status").notNull().default("uploaded"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("documents_user_id_idx").on(table.userId),
  index("documents_user_id_assessment_year_id_idx").on(table.userId, table.assessmentYearId),
  uniqueIndex("documents_user_id_sha256_unique").on(table.userId, table.sha256),
]);

// Postgres bytea <-> Node Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// File bytes live here and ONLY here, never on `documents`, so listing
// documents can never drag file content along. Deleting the document
// cascades to this row: no orphaned bytes.
export const documentFiles = pgTable("document_files", {
  documentId: uuid("document_id").primaryKey().references(() => documents.id, { onDelete: "cascade" }),
  content: bytea("content").notNull(),
});

// Where a document is in the extract -> review -> confirm flow. Kept apart
// from documents.processing_status so that enum did not need to grow.
export const extractionStatus = pgEnum("extraction_status", ["processing", "needs_review", "confirmed", "failed"]);

// One extraction per document. `extracted` is what the parser read (NOT
// trusted); `confirmed` stays null until the user reviews and confirms, and
// is the only part any calculation may read.
export const documentExtractions = pgTable("document_extractions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  extractorVersion: text("extractor_version").notNull(),
  status: extractionStatus("status").notNull(),
  extracted: jsonb("extracted").notNull(),
  confirmed: jsonb("confirmed"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  // Plain-language reason when status is "failed". Never contains document text.
  failureMessage: text("failure_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("document_extractions_document_id_unique").on(table.documentId),
  index("document_extractions_user_id_idx").on(table.userId),
]);

// ---------------------------------------------------------------------
// Tax-law corpus (Phase 5A) — GLOBAL, read-only reference data.
// ---------------------------------------------------------------------
// Authoritative tax-law sources and their chunks, for retrieval. NOTHING
// here belongs to a user: there is deliberately no `user_id` on any of these
// tables, and no user financial data (transactions, documents, Form 16
// values, computations) is ever stored in or joined to them.
//
// They are written only by the ingestion script (scripts/rag-ingest.ts) from
// the curated files in rag-corpus/. Request handlers only ever SELECT from
// them (services/tax-retrieval.ts). The database has one application role, so
// this is enforced by code structure and tests, not by grants.
//
// The governing act is recorded on every source. For AY 2026-27 it is the
// Income-tax Act, 1961; text and section numbers of the Income-tax Act, 2025
// must never be mixed into the same corpus.

// Highest authority first in meaning (see lib/rag/corpus.ts). Only official
// sources are accepted; there is no tier for commentary.
export const taxAuthorityTier = pgEnum("tax_authority_tier", ["statute", "notification_circular", "official_guidance"]);
export const taxSourceStatus = pgEnum("tax_source_status", ["active", "superseded", "withdrawn"]);
export const taxChunkRegime = pgEnum("tax_chunk_regime", ["old", "new", "both"]);
// primary_verified: verbatim from the official source, as retrieved.
// engine_not_modelled: verbatim too, but the deterministic engine does not model the
// provision, so retrieval must never imply the engine computes it.
export const taxVerificationStatus = pgEnum("tax_verification_status", ["primary_verified", "engine_not_modelled"]);

// PostgreSQL full-text search vector. Drizzle has no built-in type for it.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const taxSources = pgTable("tax_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Stable, human-readable key from the manifest. Ingestion upserts on it.
  sourceKey: text("source_key").notNull(),
  title: text("title").notNull(),
  publisher: text("publisher").notNull(),
  url: text("url").notNull(),
  authorityTier: taxAuthorityTier("authority_tier").notNull(),
  governingAct: text("governing_act").notNull(),
  // The assessment year this source is curated for, e.g. "2026-27". Retrieval only ever
  // returns sources for the year asked about.
  assessmentYear: text("assessment_year").notNull(),
  // When the source says it was published or last reviewed, if it says.
  sourceDate: date("source_date"),
  effectiveFrom: date("effective_from"),
  effectiveTo: date("effective_to"),
  // When the text was actually fetched by a person and curated.
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  // SHA-256 of the normalised source text.
  contentSha256: text("content_sha256").notNull(),
  status: taxSourceStatus("status").notNull().default("active"),
}, (table) => [
  uniqueIndex("tax_sources_source_key_unique").on(table.sourceKey),
  index("tax_sources_assessment_year_status_idx").on(table.assessmentYear, table.status),
  check("tax_sources_effective_dates_check", sql`${table.effectiveFrom} IS NULL OR ${table.effectiveTo} IS NULL OR ${table.effectiveFrom} <= ${table.effectiveTo}`),
]);

export const taxSourceChunks = pgTable("tax_source_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => taxSources.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  // Canonical section reference such as "87A" or "16(ia)"; null when the passage is not tied to one.
  sectionRef: text("section_ref"),
  // The headings above the passage, outermost first.
  headingPath: text("heading_path").array().notNull(),
  // An exact slice of the source text. A retrieved quote is an exact substring of this.
  text: text("text").notNull(),
  textSha256: text("text_sha256").notNull(),
  // The slice's offsets in the normalised source text.
  charStart: integer("char_start").notNull(),
  charEnd: integer("char_end").notNull(),
  regime: taxChunkRegime("regime").notNull().default("both"),
  topics: text("topics").array().notNull(),
  verificationStatus: taxVerificationStatus("verification_status").notNull().default("primary_verified"),
  // Generated by PostgreSQL from the section reference (weight A) and the text (weight C). The
  // heading path is not part of it: array_to_string is not immutable, so it cannot be.
  searchVector: tsvector("search_vector").generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce("section_ref", '')), 'A') || setweight(to_tsvector('english', "text"), 'C')`,
  ),
}, (table) => [
  uniqueIndex("tax_source_chunks_source_id_chunk_index_unique").on(table.sourceId, table.chunkIndex),
  index("tax_source_chunks_section_ref_idx").on(table.sectionRef),
  index("tax_source_chunks_search_vector_idx").using("gin", table.searchVector),
  check("tax_source_chunks_position_check", sql`${table.chunkIndex} >= 0 AND ${table.charStart} >= 0 AND ${table.charEnd} > ${table.charStart}`),
]);

// One row per ingested corpus version. Every evidence object carries the version it came from.
export const taxCorpusReleases = pgTable("tax_corpus_releases", {
  id: uuid("id").primaryKey().defaultRandom(),
  version: text("version").notNull(),
  // Hash over the canonical manifest and every source's content hash.
  manifestSha256: text("manifest_sha256").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tax_corpus_releases_version_unique").on(table.version),
  uniqueIndex("tax_corpus_releases_manifest_sha256_unique").on(table.manifestSha256),
]);
