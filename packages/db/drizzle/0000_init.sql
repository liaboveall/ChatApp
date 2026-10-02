CREATE TYPE "public"."account_source" AS ENUM('registration', 'cli', 'bootstrap');--> statement-breakpoint
CREATE TYPE "public"."activation_status" AS ENUM('pending', 'active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."challenge_purpose" AS ENUM('verify_email', 'reset_password');--> statement-breakpoint
CREATE TYPE "public"."delegation_purpose" AS ENUM('agent_run', 'reminder', 'scheduled_message');--> statement-breakpoint
CREATE TYPE "public"."delegation_status" AS ENUM('active', 'revoked', 'completed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."idempotency_state" AS ENUM('pending', 'completed');--> statement-breakpoint
CREATE TYPE "public"."origin_revoke_reason" AS ENUM('device_revoked', 'other_devices_revoked', 'all_devices_revoked', 'password_changed', 'password_reset', 'banned', 'account_deleted', 'registration_cleanup', 'restore');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('reserved', 'account_created', 'confirmed', 'released');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."work_kind" AS ENUM('realtime', 'email');--> statement-breakpoint
CREATE TYPE "public"."work_status" AS ENUM('pending', 'leased', 'running', 'retry', 'done', 'dead', 'uncertain');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"registration_id" uuid,
	"purpose" "challenge_purpose" NOT NULL,
	"email_hash" text NOT NULL,
	"auth_epoch" bigint NOT NULL,
	"restore_epoch" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"delivery_ciphertext" text,
	"delivery_nonce" text,
	"delivery_key_version" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenges_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "challenges_single_end" CHECK (not ("auth_challenges"."consumed_at" is not null and "auth_challenges"."revoked_at" is not null)),
	CONSTRAINT "challenges_delivery_all_or_none" CHECK (("auth_challenges"."delivery_ciphertext" is null) = ("auth_challenges"."delivery_nonce" is null) and ("auth_challenges"."delivery_ciphertext" is null) = ("auth_challenges"."delivery_key_version" is null))
);
--> statement-breakpoint
CREATE TABLE "authorization_origins" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"restore_epoch" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" "origin_revoke_reason",
	CONSTRAINT "origins_revoke_pair" CHECK (("authorization_origins"."revoked_at" is null) = ("authorization_origins"."revoke_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "execution_delegations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"parent_id" uuid,
	"auth_epoch" bigint NOT NULL,
	"restore_epoch" text NOT NULL,
	"purpose" "delegation_purpose" NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"args_hash" text,
	"status" "delegation_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delegations_revoked_has_time" CHECK ("execution_delegations"."status" <> 'revoked' or "execution_delegations"."revoked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_key" text NOT NULL,
	"operation" text NOT NULL,
	"target_key" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"state" "idempotency_state" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_key_length" CHECK (char_length("idempotency_records"."key") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "passkeys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"aaguid" text,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "registration_invite_uses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"invite_id" uuid NOT NULL,
	"inviter_id" uuid NOT NULL,
	"user_id" uuid,
	"email_normalized" text,
	"request_hash" text,
	"status" "registration_status" DEFAULT 'reserved' NOT NULL,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "registration_invite_uses_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "registration_uses_email_kept" CHECK ("registration_invite_uses"."status" = 'released' or "registration_invite_uses"."email_normalized" is not null),
	CONSTRAINT "registration_uses_lease_nonneg" CHECK ("registration_invite_uses"."lease_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "registration_invites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"note" text,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_invites_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invites_use_count_range" CHECK ("registration_invites"."use_count" >= 0 and ("registration_invites"."max_uses" is null or "registration_invites"."use_count" <= "registration_invites"."max_uses")),
	CONSTRAINT "invites_max_uses_positive" CHECK ("registration_invites"."max_uses" is null or "registration_invites"."max_uses" >= 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"auth_epoch" bigint NOT NULL,
	"authorization_origin_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "username_reservations" (
	"username" text PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"reserved_until" timestamp with time zone,
	CONSTRAINT "username_reservations_lower" CHECK ("username_reservations"."username" = lower("username_reservations"."username"))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"username" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"registration_id" uuid,
	"activation_status" "activation_status" DEFAULT 'pending' NOT NULL,
	"account_source" "account_source" DEFAULT 'registration' NOT NULL,
	"auth_epoch" bigint DEFAULT 0 NOT NULL,
	"user_change_seq" bigint DEFAULT 0 NOT NULL,
	"profile_version" bigint DEFAULT 1 NOT NULL,
	"me_version" bigint DEFAULT 1 NOT NULL,
	"avatar_attachment_id" uuid,
	"is_bot" boolean DEFAULT false NOT NULL,
	"bio" text,
	"invite_quota" integer DEFAULT 5 NOT NULL,
	"invites_used" integer DEFAULT 0 NOT NULL,
	"invited_by_id" uuid,
	"username_changed_at" timestamp with time zone,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_quota_bytes" bigint,
	"ai_daily_tokens" integer,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_registration_id_unique" UNIQUE("registration_id"),
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_username_format" CHECK ("users"."username" ~ '^[a-z0-9_]{3,20}$'),
	CONSTRAINT "users_name_length" CHECK (char_length("users"."name") between 1 and 160),
	CONSTRAINT "users_bio_length" CHECK ("users"."bio" is null or char_length("users"."bio") <= 200),
	CONSTRAINT "users_invites_used_range" CHECK ("users"."invites_used" >= 0 and ("users"."role" = 'admin' or "users"."invites_used" <= "users"."invite_quota")),
	CONSTRAINT "users_invite_quota_nonneg" CHECK ("users"."invite_quota" >= 0),
	CONSTRAINT "users_storage_nonneg" CHECK ("users"."storage_used_bytes" >= 0 and "users"."storage_reserved_bytes" >= 0 and ("users"."storage_quota_bytes" is null or "users"."storage_quota_bytes" >= 0)),
	CONSTRAINT "users_epochs_nonneg" CHECK ("users"."auth_epoch" >= 0 and "users"."user_change_seq" >= 0),
	CONSTRAINT "users_active_needs_verified_email" CHECK ("users"."activation_status" <> 'active' or "users"."email_verified"),
	CONSTRAINT "users_registration_link" CHECK (("users"."account_source" = 'registration') = ("users"."registration_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" "work_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"entity_id" uuid,
	"entity_version" bigint,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "work_status" DEFAULT 'pending' NOT NULL,
	"delivery_seq" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "work_items_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "work_items_counters_nonneg" CHECK ("work_items"."delivery_seq" >= 0 and "work_items"."attempts" >= 0 and "work_items"."lease_epoch" >= 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_registration_id_registration_invite_uses_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registration_invite_uses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_origins" ADD CONSTRAINT "authorization_origins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_delegations" ADD CONSTRAINT "execution_delegations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_delegations" ADD CONSTRAINT "execution_delegations_origin_id_authorization_origins_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."authorization_origins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_delegations" ADD CONSTRAINT "execution_delegations_parent_id_execution_delegations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."execution_delegations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invite_uses" ADD CONSTRAINT "registration_invite_uses_invite_id_registration_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."registration_invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invite_uses" ADD CONSTRAINT "registration_invite_uses_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invite_uses" ADD CONSTRAINT "registration_invite_uses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_invites" ADD CONSTRAINT "registration_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_authorization_origin_id_authorization_origins_id_fk" FOREIGN KEY ("authorization_origin_id") REFERENCES "public"."authorization_origins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "username_reservations" ADD CONSTRAINT "username_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_registration_id_registration_invite_uses_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registration_invite_uses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_uidx" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_credential_user_uidx" ON "accounts" USING btree ("user_id") WHERE "accounts"."provider_id" = 'credential';--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "challenges_one_live_uidx" ON "auth_challenges" USING btree ("user_id","purpose") WHERE "auth_challenges"."consumed_at" is null and "auth_challenges"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "challenges_user_idx" ON "auth_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "challenges_expires_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "origins_user_idx" ON "authorization_origins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "delegations_user_status_idx" ON "execution_delegations" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "delegations_origin_status_idx" ON "execution_delegations" USING btree ("origin_id","status");--> statement-breakpoint
CREATE INDEX "delegations_active_expiry_idx" ON "execution_delegations" USING btree ("expires_at") WHERE "execution_delegations"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_uidx" ON "idempotency_records" USING btree ("actor_key","operation","target_key","key");--> statement-breakpoint
CREATE INDEX "idempotency_expires_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "registration_uses_invite_idx" ON "registration_invite_uses" USING btree ("invite_id");--> statement-breakpoint
CREATE INDEX "registration_uses_inviter_idx" ON "registration_invite_uses" USING btree ("inviter_id");--> statement-breakpoint
CREATE INDEX "registration_uses_open_expiry_idx" ON "registration_invite_uses" USING btree ("expires_at") WHERE "registration_invite_uses"."status" in ('reserved', 'account_created');--> statement-breakpoint
CREATE INDEX "invites_created_by_idx" ON "registration_invites" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_origin_idx" ON "sessions" USING btree ("authorization_origin_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "users_invited_by_idx" ON "users" USING btree ("invited_by_id");--> statement-breakpoint
CREATE INDEX "users_pending_created_idx" ON "users" USING btree ("created_at") WHERE "users"."activation_status" = 'pending';--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "work_items_ready_idx" ON "work_items" USING btree ("status","available_at") WHERE "work_items"."status" in ('pending', 'retry');--> statement-breakpoint
CREATE INDEX "work_items_lease_idx" ON "work_items" USING btree ("lease_until") WHERE "work_items"."status" in ('leased', 'running');--> statement-breakpoint
CREATE INDEX "work_items_finished_idx" ON "work_items" USING btree ("finished_at") WHERE "work_items"."finished_at" is not null;