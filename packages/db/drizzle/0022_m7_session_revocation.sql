-- Forward extension: keep content freezes while permitting session expiry and ordinary sign-out.
CREATE OR REPLACE FUNCTION chatapp_guard_deletion_children() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb; parent_run record; isolated boolean; revocation boolean := false;
BEGIN
  -- Expiry and ordinary sign-out reduce authority. They cannot recreate content or credentials on a frozen account.
  IF TG_TABLE_NAME = 'sessions' AND TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME = 'authorization_origins' AND TG_OP = 'UPDATE'
    AND ((to_jsonb(NEW)->>'ended_at') IS NOT NULL OR (to_jsonb(NEW)->>'revoked_at') IS NOT NULL)
    AND (to_jsonb(NEW) - ARRAY['ended_at','revoked_at','revoke_reason']) = (to_jsonb(OLD) - ARRAY['ended_at','revoked_at','revoke_reason'])
  THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM app_settings
    WHERE key = 'restore_state' AND value->>'mode' = 'isolated'
      AND value->>'epoch' = nullif(current_setting('chatapp.restore_isolation', true), '')
  ) INTO isolated;
  IF isolated THEN
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME IN ('sessions','passkeys','user_ai_keys','push_subscriptions','auth_challenges') THEN
      revocation := true;
    ELSIF TG_OP = 'UPDATE' THEN
      item := to_jsonb(NEW);
      CASE TG_TABLE_NAME
        WHEN 'accounts' THEN revocation := item->>'password' IS NULL AND item->>'access_token' IS NULL AND item->>'refresh_token' IS NULL AND item->>'id_token' IS NULL;
        WHEN 'authorization_origins' THEN revocation := item->>'revoked_at' IS NOT NULL AND item->>'revoke_reason' = 'restore';
        WHEN 'execution_delegations' THEN revocation := item->>'status' = 'revoked' AND item->>'revoked_at' IS NOT NULL;
        WHEN 'reminders' THEN revocation := item->>'status' = 'cancelled' AND item->>'text' IS NULL AND item->>'finished_at' IS NOT NULL AND item->>'content_purged_at' IS NOT NULL;
        WHEN 'scheduled_messages' THEN revocation := item->>'status' = 'cancelled' AND item->>'body' IS NULL AND item->>'finished_at' IS NOT NULL AND item->>'content_purged_at' IS NOT NULL;
        WHEN 'work_items' THEN revocation := item->>'status' = 'uncertain' AND item->>'last_error_code' = 'RESTORE_ISOLATED' AND item->>'lease_until' IS NULL;
        ELSE NULL;
      END CASE;
    END IF;
  END IF;
  IF coalesce(revocation, false) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
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
