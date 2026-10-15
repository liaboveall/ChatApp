/** Creates independent TEST recovery materials, never prints keys or overwrites existing environment values. */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getEnv, readEnvFile } from './lib/env-file.ts'

const env = await readEnvFile('.env.local')
const existing = getEnv(env, 'DELETION_JOURNAL_KEYRING_FILE')
if (existing && existing !== '<generated>') {
  console.log('recovery materials already configured; refusing to rotate or overwrite them')
  process.exit(1)
}
const runId = randomUUID()
const directory = resolve(`.test-runs/m7/recovery/${runId}`)
await mkdir(directory, { recursive: true, mode: 0o700 })
const keyring = {
  format: 1,
  currentKeyVersion: 1,
  keys: { 1: randomBytes(32).toString('base64url') },
}
const password = randomBytes(32).toString('base64url')
const writerEpoch = randomUUID()
const prefix = `m7-development/${runId}/`
await writeFile(`${directory}/journal-keyring.json`, `${JSON.stringify(keyring)}\n`, {
  mode: 0o600,
  flag: 'wx',
})
await writeFile(`${directory}/restic-password`, `${password}\n`, { mode: 0o600, flag: 'wx' })
await writeFile(
  `${directory}/recovery-materials.json`,
  `${JSON.stringify({ format: 1, purpose: 'ChatApp M7 dedicated test recovery only', journal: { keyring, writerEpoch, prefix }, resticPassword: password }, null, 2)}\n`,
  { mode: 0o600, flag: 'wx' },
)
// Append only missing settings. Retain the user's original configuration bytes and all existing credentials.
const fields: Record<string, string> = {
  DELETION_JOURNAL_ENABLED: 'false',
  DELETION_JOURNAL_PREFIX: prefix,
  DELETION_JOURNAL_WRITER_EPOCH: writerEpoch,
  DELETION_JOURNAL_KEYRING_FILE: `${directory}/journal-keyring.json`,
  BACKUP_PASSWORD_FILE: `${directory}/restic-password`,
}
let suffix =
  '\n# M7 independent test recovery materials; save recovery-materials.json outside the source host.\n'
for (const [key, value] of Object.entries(fields)) {
  if (getEnv(env, key) === undefined) suffix += `${key}=${value}\n`
}
const original = await Bun.file('.env.local').arrayBuffer()
await Bun.write('.env.local', new Blob([original, suffix]))
await chmod('.env.local', 0o600)
for (const name of ['journal-keyring.json', 'restic-password', 'recovery-materials.json']) {
  if (((await stat(`${directory}/${name}`)).mode & 0o777) !== 0o600)
    throw new Error('unsafe material permissions')
}
await writeFile(
  resolve('.test-runs/m7/recovery/current.json'),
  `${JSON.stringify({ runId, directory, outsideHostConfirmed: false })}\n`,
  { mode: 0o600 },
)
console.log(
  `recovery materials created with mode 600; journal remains disabled; export=${directory}/recovery-materials.json`,
)
