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

import {
  bigint,
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
