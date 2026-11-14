/**
 * A transaction that holds an advisory lock while its owner waits on something that is not the database (the offsite
 * journal, object storage). The database client closes any connection that was quiet for its idle timeout, in a
 * transaction or not: the transaction fails, the lock is gone while the guarded work is still running, and whatever was
 * queued behind that connection fails with it. On 2026-11-14 this stopped deletions, the dispatcher and running
 * assistant requests in production every 35 seconds. `keepAlive` is what prevents it.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createDatabase, type Database } from '@chatapp/db/client'
import { sql } from 'drizzle-orm'
import { keepAlive } from '../../src/domain/tx.ts'
import { testConfig } from '../support/env.ts'

let quick: Database
let observer: Database

beforeAll(() => {
  const url = testConfig().databaseUrl
  // The production client waits 30 seconds; two are enough to show the same thing.
  quick = createDatabase(url, { max: 2, idleTimeoutSeconds: 2, applicationName: 'keep-alive-test' })
  observer = createDatabase(url, { max: 1, applicationName: 'keep-alive-observer' })
})
afterAll(async () => {
  await quick.close()
  await observer.close()
})

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const LOCK = sql`hashtext('chatapp.test.keep-alive')`
/** Whether somebody else holds the lock right now, seen from another connection. */
async function held(): Promise<boolean> {
  return await observer.db.transaction(async (tx) => {
    const rows = await tx.execute<{ free: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK}) as free`,
    )
    return rows[0]?.free !== true
  })
}

test('without it, a guard that waits past the idle timeout loses its connection and its lock', async () => {
  let lockSeenWhileWorking: boolean | undefined
  const guard = quick.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`)
    await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    await pause(3200)
    // The work is still going on here, but the lock that was to cover it is already gone.
    lockSeenWhileWorking = await held()
  })
  await expect(guard).rejects.toMatchObject({ code: 'ERR_POSTGRES_IDLE_TIMEOUT' })
  // The transaction has failed, but what it was guarding carries on by itself for another second.
  await pause(1600)
  expect(lockSeenWhileWorking).toBe(false)
})

test('with it, the guard outlives the idle timeout, keeps its lock throughout and ends normally', async () => {
  const seen: boolean[] = []
  const result = await quick.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK})`)
    await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`)
    return await keepAlive(
      tx,
      async () => {
        for (let i = 0; i < 4; i += 1) {
          await pause(900)
          seen.push(await held())
        }
        return 'done'
      },
      500,
    )
  })
  expect(result).toBe('done')
  expect(seen).toEqual([true, true, true, true])
  // The lock is released with the transaction, not earlier and not later.
  expect(await held()).toBe(false)
})

test('the heartbeat stops with the work, also when the work throws', async () => {
  let beats = 0
  const tx = {
    execute: async () => {
      beats += 1
      return []
    },
  }
  await expect(
    keepAlive(
      tx as never,
      async () => {
        await pause(120)
        throw new Error('work failed')
      },
      25,
    ),
  ).rejects.toThrow('work failed')
  const counted = beats
  expect(counted).toBeGreaterThan(1)
  await pause(120)
  expect(beats).toBe(counted)
})
