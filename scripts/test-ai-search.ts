#!/usr/bin/env bun
/** V-15: real EXPLAINs against synthetic, session-local tables in the test database. */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SQL } from 'bun'
import { getEnv, readEnvFile } from './lib/env-file.ts'

const env = await readEnvFile('.env.local')
const url = getEnv(env, 'DATABASE_URL_TEST')
if (!url || !new URL(url).pathname.endsWith('_test')) {
  console.error('m4-search: DATABASE_URL_TEST must target a test database')
  process.exit(1)
}
const sql = new SQL({
  url,
  max: 1,
  connection: { statement_timeout: 15_000, application_name: 'chatapp-m4-v15' },
})
const runId = randomUUID()
const dir = join('.test-runs', 'm4', runId)
await mkdir(dir, { recursive: true, mode: 0o700 })
try {
  await sql`CREATE TEMP TABLE m4_search_probe (id integer PRIMARY KEY, conversation_id integer NOT NULL, seq integer NOT NULL, body text NOT NULL)`
  await sql`INSERT INTO m4_search_probe SELECT n, n % 20, n, CASE WHEN n % 101 = 0 THEN '项目将在周五上线，部署计划已经确认。' ELSE '常规讨论记录，编号' || n::text END FROM generate_series(1, 50000) AS n`
  await sql`CREATE INDEX m4_search_probe_body_idx ON m4_search_probe USING gin (body gin_trgm_ops)`
  await sql`CREATE INDEX m4_search_probe_scope_idx ON m4_search_probe (conversation_id, seq DESC)`
  await sql`ANALYZE m4_search_probe`
  const explain = async (label: string, statement: string) => {
    const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`)
    return { label, plan: rows[0]['QUERY PLAN'] }
  }
  const evidence = [
    await explain(
      'two_character_unscoped',
      "SELECT id FROM m4_search_probe WHERE body ILIKE '%上线%' ORDER BY seq DESC LIMIT 50",
    ),
    await explain(
      'two_character_current_conversation',
      "SELECT id FROM m4_search_probe WHERE conversation_id = 1 AND seq > 10000 AND body ILIKE '%上线%' ORDER BY seq DESC LIMIT 50",
    ),
    await explain(
      'four_character_trigram',
      "SELECT id FROM m4_search_probe WHERE body ILIKE '%部署计划%' ORDER BY seq DESC LIMIT 50",
    ),
  ]
  const matches =
    await sql`SELECT COUNT(*)::int AS count FROM m4_search_probe WHERE body ILIKE '%上线%'`
  if (matches[0].count !== 495) throw new Error('synthetic query count mismatch')
  await writeFile(
    join(dir, 'search.json'),
    JSON.stringify(
      { runId, rows: 50000, conversations: 20, twoCharacterMatches: matches[0].count, evidence },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  for (const item of evidence) console.log(`m4-search: ${item.label}: ${JSON.stringify(item.plan)}`)
  console.log(`m4-search: artifact ${join(dir, 'search.json')}`)
} catch {
  console.error('m4-search: experiment failed; no persistent application data was changed')
  process.exitCode = 1
} finally {
  await sql.close()
}
