-- A pending attachment cannot be rebound through an avatar pointer, including by late/direct writers.
CREATE FUNCTION chatapp_guard_avatar_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.avatar_attachment_id IS DISTINCT FROM OLD.avatar_attachment_id THEN
    PERFORM chatapp_assert_unfrozen_deletion('attachment', NEW.avatar_attachment_id);
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_avatar_deletion BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION chatapp_guard_avatar_deletion();
--> statement-breakpoint
CREATE TRIGGER conversations_avatar_deletion BEFORE INSERT OR UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION chatapp_guard_avatar_deletion();
--> statement-breakpoint
-- Account/conversation deletion also freezes child content: a delayed callback cannot publish new run state or keys.
CREATE FUNCTION chatapp_guard_deletion_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; parent_run record;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END
  ) WHERE value <> 'null'::jsonb LOOP
    PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'user_id')::uuid);
    PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'created_by')::uuid);
    PERFORM chatapp_assert_unfrozen_deletion('conversation', (item->>'conversation_id')::uuid);
    PERFORM chatapp_assert_unfrozen_deletion('message', (item->>'message_id')::uuid);
    PERFORM chatapp_assert_unfrozen_deletion('memory', (item->>'memory_id')::uuid);
    IF item->>'run_id' IS NOT NULL THEN
      SELECT user_id, conversation_id INTO parent_run FROM agent_runs WHERE id = (item->>'run_id')::uuid;
      IF FOUND THEN
        PERFORM chatapp_assert_unfrozen_deletion('user', parent_run.user_id);
        PERFORM chatapp_assert_unfrozen_deletion('conversation', parent_run.conversation_id);
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'work_items' THEN
      PERFORM chatapp_assert_unfrozen_deletion('attachment', (item->>'entity_id')::uuid);
      PERFORM chatapp_assert_unfrozen_deletion('conversation', (item->>'entity_id')::uuid);
      PERFORM chatapp_assert_unfrozen_deletion('message', (item->>'entity_id')::uuid);
      PERFORM chatapp_assert_unfrozen_deletion('memory', (item->>'entity_id')::uuid);
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE name text; BEGIN
  FOREACH name IN ARRAY ARRAY['sessions','accounts','passkeys','authorization_origins','execution_delegations','user_ai_keys','push_subscriptions','notifications','reminders','scheduled_messages','conversation_members','conversation_bans','registration_invites','auth_challenges','agent_effects','agent_steps','agent_run_states','agent_approvals','agent_run_outputs','agent_conversation_state','agent_contexts','work_items','message_embeddings','memory_embeddings'] LOOP
    EXECUTE format('CREATE TRIGGER deletion_children BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION chatapp_guard_deletion_children()', name);
  END LOOP;
END $$;
