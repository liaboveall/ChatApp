-- Forward repair of 0019, which has already been applied to the test database.
CREATE OR REPLACE FUNCTION chatapp_guard_deletion_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; parent_run record;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END
  )) WHERE value <> 'null'::jsonb LOOP
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
