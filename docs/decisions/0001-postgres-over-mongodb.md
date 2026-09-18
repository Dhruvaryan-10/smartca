# ADR 0001: PostgreSQL + Drizzle over MongoDB

**Status:** Accepted
**Date:** Phase 1A of the SmartCA v1 → v2 migration

## Context

SmartCA v1 used MongoDB in two disconnected, uncoordinated ways (see `docs/SMARTCA-REPOSITORY-AUDIT.md` §6 for the full finding):

1. A Flask/PyMongo backend (`backend/app.py`) storing schema-less `otp`, `users`, `income`, and `expenses` documents, keyed loosely by phone number.
2. A Next.js/Mongoose API route (`frontend/app/api/transactions/route.ts`, removed in Phase 0) storing a single `transactions` collection with **no user/owner field at all** — the root cause of the critical cross-user data exposure documented in the audit and `SECURITY.md`.

Neither MongoDB data model enforced any relationship between a user and their financial records; ownership, where it existed at all, was enforced only by application code remembering to filter by `phone` — and one of the two paths didn't even do that.

**The MongoDB Atlas cluster backing both of these has since been permanently deleted.** It is not being migrated, recovered, or reconnected. Phase 0 removed Mongoose, PyMongo's active usage, and the hardcoded MongoDB credential that had been committed to git history. See `MIGRATION-CHECKPOINT.md` for the full Phase 0 record.

## Decision

SmartCA v2 uses **PostgreSQL**, accessed through **Drizzle ORM** and **Drizzle Kit** for schema management and migrations, as its sole database. No other ORM (Prisma, TypeORM, etc.) is introduced, and no document database is reintroduced.

## Rationale

- **Financial data needs relational integrity, not schema flexibility.** SmartCA stores income, expenses, deductions, tax computations, and documents that all fundamentally derive their meaning from *whose* they are and *which assessment year* they belong to. A relational database can enforce this at the data layer with foreign keys, `NOT NULL` constraints, and unique constraints — a document database can only enforce it in application code, which is exactly how the v1 cross-user leak happened.
- **User ownership becomes structural, not conventional.** Every user-owned table in the new schema (`transactions`, `deductions`, `tax_computations`, `documents`) has a `NOT NULL` foreign key to `users.id` with `ON DELETE CASCADE`. It is not possible to insert a financial record without a valid, existing owner — the database itself rejects the attempt (verified in Phase 1A; see below).
- **Duplicate/invalid data can be prevented declaratively.** For example, a duplicate deduction declaration for the same user/assessment-year/section is rejected by a unique constraint (`deductions_user_year_section_unique`), not by an application-level check that could be forgotten or bypassed, as the v1 Mongoose route demonstrated application-level checks can be.
- **Migrations are explicit and reviewable.** Drizzle Kit generates plain SQL migration files (`frontend/drizzle/*.sql`) that are committed to the repository and can be read, diffed, and reviewed like any other code change — unlike MongoDB's implicit, per-document schema.
- **Money correctness is easier to guarantee.** PostgreSQL's `bigint` columns store exact integer paise with no floating-point representation risk; the v1 tax calculator's floating-point rupee arithmetic (audit §8) is exactly the kind of error this is meant to prevent going forward.
- **Drizzle specifically, over an alternative ORM:** Drizzle's schema is plain TypeScript (matching the rest of the Next.js codebase), its generated SQL is inspectable rather than hidden behind a proprietary migration format, and it has no separate query-engine binary or code-generation step beyond `drizzle-kit generate` — keeping the stack small and auditable.

## Consequences

- All new application code accesses the database exclusively through Drizzle's typed query builder against the schema in `frontend/db/schema.ts` — no raw MongoDB driver calls, no Mongoose models, anywhere in the codebase going forward.
- `DATABASE_URL` is required via environment variable for any code that touches the database (`frontend/db/client.ts`, `drizzle.config.ts`, and the `db:*` scripts); it is never hardcoded, matching the lesson from the previously-committed MongoDB credential (audit finding #1).
- The legacy Flask/PyMongo backend (`backend/app.py`) remains explicitly out of scope for this decision — it is marked legacy and pending removal once its authentication pattern has been reimplemented on the new foundation (see `MIGRATION-CHECKPOINT.md`); it does not, and will not, gain a PostgreSQL connection of its own.
- Assessment years are modeled as rows in an `assessment_years` reference table rather than as an enum or free-text field, so a future assessment year (AY 2027-28 and beyond) is added by inserting a row, not by altering the schema.
- This decision covers the data layer only. It does not decide authentication (Auth.js, deferred to a later phase), the tax computation engine, or any application feature — those are separate decisions built on top of this foundation.

## Verification

Phase 1A's schema was generated via `drizzle-kit generate`, applied to a real local PostgreSQL database via a Drizzle migrator script, and verified against that live database (not just against TypeScript types) with a script that inserts real rows, confirms foreign-key and unique-constraint rejections with the expected PostgreSQL error codes, and confirms integer-paise storage — then rolls everything back so no test data persists. See the Phase 1A completion report for full results.
