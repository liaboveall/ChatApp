import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMonitoring } from './monitoring.ts'
import { notifyOperations } from './operations-alert.ts'

test('operator alerts are fixed, coalesced, retried after failure, reminded hourly and resolved without private data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'operator-alert-')),
    file = join(directory, 'state.json')
  const bodies: string[] = []
  let failed = true
  const monitor = createMonitoring(
    { SENTRY_DSN: `https://${'a'.repeat(32)}@o123.ingest.us.sentry.io/45` },
    async (_url, init) => {
      if (failed) throw Error('private transport canary')
      bodies.push(String(init.body))
      return new Response('')
    },
  )
  const health = {
    status: 'attention' as const,
    backupAgeSeconds: 90000,
    problems: ['backup_rpo_exceeded' as const],
  }
  try {
    await expect(notifyOperations(health, monitor, file, 1000)).rejects.toThrow()
    await expect(readFile(file)).rejects.toThrow()
    failed = false
    expect(await notifyOperations(health, monitor, file, 2000)).toBe('sent')
    expect(
      await notifyOperations({ ...health, backupAgeSeconds: 90100 }, monitor, file, 3000),
    ).toBe('unchanged')
    expect(await notifyOperations(health, monitor, file, 3_602_000)).toBe('sent')
    expect(
      await notifyOperations(
        { status: 'healthy', backupAgeSeconds: 10, problems: [] },
        monitor,
        file,
        3_603_000,
      ),
    ).toBe('sent')
    expect(
      await notifyOperations(
        { status: 'healthy', backupAgeSeconds: 11, problems: [] },
        monitor,
        file,
        3_604_000,
      ),
    ).toBe('unchanged')
    expect(bodies).toHaveLength(3)
    expect(bodies.join()).not.toContain('private transport canary')
    expect(bodies.join()).not.toContain('90000')
    await expect(
      monitor.sendOperations?.({
        ...health,
        problems: ['private message' as 'backup_rpo_exceeded'],
      }),
    ).rejects.toThrow()
    expect(await notifyOperations(health, createMonitoring({}), file, 4_000_000)).toBe('disabled')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
