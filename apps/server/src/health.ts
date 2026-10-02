/** Readiness: Postgres, Valkey and object storage must all answer within a short deadline (docs/03 section 9). */
import type { Db } from '@chatapp/db'
import { sql } from 'drizzle-orm'
import type { Valkey } from './lib/valkey.ts'
import type { BlobStore } from './storage/s3.ts'

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export function createReadiness(parts: {
  db: Db
  valkey: Valkey
  blobs: BlobStore
  timeoutMs?: number
}) {
  const timeoutMs = parts.timeoutMs ?? 2_000
  return async (): Promise<boolean> => {
    const checks = await Promise.allSettled([
      within(parts.db.execute(sql`select 1`), timeoutMs),
      within(parts.valkey.ping(), timeoutMs),
      within(parts.blobs.ping(), timeoutMs),
    ])
    return checks.every((check) => check.status === 'fulfilled')
  }
}
