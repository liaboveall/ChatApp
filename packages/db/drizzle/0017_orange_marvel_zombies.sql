CREATE TABLE "deletion_journal_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"applied_seq" bigint DEFAULT 0 NOT NULL,
	"applied_hash" text DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deletion_journal_state_singleton" CHECK ("deletion_journal_state"."id" = 1 and "deletion_journal_state"."applied_seq" >= 0 and "deletion_journal_state"."applied_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "deletion_locks" (
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	CONSTRAINT "deletion_locks_target_type_target_id_pk" PRIMARY KEY("target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "deletion_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_key" text NOT NULL,
	"intent" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"journal_epoch" uuid,
	"journal_seq" bigint,
	"journal_hash" text,
	"created_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "deletion_operations_state" CHECK ("deletion_operations"."status" in ('prepared','journaled','applied','failed')),
	CONSTRAINT "deletion_operations_journal_complete" CHECK (("deletion_operations"."journal_seq" is null and "deletion_operations"."journal_hash" is null and "deletion_operations"."journal_epoch" is null and "deletion_operations"."status" in ('prepared','failed')) or ("deletion_operations"."journal_seq" > 0 and "deletion_operations"."journal_hash" ~ '^[a-f0-9]{64}$' and "deletion_operations"."journal_epoch" is not null and "deletion_operations"."status" in ('journaled','applied'))),
	CONSTRAINT "deletion_operations_applied" CHECK (("deletion_operations"."status" = 'applied') = ("deletion_operations"."applied_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "deletion_locks" ADD CONSTRAINT "deletion_locks_operation_id_deletion_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."deletion_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_operations" ADD CONSTRAINT "deletion_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deletion_locks_operation" ON "deletion_locks" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_operations_actor_action_target" ON "deletion_operations" USING btree ("actor_id","action","target_key");--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_operations_journal_seq" ON "deletion_operations" USING btree ("journal_seq");--> statement-breakpoint
CREATE INDEX "deletion_operations_pending" ON "deletion_operations" USING btree ("status","created_at");
--> statement-breakpoint
-- Freeze at the database boundary too: late embeddings, model output and attachment rebindings cannot expand an intent.
CREATE FUNCTION chatapp_assert_unfrozen_deletion(kind text, entity_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF entity_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM deletion_locks l JOIN deletion_operations o ON o.id = l.operation_id
    WHERE l.target_type = kind AND l.target_id = entity_id
      AND NOT (o.status = 'journaled' AND o.id::text = coalesce(current_setting('chatapp.deletion_operation', true), ''))
  ) THEN
    RAISE EXCEPTION 'deletion pending' USING ERRCODE = '23514', CONSTRAINT = 'deletion_target_frozen';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION chatapp_guard_frozen_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END
  )) WHERE value <> 'null'::jsonb LOOP
    CASE TG_TABLE_NAME
      WHEN 'messages' THEN
        PERFORM chatapp_assert_unfrozen_deletion('message', (item->>'id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('conversation', (item->>'conversation_id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'sender_id')::uuid);
      WHEN 'agent_memories' THEN
        PERFORM chatapp_assert_unfrozen_deletion('memory', (item->>'id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'user_id')::uuid);
      WHEN 'attachments' THEN
        PERFORM chatapp_assert_unfrozen_deletion('attachment', (item->>'id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('message', (item->>'message_id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('conversation', (item->>'conversation_id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'uploader_id')::uuid);
      WHEN 'conversations' THEN
        PERFORM chatapp_assert_unfrozen_deletion('conversation', (item->>'id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'owner_id')::uuid);
      WHEN 'users' THEN
        PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'id')::uuid);
      WHEN 'agent_runs' THEN
        PERFORM chatapp_assert_unfrozen_deletion('conversation', (item->>'conversation_id')::uuid);
        PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'user_id')::uuid);
    END CASE;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER messages_frozen_deletion BEFORE INSERT OR UPDATE OR DELETE ON messages FOR EACH ROW EXECUTE FUNCTION chatapp_guard_frozen_deletion();
--> statement-breakpoint
CREATE TRIGGER memories_frozen_deletion BEFORE INSERT OR UPDATE OR DELETE ON agent_memories FOR EACH ROW EXECUTE FUNCTION chatapp_guard_frozen_deletion();
--> statement-breakpoint
CREATE TRIGGER attachments_frozen_deletion BEFORE INSERT OR UPDATE OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION chatapp_guard_frozen_deletion();
--> statement-breakpoint
CREATE TRIGGER conversations_frozen_deletion BEFORE INSERT OR UPDATE OR DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION chatapp_guard_frozen_deletion();
--> statement-breakpoint
CREATE TRIGGER users_frozen_deletion BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION chatapp_guard_frozen_deletion();
--> statement-breakpoint
CREATE TRIGGER agent_runs_frozen_deletion BEFORE INSERT OR UPDATE OR DELETE ON agent_runs FOR EACH ROW EXECUTE FUNCTION chatapp_guard_frozen_deletion();
