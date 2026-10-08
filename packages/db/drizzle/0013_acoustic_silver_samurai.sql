ALTER TYPE "public"."work_kind" ADD VALUE 'embedding';--> statement-breakpoint
CREATE TABLE "agent_conversation_state" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"context_epoch" uuid NOT NULL,
	"key_source" text NOT NULL,
	"privacy_class" text NOT NULL,
	"source_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"summarized_through_seq" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"content" text,
	"source" text NOT NULL,
	"created_by_run_id" uuid,
	"privacy_class" text DEFAULT 'byok_private' NOT NULL,
	"content_version" bigint DEFAULT 1 NOT NULL,
	"source_manifest" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" vector,
	"model_version" text,
	"dimension" integer,
	"site_consent_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_memories_content" CHECK ("agent_memories"."content" is null or char_length("agent_memories"."content") between 1 and 500),
	CONSTRAINT "agent_memories_privacy" CHECK ("agent_memories"."privacy_class" in ('standard','byok_private')),
	CONSTRAINT "agent_memories_vector" CHECK ("agent_memories"."embedding" is null or vector_dims("agent_memories"."embedding") = "agent_memories"."dimension")
);
--> statement-breakpoint
CREATE TABLE "embedding_models" (
	"version" text PRIMARY KEY NOT NULL,
	"dimension" integer NOT NULL,
	"status" text NOT NULL,
	"backfill_cursor" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "embedding_models_dimension" CHECK ("embedding_models"."dimension" in (512, 1024)),
	CONSTRAINT "embedding_models_status" CHECK ("embedding_models"."status" in ('staging','active','retired'))
);
--> statement-breakpoint
CREATE TABLE "memory_embeddings" (
	"memory_id" uuid NOT NULL,
	"model_version" text NOT NULL,
	"content_version" bigint NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_embeddings_memory_id_model_version_pk" PRIMARY KEY("memory_id","model_version"),
	CONSTRAINT "memory_embeddings_dimension" CHECK (vector_dims("memory_embeddings"."embedding") = "memory_embeddings"."dimension" and "memory_embeddings"."dimension" in (512,1024))
);
--> statement-breakpoint
CREATE TABLE "message_embeddings" (
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"content_version" bigint NOT NULL,
	"model_version" text NOT NULL,
	"dimension" integer NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "message_embeddings_message_id_model_version_pk" PRIMARY KEY("message_id","model_version"),
	CONSTRAINT "message_embeddings_dimension" CHECK (vector_dims("message_embeddings"."embedding") = "message_embeddings"."dimension" and "message_embeddings"."dimension" in (512,1024))
);
--> statement-breakpoint
ALTER TABLE "agent_conversation_state" ADD CONSTRAINT "agent_conversation_state_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_memory_id_agent_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."agent_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD CONSTRAINT "memory_embeddings_model_version_embedding_models_version_fk" FOREIGN KEY ("model_version") REFERENCES "public"."embedding_models"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_embeddings" ADD CONSTRAINT "message_embeddings_model_version_embedding_models_version_fk" FOREIGN KEY ("model_version") REFERENCES "public"."embedding_models"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memories_user" ON "agent_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_memories_bge_hnsw" ON "agent_memories" USING hnsw (("embedding"::vector(512)) vector_cosine_ops) WHERE "agent_memories"."deleted_at" is null and "agent_memories"."model_version" = 'bge-small-zh-q8-75c43b06';--> statement-breakpoint
CREATE INDEX "agent_memories_qwen_hnsw" ON "agent_memories" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops) WHERE "agent_memories"."deleted_at" is null and "agent_memories"."model_version" = 'qwen3-06b-q8-c25a394d';--> statement-breakpoint
CREATE UNIQUE INDEX "embedding_models_one_active" ON "embedding_models" USING btree ("status") WHERE "embedding_models"."status" = 'active';--> statement-breakpoint
CREATE INDEX "memory_embeddings_bge_hnsw" ON "memory_embeddings" USING hnsw (("embedding"::vector(512)) vector_cosine_ops) WHERE "memory_embeddings"."model_version" = 'bge-small-zh-q8-75c43b06';--> statement-breakpoint
CREATE INDEX "memory_embeddings_qwen_hnsw" ON "memory_embeddings" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops) WHERE "memory_embeddings"."model_version" = 'qwen3-06b-q8-c25a394d';--> statement-breakpoint
CREATE INDEX "message_embeddings_conversation_seq" ON "message_embeddings" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "message_embeddings_bge_hnsw" ON "message_embeddings" USING hnsw (("embedding"::vector(512)) vector_cosine_ops) WHERE "message_embeddings"."model_version" = 'bge-small-zh-q8-75c43b06';--> statement-breakpoint
CREATE INDEX "message_embeddings_qwen_hnsw" ON "message_embeddings" USING hnsw (("embedding"::vector(1024)) vector_cosine_ops) WHERE "message_embeddings"."model_version" = 'qwen3-06b-q8-c25a394d';