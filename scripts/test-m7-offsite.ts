/** Bounded V-19 admission in approved private TEST buckets. Only this run's UUID prefix may be touched or cleaned. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { loadOffsiteTarget } from '../apps/server/src/config/offsite.ts'
import { createConditionalStore, OffsiteError } from '../apps/server/src/storage/conditional.ts'
import { getEnv, readEnvFile } from './lib/env-file.ts'

const runId = randomUUID()
const prefix = `m7-admission/${runId}/`
const directory = `.test-runs/m7/offsite/${runId}`
await mkdir(directory, { recursive: true, mode: 0o700 })
const env = await readEnvFile('.env.local')
const source: Record<string, string | undefined> = {}
for (const line of env.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) source[key] = getEnv(env, key)
}
const check = (value: unknown, code: string) => {
  if (!value) throw new Error(`probe:${code}`)
}
const bytes = (value: string) => new TextEncoder().encode(value)
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const results: { name: string; status: 'pass' | 'fail'; code?: string }[] = []
const owned: { store: ReturnType<typeof createConditionalStore>; key: string }[] = []
let cleanup = true
try {
  const journal = loadOffsiteTarget(source, 'DELETION_JOURNAL', 'test')
  const backup = loadOffsiteTarget(source, 'BACKUP', 'test')
  for (const [label, target] of [
    ['journal', journal],
    ['backup', backup],
  ] as const) {
    const store = createConditionalStore(target)
    const probe = async (name: string, run: () => Promise<void>) => {
      try {
        await run()
        results.push({ name: `${label}.${name}`, status: 'pass' })
      } catch (error) {
        results.push({
          name: `${label}.${name}`,
          status: 'fail',
          code:
            error instanceof OffsiteError
              ? error.code
              : error instanceof Error && error.message.startsWith('probe:')
                ? error.message
                : 'unexpected',
        })
      }
    }
    const key = `${prefix}head`
    owned.push({ store, key })
    await probe('create-read-private', async () => {
      check(await store.write(key, bytes('initial'), { absent: true }), 'create')
      const first = await store.read(key)
      check(first && hash(first.bytes) === hash(bytes('initial')), 'hash')
      const response = await fetch(`${target.endpoint}/${target.bucket}/${key}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
      // R2 rejects a missing Authorization header as 400/InvalidArgument. This proves only S3 access,
      // not whether an administrator enabled r2.dev or a custom public domain.
      const invalidUnsigned =
        response.status === 400 && /<Code>InvalidArgument<\/Code>/.test(await response.text())
      await response.body?.cancel().catch(() => undefined)
      check([401, 403].includes(response.status) || invalidUnsigned, 'unsigned-s3-rejected')
    })
    await probe('immutable-repeat', async () => {
      check(!(await store.write(key, bytes('overwrite'), { absent: true })), 'create-precondition')
      check(
        hash((await store.read(key))?.bytes ?? bytes('')) === hash(bytes('initial')),
        'unchanged',
      )
    })
    await probe('concurrent-cas-and-stale-writer', async () => {
      const head = await store.read(key)
      check(head, 'head-exists')
      if (!head) return
      const race = await Promise.all([
        store.write(key, bytes('writer-a'), { etag: head.etag }),
        store.write(key, bytes('writer-b'), { etag: head.etag }),
      ])
      check(race.filter(Boolean).length === 1, 'single-cas-winner')
      check(!(await store.write(key, bytes('stale'), { etag: head.etag })), 'stale-rejected')
      const current = await store.read(key)
      check(
        current && ['writer-a', 'writer-b'].includes(new TextDecoder().decode(current.bytes)),
        'winner-visible',
      )
    })
    await probe('unknown-write-reconciliation', async () => {
      const head = await store.read(key)
      check(head, 'head-exists')
      if (!head) return
      const uncertain = createConditionalStore(target, {
        fetch: (async (input, init) => {
          const response = await fetch(input, init)
          if (init?.method === 'PUT' && response.ok) {
            await response.body?.cancel()
            throw new Error('synthetic response loss after real commit')
          }
          return response
        }) as typeof fetch,
      })
      let unknown = false
      try {
        await uncertain.write(key, bytes('known-operation'), { etag: head.etag })
      } catch (error) {
        unknown = error instanceof OffsiteError && error.code === 'unavailable'
      }
      check(unknown, 'unknown-result')
      check(
        hash((await store.read(key))?.bytes ?? bytes('')) === hash(bytes('known-operation')),
        'reconciled-real-commit',
      )
    })
    await probe('complete-paginated-list', async () => {
      const expected = [key]
      for (let i = 0; i < 5; i++) {
        const item = `${prefix}item-${i}`
        owned.push({ store, key: item })
        check(await store.write(item, bytes(`payload-${i}`), { absent: true }), 'item-create')
        expected.push(item)
      }
      const found: string[] = []
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await store.list(prefix, cursor, 2)
        found.push(...page.keys)
        cursor = page.cursor
        if (cursor) {
          check(!cursors.has(cursor), 'cursor-loop')
          cursors.add(cursor)
        }
      } while (cursor)
      check(found.sort().join('\n') === expected.sort().join('\n'), 'complete-list')
      check(cursors.size >= 2, 'pagination-exercised')
    })
    await probe('credentials-confined-to-own-bucket', async () => {
      const other = label === 'journal' ? backup : journal
      const wrong = createConditionalStore({ ...target, bucket: other.bucket })
      const item = `${prefix}forbidden-${label}`
      // In case permission is broader than promised, retain cleanup ownership of this exact synthetic key.
      owned.push({ store: createConditionalStore(other), key: item })
      let denied = false
      try {
        await wrong.write(item, bytes('permission-probe'), { absent: true })
      } catch (error) {
        denied = error instanceof OffsiteError && error.code === 'denied'
      }
      check(denied, 'cross-bucket-write-denied')
    })
  }
} catch {
  results.push({ name: 'configuration', status: 'fail', code: 'invalid-or-unavailable' })
} finally {
  for (const { store, key } of owned) {
    if (!key.startsWith(prefix)) {
      cleanup = false
      continue
    }
    try {
      await store.delete(key)
      if (await store.read(key)) cleanup = false
    } catch {
      cleanup = false
    }
  }
  const report = {
    runId,
    startedFor: 'V-19 admission only',
    publicDomainConfiguration: 'requires-owner-confirmation',
    sourceHostLossRestore: 'not-tested',
    prefix,
    results,
    cleanup,
  }
  await writeFile(`${directory}/result.json`, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  })
  for (const result of results)
    console.log(`${result.status} ${result.name}${result.code ? ` (${result.code})` : ''}`)
  console.log(`cleanup=${cleanup}; evidence=${directory}/result.json`)
}
process.exitCode = results.some((result) => result.status === 'fail') || !cleanup ? 1 : 0
