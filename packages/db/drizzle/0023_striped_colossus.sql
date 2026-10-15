CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid,
	"conversation_id" uuid,
	"reporter_id" uuid,
	"visible_from_seq" bigint NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"resolution_note" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_message_reporter" UNIQUE("message_id","reporter_id"),
	CONSTRAINT "reports_reason" CHECK ("reports"."reason" in ('spam','abuse','illegal','other')),
	CONSTRAINT "reports_status" CHECK ("reports"."status" in ('open','resolved','dismissed')),
	CONSTRAINT "reports_bounds" CHECK ("reports"."version" >= 1 and "reports"."visible_from_seq" >= 0 and ("reports"."details" is null or length("reports"."details") <= 1000) and ("reports"."resolution_note" is null or length("reports"."resolution_note") <= 1000))
);
--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_handled_by_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_status_created" ON "reports" USING btree ("status","created_at");
--> statement-breakpoint
CREATE FUNCTION chatapp_guard_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item jsonb;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END
  )) WHERE value <> 'null'::jsonb LOOP
    PERFORM chatapp_assert_unfrozen_deletion('user', (item->>'reporter_id')::uuid);
    PERFORM chatapp_assert_unfrozen_deletion('message', (item->>'message_id')::uuid);
    PERFORM chatapp_assert_unfrozen_deletion('conversation', (item->>'conversation_id')::uuid);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER reports_deletion_guard BEFORE INSERT OR UPDATE OR DELETE ON reports
FOR EACH ROW EXECUTE FUNCTION chatapp_guard_report();
