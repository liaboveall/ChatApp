/** Real R2 encrypted-chain admission. Not a backup, host-loss, credential-revocation or full V-19 acceptance claim. */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { loadOffsiteTarget } from '../apps/server/src/config/offsite.ts'
import {
  EncryptedDeletionJournal,
  JOURNAL_GENESIS,
  JournalError,
} from '../apps/server/src/domain/deletion-journal.ts'
import { createConditionalStore } from '../apps/server/src/storage/conditional.ts'
import { getEnv, readEnvFile } from './lib/env-file.ts'
import { cleanupOffsiteRun } from './lib/offsite-cleanup.ts'

const runId = randomUUID()
const prefix = `m7-journal-admission/${runId}/`
const directory = `.test-runs/m7/journal/${runId}`
await mkdir(directory, { recursive: true, mode: 0o700 })
const env = await readEnvFile('.env.local')
const source: Record<string, string | undefined> = {}
for (const line of env.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) source[key] = getEnv(env, key)
}
const results: { name: string; pass: boolean }[] = []
let cleanup = true
const target = loadOffsiteTarget(source, 'DELETION_JOURNAL', 'test')
const store = createConditionalStore(target)
const options = {
  store,
  prefix,
  writerEpoch: randomUUID(),
  currentKeyVersion: 1,
  keys: new Map([[1, randomBytes(32)]]),
}
const journal = new EncryptedDeletionJournal(options)
const input = () => ({
  operationId: randomUUID(),
  actorId: randomUUID(),
  acceptedAt: new Date().toISOString(),
  intent: {
    action: 'memory_delete' as const,
    target: { id: randomUUID(), userId: randomUUID(), contentVersion: 1 },
  },
})
const check = (condition: unknown) => {
  if (!condition) throw new Error('check failed')
}
const probe = async (name: string, run: () => Promise<void>) => {
  try {
    await run()
    results.push({ name, pass: true })
  } catch {
    results.push({ name, pass: false })
  }
}
const genesis = { seq: 0, hash: JOURNAL_GENESIS }
try {
  await journal.initialize()
  await probe('encrypted-immutable-chain-and-duplicate-operation', async () => {
    const operation = input()
    const one = await journal.append(operation)
    check((await journal.append(operation)).hash === one.hash)
    check((await journal.readSince(genesis)).length === 1)
    const encrypted = await store.read(`${prefix}records/${one.hash}`)
    check(
      encrypted && !new TextDecoder().decode(encrypted.bytes).includes(operation.intent.target.id),
    )
  })
  await probe('same-operation-concurrent-writers', async () => {
    const operation = input()
    const two = new EncryptedDeletionJournal(options)
    const accepted = await Promise.all([journal.append(operation), two.append(operation)])
    check(accepted[0]?.hash === accepted[1]?.hash)
    check(
      (await journal.readSince(genesis)).filter(
        (item) => item.record.operationId === operation.operationId,
      ).length === 1,
    )
  })
  await probe('head-response-lost-after-real-r2-commit', async () => {
    let lost = false
    const uncertain = createConditionalStore(target, {
      fetch: (async (url, init) => {
        const result = await fetch(url, init)
        if (
          !lost &&
          init?.method === 'PUT' &&
          new URL(String(url)).pathname.endsWith('/head') &&
          result.ok
        ) {
          lost = true
          await result.body?.cancel()
          throw new Error('synthetic lost head response')
        }
        return result
      }) as typeof fetch,
    })
    const operation = input()
    const accepted = await new EncryptedDeletionJournal({ ...options, store: uncertain }).append(
      operation,
    )
    check(lost && accepted.record.operationId === operation.operationId)
    check(
      (await journal.readSince(genesis)).filter(
        (item) => item.record.operationId === operation.operationId,
      ).length === 1,
    )
  })
  await probe('missing-record-blocks-restore', async () => {
    const head = (await journal.head()).head
    if (!head.recordKey) throw new Error('missing record fixture')
    const object = await store.read(head.recordKey)
    if (!object) throw new Error('missing fixture')
    await store.delete(head.recordKey)
    let rejected = false
    try {
      await journal.readSince(genesis)
    } catch (error) {
      rejected = error instanceof JournalError && error.code === 'integrity'
    }
    // Restore ONLY the exact bytes of this run's owned immutable fixture, even when assertion fails.
    check(await store.write(head.recordKey, object.bytes, { absent: true }))
    check(rejected)
  })
  await probe('key-rotation-and-stale-writer-fencing', async () => {
    const nextEpoch = randomUUID()
    await journal.rotateWriter(options.writerEpoch, nextEpoch)
    let fenced = false
    try {
      await journal.append(input())
    } catch (error) {
      fenced = error instanceof JournalError && error.code === 'stale_writer'
    }
    check(fenced)
    const rotated = new EncryptedDeletionJournal({
      ...options,
      writerEpoch: nextEpoch,
      currentKeyVersion: 2,
      keys: new Map([...options.keys, [2, randomBytes(32)]]),
    })
    await rotated.append(input())
    const restored = await rotated.readSince(genesis)
    check(restored.length === 4)
  })
} catch {
  results.push({ name: 'initialization-or-unexpected-failure', pass: false })
} finally {
  try {
    await cleanupOffsiteRun(store, prefix)
  } catch {
    cleanup = false
  }
  await writeFile(
    `${directory}/result.json`,
    `${JSON.stringify({ runId, prefix, scope: 'real encrypted-chain admission only', credentialRevocation: 'not-tested', sourceHostLossRestore: 'not-tested', results, cleanup }, null, 2)}\n`,
    { mode: 0o600 },
  )
  for (const item of results) console.log(`${item.pass ? 'pass' : 'fail'} ${item.name}`)
  console.log(`cleanup=${cleanup}; evidence=${directory}/result.json`)
}
process.exitCode = cleanup && results.every((item) => item.pass) ? 0 : 1
