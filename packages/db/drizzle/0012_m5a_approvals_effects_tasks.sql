ALTER TYPE "public"."work_kind" ADD VALUE 'scheduled';--> statement-breakpoint
CREATE SEQUENCE "public"."user_ai_key_revisions" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "agent_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_call_id" text NOT NULL,
	"approval_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb,
	"edited_args" jsonb,
	"final_args" jsonb,
	"args_hash" text,
	"required" boolean NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"state_version" bigint NOT NULL,
	"resume_seq" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_approvals_status" CHECK ("agent_approvals"."status" in ('pending','approved','rejected','expired')),
	CONSTRAINT "agent_approvals_decided" CHECK (("agent_approvals"."status" = 'pending') = ("agent_approvals"."decided_at" is null)),
	CONSTRAINT "agent_approvals_frozen" CHECK ("agent_approvals"."status" <> 'approved' or "agent_approvals"."args_hash" is not null)
);
--> statement-breakpoint
CREATE TABLE "agent_effects" (
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"tool_name" text NOT NULL,
	"args_hash" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_effects_run_id_step_index_pk" PRIMARY KEY("run_id","step_index")
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"text" text,
	"remind_at" timestamp with time zone NOT NULL,
	"scheduled_timezone" text NOT NULL,
	"scheduled_local_time" text NOT NULL,
	"scheduled_offset_minutes" integer NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"privacy_class" text DEFAULT 'standard' NOT NULL,
	"created_by_run_id" uuid,
	"delegation_id" uuid,
	"sent_message_id" uuid,
	"error_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"content_purged_at" timestamp with time zone,
	CONSTRAINT "reminders_status" CHECK ("reminders"."status" in ('scheduled','sent','cancelled','failed')),
	CONSTRAINT "reminders_text" CHECK (("reminders"."text" is null and "reminders"."status" <> 'scheduled') or ("reminders"."text" is not null and char_length("reminders"."text") between 1 and 1000)),
	CONSTRAINT "reminders_finished" CHECK (("reminders"."status" = 'scheduled') = ("reminders"."finished_at" is null)),
	CONSTRAINT "reminders_privacy" CHECK ("reminders"."privacy_class" in ('standard','byok_private'))
);
--> statement-breakpoint
CREATE TABLE "scheduled_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"body" text,
	"send_at" timestamp with time zone NOT NULL,
	"scheduled_timezone" text NOT NULL,
	"scheduled_local_time" text NOT NULL,
	"scheduled_offset_minutes" integer NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by_run_id" uuid,
	"delegation_id" uuid,
	"sent_message_id" uuid,
	"error_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"content_purged_at" timestamp with time zone,
	CONSTRAINT "scheduled_messages_status" CHECK ("scheduled_messages"."status" in ('scheduled','sent','cancelled','failed')),
	CONSTRAINT "scheduled_messages_body" CHECK (("scheduled_messages"."body" is null and "scheduled_messages"."status" <> 'scheduled') or ("scheduled_messages"."body" is not null and char_length("scheduled_messages"."body") between 1 and 5000)),
	CONSTRAINT "scheduled_messages_finished" CHECK (("scheduled_messages"."status" = 'scheduled') = ("scheduled_messages"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "user_ai_keys" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"key_ciphertext" text NOT NULL,
	"key_nonce" text NOT NULL,
	"key_version" smallint NOT NULL,
	"revision" bigint NOT NULL,
	"key_last4" text NOT NULL,
	"status" text NOT NULL,
	"invalid_reason" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_ai_keys_provider" CHECK ("user_ai_keys"."provider" = 'deepseek'),
	CONSTRAINT "user_ai_keys_status" CHECK ("user_ai_keys"."status" in ('active','invalid')),
	CONSTRAINT "user_ai_keys_last4" CHECK (char_length("user_ai_keys"."key_last4") = 4)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "agent_purpose" text;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_step_id_agent_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."agent_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_approvals" ADD CONSTRAINT "agent_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_effects" ADD CONSTRAINT "agent_effects_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_delegation_id_execution_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."execution_delegations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_sent_message_id_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_delegation_id_execution_delegations_id_fk" FOREIGN KEY ("delegation_id") REFERENCES "public"."execution_delegations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_messages" ADD CONSTRAINT "scheduled_messages_sent_message_id_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_keys" ADD CONSTRAINT "user_ai_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approvals_step_uidx" ON "agent_approvals" USING btree ("run_id","step_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_approvals_call_uidx" ON "agent_approvals" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "agent_approvals_user_status_idx" ON "agent_approvals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "agent_approvals_pending_expiry_idx" ON "agent_approvals" USING btree ("expires_at") WHERE "agent_approvals"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("remind_at") WHERE "reminders"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "reminders_user_created_idx" ON "reminders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "scheduled_messages_due_idx" ON "scheduled_messages" USING btree ("send_at") WHERE "scheduled_messages"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "scheduled_messages_user_created_idx" ON "scheduled_messages" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_key_source_created_idx" ON "agent_runs" USING btree ("key_source","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_reminders_uidx" ON "conversations" USING btree ("owner_id") WHERE "conversations"."agent_purpose" = 'reminders';--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_purpose" CHECK ("conversations"."agent_purpose" is null or ("conversations"."kind" = 'agent' and "conversations"."agent_purpose" = 'reminders' and "conversations"."panel_for_conversation_id" is null));