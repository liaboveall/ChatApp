import { mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type OperationsHealth, operationsAlertStateSchema } from '@chatapp/contracts'
import type { Monitoring } from './monitoring.ts'
import { privateJson, privateWrite, sha256 } from './operations-files.ts'
/** Fixed categories only. A failed or unknown delivery never writes a success receipt. No credentials/content in the state. */
export async function notifyOperations(
  health: OperationsHealth,
  monitor: Monitoring,
  file: string,
  now = Date.now(),
) {
  if (!monitor.enabled || !monitor.sendOperations) return 'disabled' as const
  const lock = join(dirname(file), 'operations-alert-lock')
  try {
    await mkdir(lock, { mode: 0o700 })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
      return 'busy' as const
    throw error
  }
  try {
    let previous: ReturnType<typeof operationsAlertStateSchema.parse> | undefined
    try {
      previous = await privateJson(file, operationsAlertStateSchema)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error
    }
    const signature = sha256(
      JSON.stringify({ status: health.status, problems: [...health.problems].sort() }),
    )
    const due = previous
      ? previous.signature !== signature ||
        (health.problems.length > 0 && now - previous.sentAt >= 3_600_000)
      : health.problems.length > 0
    if (previous && previous.sentAt > now + 300_000)
      throw new Error('operator alert clock requires review')
    if (due) await monitor.sendOperations(health)
    if (due || !previous) {
      const temp = join(dirname(file), `alert-${crypto.randomUUID()}.json`)
      try {
        await privateWrite(temp, { signature, sentAt: now, attention: health.problems.length > 0 })
        await rename(temp, file)
      } finally {
        await rm(temp, { force: true })
      }
    }
    return due ? ('sent' as const) : ('unchanged' as const)
  } finally {
    await rmdir(lock)
  }
}
