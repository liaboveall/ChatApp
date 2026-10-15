CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"epoch" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"snapshot_at" timestamp with time zone,
	"lease_until" timestamp with time zone NOT NULL,
	"manifest_key" text,
	"manifest_hash" text,
	"object_count" bigint,
	"journal_applied_seq" bigint,
	"journal_applied_hash" text,
	"offsite_verified_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "backup_runs_state" CHECK ("backup_runs"."status" in ('copying','uploading','succeeded','failed')),
	CONSTRAINT "backup_runs_lease_bound" CHECK ("backup_runs"."lease_until" <= "backup_runs"."started_at" + interval '2 hours'),
	CONSTRAINT "backup_runs_verified_success" CHECK ("backup_runs"."status" <> 'succeeded' or ("backup_runs"."manifest_key" is not null and "backup_runs"."manifest_hash" ~ '^[a-f0-9]{64}$' and "backup_runs"."offsite_verified_at" is not null and "backup_runs"."journal_applied_seq" >= 0 and "backup_runs"."journal_applied_hash" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
CREATE INDEX "backup_runs_barrier" ON "backup_runs" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_operations_system_action_target" ON "deletion_operations" USING btree ("action","target_key") WHERE "deletion_operations"."actor_id" is null;