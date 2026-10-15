/** Provider credential rotation rehearsal. Old credentials are temporarily retained only as authenticated ciphertext. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadOffsiteTarget } from '../apps/server/src/config/offsite.ts'
import {
  EncryptedDeletionJournal,
  JOURNAL_GENESIS,
  JournalError,
} from '../apps/server/src/domain/deletion-journal.ts'
import {
  createConditionalStore,
  OffsiteError,
  type OffsiteTarget,
} from '../apps/server/src/storage/conditional.ts'
import { getEnv, readEnvFile } from './lib/env-file.ts'
import { cleanupOffsiteRun } from './lib/offsite-cleanup.ts'

const mode = process.argv[2]
if (!['prepare', 'verify'].includes(mode ?? '')) throw new Error('use prepare or verify')
const file = await readEnvFile('.env.local'),
  env: Record<string, string | undefined> = {}
for (const line of file.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) env[key] = getEnv(file, key)
}
if (env.DELETION_JOURNAL_ENABLED !== 'false')
  throw new Error('disable the dedicated test writer before credential rotation')
if (!env.DELETION_JOURNAL_KEYRING_FILE) throw new Error('keyring missing')
const info = await stat(env.DELETION_JOURNAL_KEYRING_FILE)
if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16384)
  throw new Error('unsafe keyring')
const raw = JSON.parse(await readFile(env.DELETION_JOURNAL_KEYRING_FILE, 'utf8')) as {
  currentKeyVersion: number
  keys: Record<string, string>
}
const keys = new Map(
  Object.entries(raw.keys).map(([version, key]) => [
    Number(version),
    new Uint8Array(Buffer.from(key, 'base64url')),
  ]),
)
const encryptionKey = keys.get(raw.currentKeyVersion)
if (!encryptionKey || encryptionKey.length !== 32) throw new Error('invalid keyring')
const target = loadOffsiteTarget(env, 'DELETION_JOURNAL', 'test')
const directory = resolve('.test-runs/m7/credential-rotation'),
  currentFile = `${directory}/current.json`
type Rotation = {
  runId: string
  prefix: string
  oldEpoch: string
  newEpoch: string
  nonce: string
  ciphertext: string
}
const journalFor = (settings: OffsiteTarget, prefix: string, writerEpoch: string) =>
  new EncryptedDeletionJournal({
    store: createConditionalStore(settings),
    prefix,
    writerEpoch,
    currentKeyVersion: raw.currentKeyVersion,
    keys,
  })
const input = () => ({
  operationId: randomUUID(),
  actorId: null,
  acceptedAt: new Date().toISOString(),
  intent: {
    action: 'memory_delete' as const,
    target: { id: randomUUID(), userId: randomUUID(), contentVersion: 1 },
  },
})
if (mode === 'prepare') {
  try {
    await stat(currentFile)
    throw new Error('rotation already prepared; verify the existing run')
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
      throw error
  }
  const runId = randomUUID(),
    prefix = `m7-credential-rotation/${runId}/`,
    oldEpoch = randomUUID()
  const journal = journalFor(target, prefix, oldEpoch)
  await journal.initialize()
  await journal.append(input())
  const nonce = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce)
  cipher.setAAD(Buffer.from(prefix))
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(target), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(
    currentFile,
    JSON.stringify({
      runId,
      prefix,
      oldEpoch,
      newEpoch: randomUUID(),
      nonce: nonce.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    } satisfies Rotation) + '\n',
    { mode: 0o600, flag: 'wx' },
  )
  console.log(
    'prepared: dedicated test writer disabled; waiting for owner replacement and revocation of old provider credentials',
  )
} else {
  const rotation = JSON.parse(await readFile(currentFile, 'utf8')) as Rotation
  if (!/^m7-credential-rotation\/[a-f0-9-]{36}\/$/.test(rotation.prefix))
    throw new Error('pending rotation ownership invalid')
  const encrypted = Buffer.from(rotation.ciphertext, 'base64url'),
    decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(rotation.nonce, 'base64url'),
    )
  decipher.setAAD(Buffer.from(rotation.prefix))
  decipher.setAuthTag(encrypted.subarray(-16))
  const oldTarget = JSON.parse(
    Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8'),
  ) as OffsiteTarget
  if (
    target.accessKeyId === oldTarget.accessKeyId ||
    target.bucket !== oldTarget.bucket ||
    target.endpoint !== oldTarget.endpoint
  )
    throw new Error('use a different credential for the same dedicated journal test bucket')
  const replacement = journalFor(target, rotation.prefix, rotation.oldEpoch),
    oldStore = createConditionalStore(oldTarget)
  await replacement.head()
  let oldReadDenied = false,
    oldWriteDenied = false
  const deadline = Date.now() + 90000
  do {
    try {
      await oldStore.read(`${rotation.prefix}head`)
    } catch (error) {
      oldReadDenied = error instanceof OffsiteError && error.code === 'denied'
    }
    try {
      await oldStore.write(
        `${rotation.prefix}revocation-probe`,
        new TextEncoder().encode('synthetic permission test'),
        { absent: true },
      )
    } catch (error) {
      oldWriteDenied = error instanceof OffsiteError && error.code === 'denied'
    }
    if (!oldReadDenied || !oldWriteDenied) await new Promise((resolve) => setTimeout(resolve, 2000))
  } while ((!oldReadDenied || !oldWriteDenied) && Date.now() < deadline)
  if (!oldReadDenied || !oldWriteDenied) throw new Error('old credential revocation unproven')
  await replacement.rotateWriter(rotation.oldEpoch, rotation.newEpoch)
  let fenced = false
  try {
    await replacement.append(input())
  } catch (error) {
    fenced = error instanceof JournalError && error.code === 'stale_writer'
  }
  if (!fenced) throw new Error('old logical writer not fenced')
  const next = journalFor(target, rotation.prefix, rotation.newEpoch)
  await next.append(input())
  if ((await next.readSince({ seq: 0, hash: JOURNAL_GENESIS })).length !== 2)
    throw new Error('rotation chain incomplete')
  await cleanupOffsiteRun(createConditionalStore(target), rotation.prefix)
  await writeFile(
    `${directory}/${rotation.runId}-result.json`,
    JSON.stringify({
      oldReadDenied,
      oldWriteDenied,
      logicalWriterFenced: fenced,
      newWriterAccepted: true,
      chainComplete: true,
      cleanup: true,
    }) + '\n',
    { mode: 0o600 },
  )
  await rm(currentFile)
  console.log(
    'pass real provider credential revocation, epoch fencing, new writer, complete chain and cleanup',
  )
}
