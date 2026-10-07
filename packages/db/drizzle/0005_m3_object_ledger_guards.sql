CREATE FUNCTION validate_attachment_object_ready() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a attachments%ROWTYPE; item jsonb;
BEGIN
  SELECT * INTO a FROM attachments WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.attachment_id ELSE NEW.attachment_id END;
  IF NOT FOUND OR a.status <> 'ready' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM attachment_objects o WHERE o.attachment_id = a.id AND o.generation = a.generation AND o.variant = 'original' AND o.storage_key = a.storage_key AND o.status = 'live' AND o.accounted AND o.size_bytes = a.size_bytes AND o.sha256 = a.sha256) THEN
    RAISE EXCEPTION 'ready attachment requires live original ledger' USING ERRCODE = '23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_each(a.variants) LOOP
    IF NOT EXISTS (SELECT 1 FROM attachment_objects o WHERE o.attachment_id = a.id AND o.generation = a.generation AND o.storage_key = item->>'key' AND o.status = 'live' AND o.accounted) THEN
      RAISE EXCEPTION 'ready attachment requires live variants' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attachment_objects_ready_ledger AFTER INSERT OR UPDATE OR DELETE ON attachment_objects DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_attachment_object_ready();
--> statement-breakpoint
CREATE FUNCTION guard_attachment_object_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.attachment_id, OLD.generation, OLD.variant, OLD.storage_key) IS DISTINCT FROM ROW(NEW.attachment_id, NEW.generation, NEW.variant, NEW.storage_key) OR (OLD.status = 'deleted' AND NEW.status <> 'deleted') THEN
    RAISE EXCEPTION 'object identity and deletion tombstone are immutable' USING ERRCODE = '23514';
  END IF;
  IF (OLD.status <> 'staging' OR OLD.accounted) AND ROW(OLD.size_bytes, OLD.sha256) IS DISTINCT FROM ROW(NEW.size_bytes, NEW.sha256) THEN
    RAISE EXCEPTION 'settled object dimensions are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attachment_objects_identity BEFORE UPDATE ON attachment_objects FOR EACH ROW EXECUTE FUNCTION guard_attachment_object_identity();
