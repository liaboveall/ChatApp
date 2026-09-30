-- Runs once, when the Postgres data volume is first initialized.
-- Dev database: chatapp. Test database: chatapp_test (same extensions).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE DATABASE chatapp_test OWNER chatapp;
\connect chatapp_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
