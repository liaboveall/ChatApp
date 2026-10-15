import { randomBytes, randomUUID } from 'node:crypto'
import { EncryptedDeletionJournal } from '../../src/domain/deletion-journal.ts'
import type { ConditionalStore } from '../../src/storage/conditional.ts'

/** External service double only. HTTP/domain tests still use real Postgres and Valkey. */
export class JournalObjects implements ConditionalStore {
  objects = new Map<string, { bytes: Uint8Array; etag: string }>()
  revision = 0
  unavailable = false
  async read(key: string) {
    if (this.unavailable) throw new Error('synthetic offsite unavailable')
    return this.objects.get(key) ?? null
  }
  async write(key: string, bytes: Uint8Array, condition: { etag: string } | { absent: true }) {
    if (this.unavailable) throw new Error('synthetic offsite unavailable')
    const previous = this.objects.get(key)
    if ('etag' in condition ? previous?.etag !== condition.etag : previous !== undefined)
      return false
    this.objects.set(key, { bytes: bytes.slice(), etag: String(++this.revision) })
    return true
  }
  async list(prefix: string) {
    return { keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)) }
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
}
export async function testJournal() {
  const store = new JournalObjects()
  const journal = new EncryptedDeletionJournal({
    store,
    prefix: 'test/journal/',
    writerEpoch: randomUUID(),
    currentKeyVersion: 1,
    keys: new Map([[1, randomBytes(32)]]),
  })
  await journal.initialize()
  return { store, journal }
}
