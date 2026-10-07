/** Test-image composition root only. Neither this entry nor its byte markers exist in runtime. */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TASK_FILES } from '../src/policy.ts'
import { startMediaServer } from '../src/runtime/supervisor.ts'

export const FAULT_TASK_MS = 6000
const PHASES = new Set([
  'pids-pressure-held',
  'tmpfs-pressure-held',
  'memory-pressure-held',
  'pids-failed',
])
const NUMBERS = [
  'leader',
  'child',
  'grandchild',
  'heldFromMs',
  'holdAtLeastUntilMs',
  'memoryCurrent',
  'memoryMax',
  'current',
  'peak',
  'max',
  'written',
  'fullFreeBytes',
  'filesystemType',
  'diagnosticStep',
] as const

function observeFixedProbe(root: string): void {
  let busy = false
  const observe = async () => {
    if (busy) return
    busy = true
    try {
      const entries = await readdir(root)
      if (entries.length !== 1 || !/^task-[A-Za-z0-9]{6}$/.test(entries[0] ?? '')) return
      const path = join(root, entries[0] as string, TASK_FILES.thumb)
      const file = await lstat(path)
      if (!file.isFile() || file.nlink !== 1 || file.size > 4096) return
      const bytes = await readFile(path)
      if (bytes.subarray(0, 6).toString() !== 'GIF89a') return
      const value: unknown = JSON.parse(bytes.subarray(13).toString())
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return
      const report = value as Record<string, unknown>
      if (report.testOnly !== true) return
      const phase =
        typeof report.phase === 'string' && PHASES.has(report.phase) ? report.phase : null
      const tree = report.operation === 'tree-timeout' || report.operation === 'tree-cancel'
      if (!phase && !tree) return
      const numbers = Object.fromEntries(
        NUMBERS.flatMap((key) =>
          typeof report[key] === 'number' && Number.isSafeInteger(report[key]) && report[key] >= 0
            ? [[key, report[key]]]
            : [],
        ),
      )
      // Only fixed test metadata reaches logs. Never emit input, request identity, environment or the parent canary.
      console.info(
        `media_test_probe:${JSON.stringify({ testOnly: true, phase, tree, observedAtMs: Date.now(), ...numbers, ...(phase === 'pids-failed' && ['Error', 'TypeError', 'RangeError', 'other'].includes(String(report.diagnosticCode)) ? { diagnosticCode: report.diagnosticCode } : {}) })}`,
      )
    } catch {
      // Cleanup and file publication race with observation; retry without logging decoder errors or file bytes.
    } finally {
      busy = false
    }
  }
  setInterval(() => {
    void observe()
  }, 200).unref()
}

if (import.meta.main) {
  process.umask(0o077)
  // A parent-only, synthetic canary: the child reports only its absence, never its value.
  process.env.MEDIA_TEST_PARENT_CANARY = randomBytes(24).toString('hex')
  const root = '/tmp/chatapp-media'
  await mkdir(root, { recursive: true, mode: 0o700 })
  // Exercise startup recovery with genuine abandoned task files, even though Docker clears tmpfs on restart.
  const abandoned = await mkdtemp(join(root, 'task-'))
  await writeFile(join(abandoned, TASK_FILES.input), 'abandoned-test-input', { mode: 0o600 })
  try {
    await startMediaServer({
      socketPath: '/run/chatapp-media/media.sock',
      taskEntry: '/app/apps/media/test/probe-task.ts',
      taskMs: FAULT_TASK_MS,
    })
    if ((await readdir(root)).length !== 0) throw new Error('startup_recovery_failed')
    console.info('media_test_startup_recovered')
    // Docker exec itself needs transient PID/memory headroom. Observe from the already-running test supervisor instead.
    observeFixedProbe(root)
  } catch {
    console.error('media_test_start_failed')
    process.exit(1)
  }
}
