CREATE TABLE "assistant_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"format_version" integer NOT NULL,
	"profile_id" text NOT NULL,
	"recipient" text NOT NULL,
	"consent" text NOT NULL,
	"data_classes" text[] NOT NULL,
	"inventory_version" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_authorizations_consent_check" CHECK ("assistant_authorizations"."consent" IN ('granted', 'not_granted')),
	CONSTRAINT "assistant_authorizations_window_check" CHECK ("assistant_authorizations"."expires_at" > "assistant_authorizations"."issued_at")
);
--> statement-breakpoint
CREATE TABLE "assistant_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"authorization_id" uuid,
	"mode" text NOT NULL,
	"profile_id" text,
	"recipient" text,
	"model_id" text,
	"allowed_tools" text[],
	"visible_classes" text[],
	"inventory_version" text,
	"status" text NOT NULL,
	"result_code" text,
	"failure_kind" text,
	"answer_state" text,
	"model_calls" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"tool_refusals" integer DEFAULT 0 NOT NULL,
	"tools_called" text[] DEFAULT '{}'::text[] NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	CONSTRAINT "assistant_runs_mode_check" CHECK ("assistant_runs"."mode" IN ('synthetic', 'external')),
	CONSTRAINT "assistant_runs_status_check" CHECK ("assistant_runs"."status" IN ('running', 'succeeded', 'failed', 'rejected')),
	CONSTRAINT "assistant_runs_counts_check" CHECK ("assistant_runs"."model_calls" >= 0 AND "assistant_runs"."tool_calls" >= 0 AND "assistant_runs"."tool_refusals" >= 0)
);
--> statement-breakpoint
ALTER TABLE "assistant_authorizations" ADD CONSTRAINT "assistant_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_runs" ADD CONSTRAINT "assistant_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_runs" ADD CONSTRAINT "assistant_runs_authorization_id_assistant_authorizations_id_fk" FOREIGN KEY ("authorization_id") REFERENCES "public"."assistant_authorizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_authorizations_user_recipient_profile_idx" ON "assistant_authorizations" USING btree ("user_id","recipient","profile_id");--> statement-breakpoint
CREATE INDEX "assistant_runs_user_started_idx" ON "assistant_runs" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "assistant_runs_authorization_idx" ON "assistant_runs" USING btree ("authorization_id");