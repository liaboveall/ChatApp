CREATE TYPE "public"."conversation_change_kind" AS ENUM('message_created', 'message_edited', 'message_recalled', 'message_deleted');--> statement-breakpoint
CREATE TYPE "public"."conversation_kind" AS ENUM('channel', 'group', 'dm', 'agent');--> statement-breakpoint
CREATE TYPE "public"."conversation_state" AS ENUM('active', 'hidden', 'archived', 'removed');--> statement-breakpoint
CREATE TYPE "public"."execution_source" AS ENUM('interactive', 'offline_replay', 'agent_effect', 'scheduled', 'system');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('user', 'system', 'agent');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('sent', 'streaming', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mute_mode" AS ENUM('off', 'until', 'forever');--> statement-breakpoint
CREATE TYPE "public"."notify_level" AS ENUM('all', 'mentions', 'none');--> statement-breakpoint
CREATE TYPE "public"."privacy_class" AS ENUM('standard', 'byok_private');--> statement-breakpoint
CREATE TYPE "public"."user_change_entity" AS ENUM('conversation', 'message_hidden', 'me');--> statement-breakpoint
CREATE TYPE "public"."user_change_operation" AS ENUM('upsert', 'remove');--> statement-breakpoint
CREATE TABLE "conversation_bans" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"banned_by" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_bans_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "conversation_bans_reason_length" CHECK ("conversation_bans"."reason" is null or char_length("conversation_bans"."reason") <= 400)
);
--> statement-breakpoint
CREATE TABLE "conversation_changes" (
	"conversation_id" uuid NOT NULL,
	"change_seq" bigint NOT NULL,
	"message_id" uuid,
	"kind" "conversation_change_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_changes_conversation_id_change_seq_pk" PRIMARY KEY("conversation_id","change_seq"),
	CONSTRAINT "conversation_changes_seq_positive" CHECK ("conversation_changes"."change_seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "conversation_invites" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"max_uses" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_invites_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "conversation_invites_use_count_range" CHECK ("conversation_invites"."use_count" >= 0 and ("conversation_invites"."max_uses" is null or "conversation_invites"."use_count" <= "conversation_invites"."max_uses")),
	CONSTRAINT "conversation_invites_max_uses_positive" CHECK ("conversation_invites"."max_uses" is null or "conversation_invites"."max_uses" >= 1)
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"membership_id" uuid DEFAULT uuidv7() NOT NULL,
	"state_version" bigint DEFAULT 0 NOT NULL,
	"visible_from_seq" bigint DEFAULT 0 NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"notify_level" "notify_level" NOT NULL,
	"mute_mode" "mute_mode" DEFAULT 'off' NOT NULL,
	"muted_until" timestamp with time zone,
	"silenced_until" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"hidden_at" timestamp with time zone,
	CONSTRAINT "conversation_members_conversation_id_user_id_pk" PRIMARY KEY("conversation_id","user_id"),
	CONSTRAINT "conversation_members_membership_id_unique" UNIQUE("membership_id"),
	CONSTRAINT "conversation_members_seq_order" CHECK ("conversation_members"."visible_from_seq" >= 0 and "conversation_members"."last_read_seq" >= "conversation_members"."visible_from_seq" and "conversation_members"."state_version" >= 0),
	CONSTRAINT "conversation_members_mute_pair" CHECK (("conversation_members"."mute_mode" = 'until') = ("conversation_members"."muted_until" is not null))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" "conversation_kind" NOT NULL,
	"name" text,
	"description" text,
	"avatar_attachment_id" uuid,
	"owner_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"panel_for_conversation_id" uuid,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"last_change_seq" bigint DEFAULT 0 NOT NULL,
	"metadata_version" bigint DEFAULT 1 NOT NULL,
	"membership_version" bigint DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"member_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"change_log_floor" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_name_by_kind" CHECK (("conversations"."kind" = 'dm' and "conversations"."name" is null) or ("conversations"."kind" <> 'dm' and "conversations"."name" is not null and char_length("conversations"."name") between 1 and 200)),
	CONSTRAINT "conversations_description_length" CHECK ("conversations"."description" is null or char_length("conversations"."description") <= 1000),
	CONSTRAINT "conversations_dm_has_no_owner" CHECK ("conversations"."kind" <> 'dm' or "conversations"."owner_id" is null),
	CONSTRAINT "conversations_panel_only_agent" CHECK ("conversations"."panel_for_conversation_id" is null or "conversations"."kind" = 'agent'),
	CONSTRAINT "conversations_counters" CHECK ("conversations"."last_seq" >= 0 and "conversations"."last_change_seq" >= "conversations"."last_seq" and "conversations"."metadata_version" >= 1 and "conversations"."membership_version" >= 0 and "conversations"."member_count" >= 0 and "conversations"."change_log_floor" >= 0 and "conversations"."change_log_floor" <= "conversations"."last_change_seq")
);
--> statement-breakpoint
CREATE TABLE "dm_pairs" (
	"user_low" uuid NOT NULL,
	"user_high" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	CONSTRAINT "dm_pairs_user_low_user_high_pk" PRIMARY KEY("user_low","user_high"),
	CONSTRAINT "dm_pairs_conversation_id_unique" UNIQUE("conversation_id"),
	CONSTRAINT "dm_pairs_ordered" CHECK ("dm_pairs"."user_low" < "dm_pairs"."user_high")
);
--> statement-breakpoint
CREATE TABLE "message_hidden" (
	"user_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"hidden_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_hidden_user_id_message_id_pk" PRIMARY KEY("user_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"change_seq" bigint NOT NULL,
	"sender_id" uuid,
	"kind" "message_kind" NOT NULL,
	"status" "message_status" DEFAULT 'sent' NOT NULL,
	"body" text,
	"reply_to_id" uuid,
	"client_id" uuid,
	"request_hash" text,
	"content_version" bigint DEFAULT 1 NOT NULL,
	"stream_revision" bigint DEFAULT 0 NOT NULL,
	"execution_source" "execution_source" NOT NULL,
	"privacy_class" "privacy_class" DEFAULT 'standard' NOT NULL,
	"context_epoch" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_at" timestamp with time zone,
	"recalled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_sender_unless_system" CHECK ("messages"."kind" = 'system' or "messages"."sender_id" is not null),
	CONSTRAINT "messages_body_length" CHECK ("messages"."body" is null or char_length("messages"."body") <= 20000),
	CONSTRAINT "messages_seq_order" CHECK ("messages"."seq" >= 1 and "messages"."change_seq" >= "messages"."seq"),
	CONSTRAINT "messages_cleared_when_gone" CHECK (("messages"."recalled_at" is null and "messages"."deleted_at" is null) or "messages"."body" is null),
	CONSTRAINT "messages_one_ending" CHECK ("messages"."recalled_at" is null or "messages"."deleted_at" is null),
	CONSTRAINT "messages_deleted_by_pair" CHECK (("messages"."deleted_at" is null) = ("messages"."deleted_by" is null)),
	CONSTRAINT "messages_versions_nonneg" CHECK ("messages"."content_version" >= 1 and "messages"."stream_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_changes" (
	"user_id" uuid NOT NULL,
	"change_seq" bigint NOT NULL,
	"entity_type" "user_change_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"operation" "user_change_operation" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_changes_user_id_change_seq_pk" PRIMARY KEY("user_id","change_seq"),
	CONSTRAINT "user_changes_seq_positive" CHECK ("user_changes"."change_seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "user_conversation_states" (
	"user_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"membership_id" uuid,
	"state" "conversation_state" DEFAULT 'active' NOT NULL,
	"viewer_version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_conversation_states_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id"),
	CONSTRAINT "user_conversation_states_version_nonneg" CHECK ("user_conversation_states"."viewer_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "change_log_floor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_bans" ADD CONSTRAINT "conversation_bans_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_bans" ADD CONSTRAINT "conversation_bans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_bans" ADD CONSTRAINT "conversation_bans_banned_by_users_id_fk" FOREIGN KEY ("banned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_changes" ADD CONSTRAINT "conversation_changes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_invites" ADD CONSTRAINT "conversation_invites_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_invites" ADD CONSTRAINT "conversation_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_panel_for_conversation_id_conversations_id_fk" FOREIGN KEY ("panel_for_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_pairs" ADD CONSTRAINT "dm_pairs_user_low_users_id_fk" FOREIGN KEY ("user_low") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_pairs" ADD CONSTRAINT "dm_pairs_user_high_users_id_fk" FOREIGN KEY ("user_high") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_pairs" ADD CONSTRAINT "dm_pairs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_hidden" ADD CONSTRAINT "message_hidden_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_hidden" ADD CONSTRAINT "message_hidden_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_changes" ADD CONSTRAINT "user_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_conversation_states" ADD CONSTRAINT "user_conversation_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_bans_user_idx" ON "conversation_bans" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversation_changes_created_idx" ON "conversation_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "conversation_invites_conversation_idx" ON "conversation_invites" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_invites_creator_idx" ON "conversation_invites" USING btree ("created_by","conversation_id");--> statement-breakpoint
CREATE INDEX "conversation_members_user_idx" ON "conversation_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_members_one_owner_uidx" ON "conversation_members" USING btree ("conversation_id") WHERE "conversation_members"."role" = 'owner';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_name_uidx" ON "conversations" USING btree (lower(normalize("name", NFKC))) WHERE "conversations"."kind" = 'channel' and "conversations"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "conversations_kind_archived_idx" ON "conversations" USING btree ("kind","archived_at");--> statement-breakpoint
CREATE INDEX "conversations_channel_name_trgm_idx" ON "conversations" USING gin ("name" gin_trgm_ops) WHERE "conversations"."kind" = 'channel';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_panel_uidx" ON "conversations" USING btree ("owner_id","panel_for_conversation_id") WHERE "conversations"."panel_for_conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "conversations_owner_archived_idx" ON "conversations" USING btree ("owner_id") WHERE "conversations"."archived_at" is not null;--> statement-breakpoint
CREATE INDEX "dm_pairs_high_idx" ON "dm_pairs" USING btree ("user_high");--> statement-breakpoint
CREATE INDEX "message_hidden_message_idx" ON "message_hidden" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_conversation_seq_uidx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "messages_conversation_change_idx" ON "messages" USING btree ("conversation_id","change_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_sender_client_uidx" ON "messages" USING btree ("sender_id","client_id") WHERE "messages"."client_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_reply_to_idx" ON "messages" USING btree ("reply_to_id") WHERE "messages"."reply_to_id" is not null;--> statement-breakpoint
CREATE INDEX "user_changes_created_idx" ON "user_changes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "user_conversation_states_conversation_idx" ON "user_conversation_states" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "user_conversation_states_removed_idx" ON "user_conversation_states" USING btree ("updated_at") WHERE "user_conversation_states"."state" = 'removed';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_change_floor_range" CHECK ("users"."change_log_floor" >= 0 and "users"."change_log_floor" <= "users"."user_change_seq");--> statement-breakpoint
-- INV-23 and INV-04 (docs/04): a live channel or group has exactly one owner member and owner_id names that member; a
-- direct message has exactly two members. Written by hand: drizzle-kit does not model triggers. The check runs when the
-- transaction commits, so the statements that create or hand over a conversation may pass through states that would not
-- be valid on their own (transfer demotes the old owner first, then promotes the new one).
CREATE FUNCTION "chatapp_check_conversation"("target" uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  conv RECORD;
  owners integer;
  owner_user uuid;
  member_total integer;
BEGIN
  SELECT "kind", "owner_id", "archived_at" INTO conv FROM "conversations" WHERE "id" = "target";
  IF NOT FOUND THEN
    RETURN; -- being deleted together with its members
  END IF;
  IF conv."kind" IN ('channel', 'group') AND conv."archived_at" IS NULL THEN
    SELECT count(*)::integer INTO owners FROM "conversation_members"
      WHERE "conversation_id" = "target" AND "role" = 'owner';
    SELECT "user_id" INTO owner_user FROM "conversation_members"
      WHERE "conversation_id" = "target" AND "role" = 'owner' LIMIT 1;
    IF owners <> 1 OR owner_user IS DISTINCT FROM conv."owner_id" THEN
      RAISE EXCEPTION 'conversation % must have exactly one owner member matching owner_id', "target"
        USING ERRCODE = '23514', CONSTRAINT = 'conversations_owner_consistent';
    END IF;
  ELSIF conv."kind" = 'dm' THEN
    SELECT count(*)::integer INTO member_total FROM "conversation_members" WHERE "conversation_id" = "target";
    IF member_total <> 2 THEN
      RAISE EXCEPTION 'direct message % must have exactly two members', "target"
        USING ERRCODE = '23514', CONSTRAINT = 'conversations_dm_two_members';
    END IF;
  END IF;
END
$$;--> statement-breakpoint
CREATE FUNCTION "chatapp_conversation_trigger"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'conversations' THEN
    PERFORM "chatapp_check_conversation"(NEW."id");
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM "chatapp_check_conversation"(OLD."conversation_id");
  ELSE
    PERFORM "chatapp_check_conversation"(NEW."conversation_id");
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "conversations_integrity" AFTER INSERT OR UPDATE OF "kind", "owner_id", "archived_at" ON "conversations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "chatapp_conversation_trigger"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "conversation_members_integrity" AFTER INSERT OR UPDATE OF "role" OR DELETE ON "conversation_members" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "chatapp_conversation_trigger"();