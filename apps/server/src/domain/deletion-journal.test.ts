import { describe, expect, test } from 'bun:test'
import { randomBytes, randomUUID } from 'node:crypto'
import type { BackupManifest } from '@chatapp/contracts'
import type { ConditionalStore } from '../storage/conditional.ts'
import { EncryptedDeletionJournal, JOURNAL_GENESIS } from './deletion-journal.ts'

class Store implements ConditionalStore {
  readonly objects = new Map<string, { bytes: Uint8Array; etag: string }>()
  revision = 0
  loseHeadResponse = false
  failHead = false
  failRecord = false
  failDeleteKey: string | null = null
  async read(key: string) {
    return this.objects.get(key) ?? null
  }
  async write(key: string, bytes: Uint8Array, condition: { etag: string } | { absent: true }) {
    if ((this.failHead && key.endsWith('/head')) || (this.failRecord && key.includes('/records/')))
      throw new Error('synthetic unavailable')
    const prior = this.objects.get(key)
    if ('etag' in condition ? prior?.etag !== condition.etag : prior !== undefined) return false
    this.objects.set(key, { bytes: bytes.slice(), etag: String(++this.revision) })
    if (this.loseHeadResponse && key.endsWith('/head')) {
      this.loseHeadResponse = false
      throw new Error('synthetic response lost after commit')
    }
    return true
  }
  async list(prefix: string) {
    return { keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)) }
  }
  async delete(key: string) {
    if (key === this.failDeleteKey) throw new Error('synthetic GC failure')
    this.objects.delete(key)
  }
}
const intent = () => ({
  action: 'memory_delete' as const,
  target: { id: randomUUID(), userId: randomUUID(), contentVersion: 1 },
})
const operation = () => ({
  operationId: randomUUID(),
  actorId: randomUUID(),
  intent: intent(),
  acceptedAt: new Date().toISOString(),
})
function fixture() {
  const store = new Store()
  const keys = new Map([[1, randomBytes(32)]])
  const writerEpoch = randomUUID()
  const options = { store, prefix: 'journal/test/', writerEpoch, currentKeyVersion: 1, keys }
  return { store, keys, options, journal: new EncryptedDeletionJournal(options) }
}
const genesis = { seq: 0, hash: JOURNAL_GENESIS }
const inventory = (anchor: typeof genesis): { snapshotId: string; manifest: BackupManifest } => ({
  snapshotId: randomBytes(32).toString('hex'),
  manifest: {
    format: 1,
    runId: randomUUID(),
    epoch: randomUUID(),
    applicationSha: 'a'.repeat(40),
    schemaHash: 'b'.repeat(64),
    snapshotAt: new Date().toISOString(),
    journal: anchor,
    database: { size: 1, sha256: 'c'.repeat(64) },
    objects: [],
    keyVersions: [1],
    recoveryFiles: [{ name: 'keys.json', sha256: 'd'.repeat(64) }],
  },
})
const oldOperation = () => ({
  ...operation(),
  acceptedAt: new Date(Date.now() - 36 * 86_400_000).toISOString(),
})

describe('independent encrypted deletion journal', () => {
  test('missing head blocks restore; explicit initialization cannot replace an existing writer', async () => {
    const { journal, options } = fixture()
    await expect(journal.readSince(genesis)).rejects.toThrow('journal_uninitialized')
    await journal.initialize()
    const stale = new EncryptedDeletionJournal({ ...options, writerEpoch: randomUUID() })
    await expect(stale.initialize()).rejects.toThrow('journal_stale_writer')
    expect(await journal.readSince(genesis)).toEqual([])
  })
  test('duplicate operation is accepted once and different frozen parameters conflict', async () => {
    const { journal } = fixture()
    await journal.initialize()
    const input = operation()
    const first = await journal.append(input)
    expect(await journal.append(input)).toEqual(first)
    await expect(journal.append({ ...input, intent: intent() })).rejects.toThrow('journal_conflict')
    expect((await journal.head()).head.seq).toBe(1)
  })
  test('two same-epoch dispatchers cannot fork the trusted head; duplicate racing writes deduplicate', async () => {
    const { journal, options } = fixture()
    await journal.initialize()
    const other = new EncryptedDeletionJournal(options)
    const input = operation()
    const race = await Promise.all([journal.append(input), other.append(input)])
    expect(race[0]).toEqual(race[1])
    await Promise.all([journal.append(operation()), other.append(operation())])
    const accepted = await journal.readSince(genesis)
    expect(accepted.map((item) => item.record.seq)).toEqual([1, 2, 3])
    expect(new Set(accepted.map((item) => item.record.operationId)).size).toBe(3)
  })
  test('head response lost after commit is reconciled using the original operation id', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    store.loseHeadResponse = true
    const input = operation()
    const accepted = await journal.append(input)
    expect(accepted.record.operationId).toBe(input.operationId)
    expect((await journal.readSince(genesis)).length).toBe(1)
  })
  test('orphan candidates are not accepted; retry after the head recovers appends the same logical operation', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    const input = operation()
    store.failHead = true
    await expect(journal.append(input)).rejects.toThrow('journal_contended')
    expect(
      [...store.objects.keys()].filter((key) => key.includes('/records/')).length,
    ).toBeGreaterThan(0)
    expect(await journal.readSince(genesis)).toEqual([])
    store.failHead = false
    await journal.append(input)
    expect((await journal.readSince(genesis)).map((item) => item.record.operationId)).toEqual([
      input.operationId,
    ])
  })
  test('candidate failure leaves head unchanged and must not count as successful deletion', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    store.failRecord = true
    await expect(journal.append(operation())).rejects.toThrow('journal_integrity')
    expect((await journal.head()).head.seq).toBe(0)
  })
  test('missing or altered encrypted record blocks complete replay', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    await journal.append(operation())
    const accepted = await journal.append(operation())
    const key = `journal/test/records/${accepted.hash}`
    const object = store.objects.get(key)
    if (!object) throw new Error('missing fixture')
    store.objects.set(key, { ...object, bytes: new Uint8Array([1, 2, 3]) })
    await expect(journal.readSince(genesis)).rejects.toThrow('journal_integrity')
    store.objects.delete(key)
    await expect(journal.readSince(genesis)).rejects.toThrow('journal_integrity')
  })
  test('head authentication, wrong key, missing key version and namespace substitution all fail closed', async () => {
    const { journal, options, store } = fixture()
    await journal.initialize()
    await journal.append(operation())
    await expect(
      new EncryptedDeletionJournal({ ...options, keys: new Map([[1, randomBytes(32)]]) }).head(),
    ).rejects.toThrow('journal_integrity')
    await expect(
      new EncryptedDeletionJournal({
        ...options,
        currentKeyVersion: 2,
        keys: new Map([[2, randomBytes(32)]]),
      }).head(),
    ).rejects.toThrow('journal_key_missing')
    const head = store.objects.get('journal/test/head')
    if (!head) throw new Error('missing fixture')
    store.objects.set('journal/other/head', head)
    await expect(
      new EncryptedDeletionJournal({ ...options, prefix: 'journal/other/' }).head(),
    ).rejects.toThrow('journal_integrity')
    const envelope = JSON.parse(Buffer.from(head.bytes).toString())
    envelope.ciphertext = envelope.ciphertext.slice(0, -2) + 'AA'
    store.objects.set('journal/test/head', {
      ...head,
      bytes: Buffer.from(JSON.stringify(envelope)),
    })
    await expect(journal.head()).rejects.toThrow('journal_integrity')
  })
  test('backup anchor is matched exactly; accepted history replays even without local operation rows', async () => {
    const { journal } = fixture()
    await journal.initialize()
    const first = await journal.append(operation())
    const second = await journal.append(operation())
    expect(await journal.readSince({ seq: 1, hash: first.hash })).toEqual([second])
    await expect(journal.readSince({ seq: 1, hash: JOURNAL_GENESIS })).rejects.toThrow(
      'journal_integrity',
    )
    await expect(journal.readSince({ seq: 3, hash: second.hash })).rejects.toThrow(
      'journal_integrity',
    )
  })
  test('writer rotation fences the old writer and key rotation retains the restore window', async () => {
    const { journal, options, keys } = fixture()
    await journal.initialize()
    await journal.append(operation())
    const nextEpoch = randomUUID()
    await journal.rotateWriter(options.writerEpoch, nextEpoch)
    await expect(journal.append(operation())).rejects.toThrow('journal_stale_writer')
    const next = new EncryptedDeletionJournal({
      ...options,
      writerEpoch: nextEpoch,
      currentKeyVersion: 2,
      keys: new Map([...keys, [2, randomBytes(32)]]),
    })
    await next.append(operation())
    expect((await next.readSince(genesis)).map((item) => item.record.seq)).toEqual([1, 2])
  })
  test('journal rejects body and credential fields rather than stripping them', async () => {
    const { journal } = fixture()
    await journal.initialize()
    const input = operation()
    const tainted = {
      ...input,
      intent: { ...input.intent, target: { ...input.intent.target, body: 'sensitive' } },
    }
    await expect(journal.append(tainted)).rejects.toThrow()
    expect((await journal.head()).head.seq).toBe(0)
  })

  test('authenticated truncation respects every retained backup and keeps appends, retries and suffix recovery valid after old records are physically removed', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    const firstInput = oldOperation(),
      first = await journal.append(firstInput)
    const secondInput = oldOperation(),
      second = await journal.append(secondInput)
    const third = await journal.append(operation())
    const oldest = { seq: 1, hash: first.hash },
      newer = { seq: 2, hash: second.hash }
    const result = await journal.checkpoint({ seq: 3, hash: third.hash }, [
      inventory(newer),
      inventory(oldest),
    ])
    expect(result).toEqual({ floor: oldest, deleted: 1 })
    expect(store.objects.has(`journal/test/records/${first.hash}`)).toBe(false)
    expect(await journal.readSince(oldest)).toEqual([second, third])
    await expect(journal.readSince(genesis)).rejects.toThrow('journal_integrity')
    await expect(journal.append(firstInput)).rejects.toThrow('journal_conflict')
    expect(await journal.append(secondInput)).toEqual(second)
    const fourth = await journal.append(operation())
    expect(fourth.record.seq).toBe(4)
    expect((await journal.readSince(oldest)).map((item) => item.record.seq)).toEqual([2, 3, 4])
    await expect(
      journal.append({ ...operation(), preparedAt: firstInput.acceptedAt }),
    ).rejects.toThrow('journal_conflict')
  })

  test('an old retained snapshot delays GC; a missing, forged or incomplete inventory cannot authorize truncation', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    const first = await journal.append(oldOperation()),
      anchor = { seq: 1, hash: first.hash }
    expect(await journal.checkpoint(anchor, [inventory(genesis), inventory(anchor)])).toEqual({
      floor: genesis,
      deleted: 0,
    })
    await expect(journal.checkpoint(anchor, [])).rejects.toThrow('journal_integrity')
    await expect(
      journal.checkpoint(anchor, [inventory({ seq: 1, hash: JOURNAL_GENESIS })]),
    ).rejects.toThrow('journal_integrity')
    expect(store.objects.has(`journal/test/records/${first.hash}`)).toBe(true)
    expect((await journal.head()).head.checkpoint).toBeUndefined()
  })

  test('35-day retention measures actual acceptance, not the earlier preparation time', async () => {
    const { journal } = fixture()
    await journal.initialize()
    const first = await journal.append({ ...operation(), preparedAt: oldOperation().acceptedAt })
    const anchor = { seq: 1, hash: first.hash }
    expect(await journal.checkpoint(anchor, [inventory(anchor)])).toEqual({
      floor: genesis,
      deleted: 0,
    })
  })

  test('lost checkpoint CAS response and interrupted object GC remain recoverable and retry without reading deleted history', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    const first = await journal.append(oldOperation()),
      second = await journal.append(oldOperation()),
      latest = await journal.append(operation())
    const floor = { seq: 2, hash: second.hash },
      applied = { seq: 3, hash: latest.hash }
    const catalog = [inventory(floor)]
    store.loseHeadResponse = true
    store.failDeleteKey = `journal/test/records/${second.hash}`
    await expect(journal.checkpoint(applied, catalog)).rejects.toThrow('synthetic GC failure')
    expect(store.objects.has(`journal/test/records/${first.hash}`)).toBe(false)
    expect(await journal.floor()).toEqual(floor)
    expect(await journal.readSince(floor)).toEqual([latest])
    store.failDeleteKey = null
    expect(await journal.checkpoint(applied, catalog)).toEqual({ floor, deleted: 1 })
    expect((await journal.append(operation())).record.seq).toBe(4)
  })

  test('a missing or altered checkpoint blocks both replay and the writer without fallback to genesis', async () => {
    const { journal, store } = fixture()
    await journal.initialize()
    const first = await journal.append(oldOperation()),
      anchor = { seq: 1, hash: first.hash }
    await journal.checkpoint(anchor, [inventory(anchor)])
    const checkpoint = (await journal.head()).head.checkpoint
    if (!checkpoint) throw new Error('checkpoint missing')
    store.objects.delete(checkpoint.key)
    await expect(journal.readSince(anchor)).rejects.toThrow('journal_integrity')
    await expect(journal.append(operation())).rejects.toThrow('journal_integrity')
  })
})
