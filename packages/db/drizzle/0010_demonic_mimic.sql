ALTER TABLE "ai_call_attempts" ADD COLUMN "http_status" integer;--> statement-breakpoint
ALTER TABLE "ai_call_attempts" ADD COLUMN "retry_after_seconds" integer;