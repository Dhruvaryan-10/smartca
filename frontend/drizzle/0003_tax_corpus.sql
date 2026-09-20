CREATE TYPE "public"."tax_authority_tier" AS ENUM('statute', 'notification_circular', 'official_guidance');--> statement-breakpoint
CREATE TYPE "public"."tax_chunk_regime" AS ENUM('old', 'new', 'both');--> statement-breakpoint
CREATE TYPE "public"."tax_source_status" AS ENUM('active', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."tax_verification_status" AS ENUM('primary_verified', 'engine_not_modelled');--> statement-breakpoint
CREATE TABLE "tax_corpus_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_source_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"section_ref" text,
	"heading_path" text[] NOT NULL,
	"text" text NOT NULL,
	"text_sha256" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"regime" "tax_chunk_regime" DEFAULT 'both' NOT NULL,
	"topics" text[] NOT NULL,
	"verification_status" "tax_verification_status" DEFAULT 'primary_verified' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("section_ref", '')), 'A') || setweight(to_tsvector('english', "text"), 'C')) STORED,
	CONSTRAINT "tax_source_chunks_position_check" CHECK ("tax_source_chunks"."chunk_index" >= 0 AND "tax_source_chunks"."char_start" >= 0 AND "tax_source_chunks"."char_end" > "tax_source_chunks"."char_start")
);
--> statement-breakpoint
CREATE TABLE "tax_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_key" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text NOT NULL,
	"url" text NOT NULL,
	"authority_tier" "tax_authority_tier" NOT NULL,
	"governing_act" text NOT NULL,
	"assessment_year" text NOT NULL,
	"source_date" date,
	"effective_from" date,
	"effective_to" date,
	"retrieved_at" timestamp with time zone NOT NULL,
	"content_sha256" text NOT NULL,
	"status" "tax_source_status" DEFAULT 'active' NOT NULL,
	CONSTRAINT "tax_sources_effective_dates_check" CHECK ("tax_sources"."effective_from" IS NULL OR "tax_sources"."effective_to" IS NULL OR "tax_sources"."effective_from" <= "tax_sources"."effective_to")
);
--> statement-breakpoint
ALTER TABLE "tax_source_chunks" ADD CONSTRAINT "tax_source_chunks_source_id_tax_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."tax_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_corpus_releases_version_unique" ON "tax_corpus_releases" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_corpus_releases_manifest_sha256_unique" ON "tax_corpus_releases" USING btree ("manifest_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_source_chunks_source_id_chunk_index_unique" ON "tax_source_chunks" USING btree ("source_id","chunk_index");--> statement-breakpoint
CREATE INDEX "tax_source_chunks_section_ref_idx" ON "tax_source_chunks" USING btree ("section_ref");--> statement-breakpoint
CREATE INDEX "tax_source_chunks_search_vector_idx" ON "tax_source_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_sources_source_key_unique" ON "tax_sources" USING btree ("source_key");--> statement-breakpoint
CREATE INDEX "tax_sources_assessment_year_status_idx" ON "tax_sources" USING btree ("assessment_year","status");