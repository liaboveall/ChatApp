ALTER TYPE "public"."work_kind" ADD VALUE 'media';--> statement-breakpoint
CREATE TABLE "attachment_objects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"variant" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'staging' NOT NULL,
	"accounted" boolean DEFAULT false NOT NULL,
	"delete_after" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachment_objects_storageKey_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachment_objects_nonneg" CHECK ("attachment_objects"."size_bytes" >= 0 and "attachment_objects"."generation" >= 1),
	CONSTRAINT "attachment_objects_status" CHECK ("attachment_objects"."status" in ('staging','live','deleting','deleted'))
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"deleted_message_id" uuid,
	"purpose" text NOT NULL,
	"kind" text DEFAULT 'file' NOT NULL,
	"mime" text DEFAULT 'application/octet-stream' NOT NULL,
	"original_name" text NOT NULL,
	"raw_size_bytes" bigint DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"charged_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"generation" bigint DEFAULT 1 NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"privacy_class" "privacy_class" DEFAULT 'standard' NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"storage_key" text,
	"variants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thumbhash" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"position" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "attachments_storageKey_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachments_nonneg" CHECK ("attachments"."raw_size_bytes" >= 0 and "attachments"."size_bytes" >= 0 and "attachments"."charged_bytes" >= 0 and "attachments"."generation" >= 1 and "attachments"."version" >= 1),
	CONSTRAINT "attachments_purpose" CHECK ("attachments"."purpose" in ('message','avatar','conversation_avatar')),
	CONSTRAINT "attachments_kind" CHECK ("attachments"."kind" in ('image','video','audio','file')),
	CONSTRAINT "attachments_status" CHECK ("attachments"."status" in ('uploading','processing','ready','failed','deleting')),
	CONSTRAINT "attachments_ready" CHECK ("attachments"."status" <> 'ready' or ("attachments"."storage_key" is not null and "attachments"."sha256" ~ '^[0-9a-f]{64}$' and "attachments"."size_bytes" > 0 and "attachments"."charged_bytes" = "attachments"."size_bytes"))
);
--> statement-breakpoint
CREATE TABLE "message_mentions" (
	"message_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "message_mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "site_storage" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"budget_bytes" bigint DEFAULT 53687091200 NOT NULL,
	"uploads_blocked" boolean DEFAULT false NOT NULL,
	CONSTRAINT "site_storage_single" CHECK ("site_storage"."id" = 1),
	CONSTRAINT "site_storage_nonneg" CHECK ("site_storage"."used_bytes" >= 0 and "site_storage"."reserved_bytes" >= 0 and "site_storage"."budget_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "upload_reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"attachment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"site_reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"max_bytes" bigint NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_reservations_attachmentId_unique" UNIQUE("attachment_id"),
	CONSTRAINT "upload_reservations_nonneg" CHECK ("upload_reservations"."reserved_bytes" >= 0 and "upload_reservations"."site_reserved_bytes" >= 0 and "upload_reservations"."max_bytes" > 0 and "upload_reservations"."lease_epoch" >= 0),
	CONSTRAINT "upload_reservations_status" CHECK ("upload_reservations"."status" in ('reserved','uploaded','processing','settled','released'))
);
--> statement-breakpoint
ALTER TABLE "attachment_objects" ADD CONSTRAINT "attachment_objects_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_reservations" ADD CONSTRAINT "upload_reservations_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_reservations" ADD CONSTRAINT "upload_reservations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_objects_generation_variant" ON "attachment_objects" USING btree ("attachment_id","generation","variant");--> statement-breakpoint
CREATE INDEX "attachment_objects_delete_idx" ON "attachment_objects" USING btree ("status","delete_after");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachments_uploader_idx" ON "attachments" USING btree ("uploader_id","created_at");--> statement-breakpoint
CREATE INDEX "attachments_status_idx" ON "attachments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "message_mentions_user_idx" ON "message_mentions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "upload_reservations_user_key" ON "upload_reservations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "upload_reservations_expiry_idx" ON "upload_reservations" USING btree ("status","expires_at");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_avatar_attachment_id_attachments_id_fk" FOREIGN KEY ("avatar_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_attachment_id_attachments_id_fk" FOREIGN KEY ("avatar_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION validate_attachment_ready() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a attachments%ROWTYPE; item jsonb;
BEGIN
  SELECT * INTO a FROM attachments WHERE id = NEW.id;
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
CREATE CONSTRAINT TRIGGER attachments_ready_ledger AFTER INSERT OR UPDATE ON attachments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_attachment_ready();
--> statement-breakpoint
CREATE FUNCTION guard_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id AND NOT (NEW.status = 'deleting' AND NEW.message_id IS NULL AND NEW.deleted_message_id = OLD.message_id) THEN
    RAISE EXCEPTION 'attachment binding is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.message_id IS NOT NULL AND (NEW.purpose <> 'message' OR NEW.status <> 'ready') THEN
    RAISE EXCEPTION 'message attachment must be ready with message purpose' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attachments_binding BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION guard_attachment_binding();
