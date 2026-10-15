import { lstat, readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { JournalSettings } from '../config/journal.ts'
import { EncryptedDeletionJournal } from '../domain/deletion-journal.ts'
import { createConditionalStore } from '../storage/conditional.ts'

export const keyringSchema = z
  .object({
    format: z.literal(1),
    currentKeyVersion: z.number().int().positive(),
    keys: z.record(z.string().regex(/^[1-9][0-9]*$/), z.string().regex(/^[A-Za-z0-9_-]{43}$/)),
  })
  .strict()
export async function readJournalKeys(file: string) {
  const info = await lstat(file)
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024)
    throw new Error('unsafe keyring')
  const raw = keyringSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const keys = new Map(
    Object.entries(raw.keys).map(([version, key]) => [
      Number(version),
      new Uint8Array(Buffer.from(key, 'base64url')),
    ]),
  )
  if (keys.get(raw.currentKeyVersion)?.byteLength !== 32)
    throw new Error('missing current journal key')
  return { raw, keys }
}
/** Operator-only composition: constructing a journal does not initialize or acquire a writer. */
export async function openOperatorJournal(
  settings: JournalSettings,
): Promise<EncryptedDeletionJournal> {
  const { raw, keys } = await readJournalKeys(settings.keyringFile)
  return new EncryptedDeletionJournal({
    store: createConditionalStore(settings.target),
    prefix: settings.prefix,
    writerEpoch: settings.writerEpoch,
    currentKeyVersion: raw.currentKeyVersion,
    keys,
  })
}
export async function createRuntimeDeletionJournal(
  settings: JournalSettings,
): Promise<EncryptedDeletionJournal> {
  try {
    const journal = await openOperatorJournal(settings)
    // Startup only reads. A missing head is never silently reinitialized after a disaster.
    const head = await journal.head()
    if (head.head.writerEpoch !== settings.writerEpoch) throw new Error('writer fenced')
    return journal
  } catch {
    throw new Error(
      'independent deletion journal unavailable, uninitialized, fenced or keyring invalid',
    )
  }
}
