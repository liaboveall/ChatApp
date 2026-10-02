import { defineConfig } from 'drizzle-kit'

// `generate` and `check` only read the schema and the migrations folder; the URL is used by `studio`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? 'postgres://localhost/chatapp' },
  strict: true,
  verbose: true,
})
