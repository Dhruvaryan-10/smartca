CREATE TYPE "public"."document_processing_status" AS ENUM('uploaded', 'processing', 'extracted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tax_regime" AS ENUM('old', 'new');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('income', 'expense');--> statement-breakpoint
CREATE TABLE "assessment_years" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deductions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"assessment_year_id" uuid NOT NULL,
	"section" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"assessment_year_id" uuid,
	"document_type" text NOT NULL,
	"filename" text NOT NULL,
	"storage_ref" text NOT NULL,
	"processing_status" "document_processing_status" DEFAULT 'uploaded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_computations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"assessment_year_id" uuid NOT NULL,
	"regime" "tax_regime" NOT NULL,
	"engine_version" text NOT NULL,
	"rules_version" text NOT NULL,
	"result_tax_paise" bigint NOT NULL,
	"computation_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "transaction_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"category" text NOT NULL,
	"description" text,
	"source" text,
	"occurred_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_assessment_year_id_assessment_years_id_fk" FOREIGN KEY ("assessment_year_id") REFERENCES "public"."assessment_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_assessment_year_id_assessment_years_id_fk" FOREIGN KEY ("assessment_year_id") REFERENCES "public"."assessment_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computations" ADD CONSTRAINT "tax_computations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_computations" ADD CONSTRAINT "tax_computations_assessment_year_id_assessment_years_id_fk" FOREIGN KEY ("assessment_year_id") REFERENCES "public"."assessment_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_years_label_unique" ON "assessment_years" USING btree ("label");--> statement-breakpoint
CREATE INDEX "deductions_user_id_idx" ON "deductions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "deductions_assessment_year_id_idx" ON "deductions" USING btree ("assessment_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deductions_user_year_section_unique" ON "deductions" USING btree ("user_id","assessment_year_id","section");--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_user_id_assessment_year_id_idx" ON "documents" USING btree ("user_id","assessment_year_id");--> statement-breakpoint
CREATE INDEX "tax_computations_user_id_idx" ON "tax_computations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tax_computations_user_id_assessment_year_id_idx" ON "tax_computations" USING btree ("user_id","assessment_year_id");--> statement-breakpoint
CREATE INDEX "transactions_user_id_idx" ON "transactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transactions_user_id_occurred_on_idx" ON "transactions" USING btree ("user_id","occurred_on");--> statement-breakpoint
CREATE INDEX "transactions_user_id_type_idx" ON "transactions" USING btree ("user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_unique" ON "users" USING btree ("phone");