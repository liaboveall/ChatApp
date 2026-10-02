-- Until D-107, values written through Drizzle's jsonb() were stored as jsonb strings that hold JSON text: the driver encoded
-- them a second time. Rewrite every such value as the JSON it contains. Rows written by SQL defaults are already real
-- objects and stay as they are; a string whose content is not valid JSON is left untouched instead of aborting the migration.
UPDATE "users" SET "settings" = ("settings" #>> '{}')::jsonb WHERE jsonb_typeof("settings") = 'string' AND pg_input_is_valid("settings" #>> '{}', 'jsonb');--> statement-breakpoint
UPDATE "app_settings" SET "value" = ("value" #>> '{}')::jsonb WHERE jsonb_typeof("value") = 'string' AND pg_input_is_valid("value" #>> '{}', 'jsonb');--> statement-breakpoint
UPDATE "audit_logs" SET "metadata" = ("metadata" #>> '{}')::jsonb WHERE jsonb_typeof("metadata") = 'string' AND pg_input_is_valid("metadata" #>> '{}', 'jsonb');--> statement-breakpoint
UPDATE "work_items" SET "payload" = ("payload" #>> '{}')::jsonb WHERE jsonb_typeof("payload") = 'string' AND pg_input_is_valid("payload" #>> '{}', 'jsonb');
