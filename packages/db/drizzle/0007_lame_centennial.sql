ALTER TYPE "public"."work_kind" ADD VALUE 'agent';--> statement-breakpoint
CREATE TABLE "agent_contexts" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"context_epoch" uuid NOT NULL,
	"read_scope" text NOT NULL,
	"key_source" text DEFAULT 'site' NOT NULL,
	"privacy_class" text DEFAULT 'standard' NOT NULL,
	"key_revision" bigint,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_outputs" (
	"run_id" uuid NOT NULL,
	"resume_seq" bigint NOT NULL,
	"message_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_run_outputs_run_id_resume_seq_pk" PRIMARY KEY("run_id","resume_seq")
);
--> statement-breakpoint
CREATE TABLE "agent_run_states" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"state_version" bigint DEFAULT 1 NOT NULL,
	"resume_seq" bigint DEFAULT 0 NOT NULL,
	"context_epoch" uuid NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"delegation_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"conversation_id" uuid,
	"context_conversation_id" uuid,
	"source_message_id" uuid,
	"output_message_id" uuid,
	"read_scope" text NOT NULL,
	"key_source" text DEFAULT 'site' NOT NULL,
	"privacy_class" text DEFAULT 'standard' NOT NULL,
	"key_revision" bigint,
	"mode" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"actual_model" text,
	"timezone" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"regenerated_from_run_id" uuid,
	"step_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"heartbeat_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"resume_seq" bigint DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"context_epoch" uuid NOT NULL,
	"context_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_membership_version" bigint NOT NULL,
	"shared_visible_from_seq" bigint DEFAULT 0 NOT NULL,
	"state_version" bigint DEFAULT 1 NOT NULL,
	"elapsed_active_ms" bigint DEFAULT 0 NOT NULL,
	"has_effects" boolean DEFAULT false NOT NULL,
	"pending_approval" boolean DEFAULT false NOT NULL,
	"content_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_status" CHECK ("agent_runs"."status" in ('queued','running','awaiting_approval','completed','failed','cancelled')),
	CONSTRAINT "agent_runs_scope" CHECK ("agent_runs"."read_scope" in ('current_conversation','all_accessible') and ("agent_runs"."trigger" <> 'mention' or "agent_runs"."read_scope" = 'current_conversation')),
	CONSTRAINT "agent_runs_counters" CHECK ("agent_runs"."step_count" >= 0 and "agent_runs"."lease_epoch" >= 0 and "agent_runs"."state_version" >= 1 and "agent_runs"."input_tokens" >= 0 and "agent_runs"."output_tokens" >= 0 and "agent_runs"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"type" text NOT NULL,
	"tool_name" text,
	"status" text,
	"payload" jsonb,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_call_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"key_source" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"actual_model" text,
	"provider_request_id" text,
	"status" text NOT NULL,
	"day" text NOT NULL,
	"month" text NOT NULL,
	"price_version" text NOT NULL,
	"reserved_tokens" bigint NOT NULL,
	"reserved_cost" bigint NOT NULL,
	"actual_tokens" bigint,
	"actual_cost" bigint,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cached_tokens" bigint,
	"reasoning_tokens" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "ai_attempts_status" CHECK ("ai_call_attempts"."status" in ('reserved','started','settled','unknown','released'))
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"user_id" uuid NOT NULL,
	"day" text NOT NULL,
	"key_source" text NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"run_count" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "ai_usage_daily_user_id_day_key_source_pk" PRIMARY KEY("user_id","day","key_source")
);
--> statement-breakpoint
CREATE TABLE "budget_accounts" (
	"scope" text NOT NULL,
	"owner_key" text NOT NULL,
	"period_start" text NOT NULL,
	"limit_units" bigint NOT NULL,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"settled_units" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "budget_accounts_scope_owner_key_period_start_pk" PRIMARY KEY("scope","owner_key","period_start"),
	CONSTRAINT "budget_accounts_nonnegative" CHECK ("budget_accounts"."limit_units" >= 0 and "budget_accounts"."reserved_units" >= 0 and "budget_accounts"."settled_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_contexts" ADD CONSTRAINT "agent_contexts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_outputs" ADD CONSTRAINT "agent_run_outputs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_outputs" ADD CONSTRAINT "agent_run_outputs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_states" ADD CONSTRAINT "agent_run_states_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_delegation_id_execution_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."execution_delegations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_context_conversation_id_conversations_id_fk" FOREIGN KEY ("context_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_output_message_id_messages_id_fk" FOREIGN KEY ("output_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_regenerated_from_run_id_agent_runs_id_fk" FOREIGN KEY ("regenerated_from_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_call_attempts" ADD CONSTRAINT "ai_call_attempts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_user_created_idx" ON "agent_runs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_active_idx" ON "agent_runs" USING btree ("status","lease_until") WHERE "agent_runs"."status" in ('queued', 'running', 'awaiting_approval');--> statement-breakpoint
CREATE UNIQUE INDEX "agent_steps_run_index_uidx" ON "agent_steps" USING btree ("run_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_attempts_step_uidx" ON "ai_call_attempts" USING btree ("run_id","step_index","attempt_no");--> statement-breakpoint
CREATE INDEX "ai_attempts_user_period_idx" ON "ai_call_attempts" USING btree ("day","month");