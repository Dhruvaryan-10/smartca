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
  date,
  index,
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
// Deliberately minimal in Phase 1A: just enough identity to own records.
// Auth.js (Phase 1B) may add/require additional columns (email
// verification, provider linkage, etc.) — not guessed at here.

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email"),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("transactions_user_id_idx").on(table.userId),
  index("transactions_user_id_occurred_on_idx").on(table.userId, table.occurredOn),
  index("transactions_user_id_type_idx").on(table.userId, table.type),
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
  processingStatus: documentProcessingStatus("processing_status").notNull().default("uploaded"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("documents_user_id_idx").on(table.userId),
  index("documents_user_id_assessment_year_id_idx").on(table.userId, table.assessmentYearId),
]);
