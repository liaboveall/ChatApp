-- Extensions are installed by the owner account; the dev init script has already created them in both
-- databases, and production creates them here. pg_trgm: search (M4). vector: embeddings (M5b).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
