/** Deliberately hostile child, admitted only by the fault image's fixed entry point. */
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chmod, link, open, readFile, statfs, symlink, unlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import {
  decodeMediaRequest,
  MEDIA_LIMITS,
  type MediaRequest,
  type MediaSuccess,
  mediaIdentity,
} from '@chatapp/contracts/media'
import { TASK_FILES } from '../src/policy.ts'
import { assertTaskDirectory } from '../src/runtime/files.ts'

const PREFIX = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00', 'binary')
const MARKER = 'M3_PROBE:'
const ALLOWED = new Set([
  'noop',
  'isolation',
  'fork',
  'oom',
  'tmpfs',
  'tree-success',
  'tree-timeout',
  'tree-cancel',
  'cleanup-failure',
  'large-output',
  'wrong-nonce',
  'wrong-generation',
  'wrong-magic',
  'wrong-hash',
  'wrong-length',
  'missing-variant',
  'unknown-variant',
  'extra-field',
  'symlink-output',
  'hardlink-output',
  'kind-mismatch',
])
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
type Report = Record<string, unknown>
const PRESSURE_HOLD_MS = 3200
let forkDiagnosticStep = 0
let forkDirectory: string | undefined

function witness(directory: string, report: Report): void {
  const bytes = Buffer.alloc(4096, 0x20)
  const json = Buffer.from(JSON.stringify(report))
  if (json.length + PREFIX.length > bytes.length) throw new Error('probe_witness_too_large')
  PREFIX.copy(bytes)
  json.copy(bytes, PREFIX.length)
  // Preallocated before ENOSPC; later updates rewrite the same block, never allocate outside fixed TASK_FILES.
  const path = join(directory, TASK_FILES.thumb)
  writeFileSync(path, bytes, { mode: 0o600, flag: existsSync(path) ? 'r+' : 'wx' })
}
function heldPressure(report: Report, phase: string): Report {
  const heldFromMs = Date.now()
  return { ...report, phase, heldFromMs, holdAtLeastUntilMs: heldFromMs + PRESSURE_HOLD_MS }
}

function counters(file: string): Record<string, number> {
  const text = readFileSync(`/sys/fs/cgroup/${file}`, 'utf8')
  return Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((line) => {
        const [key, value] = line.split(/\s+/)
        return [key, Number(value)]
      }),
  )
}

async function blocked(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve('deadline')
    }, 200)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error('network_not_isolated'))
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(error.code ?? 'blocked')
    })
  })
}

async function isolation(directory: string, targets: Uint8Array): Promise<Report> {
  if (targets.byteLength !== 8) throw new Error('invalid_probe_marker')
  const ipv4 = (offset: number) => [...targets.subarray(offset, offset + 4)].join('.')
  const network = await Promise.all([
    blocked('1.1.1.1', 443),
    blocked('169.254.169.254', 80),
    blocked(ipv4(0), 5432),
    blocked(ipv4(4), 3900),
  ])
  const absent: Record<string, boolean> = {}
  for (const path of [
    '/run/secrets',
    '/run/docker.sock',
    '/var/run/docker.sock',
    '/app/.env.local',
    '/.env.local',
    '/app/apps/server',
    '/app/packages/db',
    '/var/lib/postgresql',
    '/var/lib/garage',
    '/home/mars/projects/ChatApp/.env.local',
  ]) {
    try {
      await readFile(path)
      absent[path] = false
    } catch (error) {
      absent[path] = (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }
  let rootWrite = ''
  try {
    await writeFile('/app/m3-forbidden-write', 'must-not-exist', { flag: 'wx' })
  } catch (error) {
    rootWrite = (error as NodeJS.ErrnoException).code ?? 'unknown'
  }
  const status = await readFile('/proc/self/status', 'utf8')
  const fields = (name: string) => new RegExp(`^${name}:\\s+(.+)$`, 'm').exec(status)?.[1]?.trim()
  return {
    network,
    absent,
    rootWrite,
    environmentKeys: Object.keys(process.env).sort(),
    parentCanaryInherited: process.env.MEDIA_TEST_PARENT_CANARY !== undefined,
    tmpdirMatchesTask: process.env.TMPDIR === directory,
    uid: process.getuid?.(),
    gid: process.getgid?.(),
    seccomp: Number(fields('Seccomp')),
    noNewPrivileges: Number(fields('NoNewPrivs')),
    capabilities: fields('CapEff'),
  }
}

async function spawned(child: ChildProcess): Promise<number | undefined> {
  return new Promise((resolve) => {
    child.once('error', () => resolve(undefined))
    child.once('spawn', () => resolve(child.pid))
  })
}

async function forkLimit(directory: string, report: Report): Promise<Report> {
  forkDirectory = directory
  forkDiagnosticStep = 1
  witness(directory, { ...report, phase: 'preparing' })
  const before = counters('pids.events')
  // Warm the report's crypto path before deliberate PID exhaustion.
  hash(PREFIX)
  // Bun initializes some timer machinery lazily; admit its threads before exhausting pids.max.
  await Bun.sleep(1)
  forkDiagnosticStep = 2
  // A small fixed POSIX child can hit the kernel fork limit without Bun trying to allocate another runtime thread first.
  const child = spawn('/bin/sh', ['/app/apps/media/test/probe-fork.sh'], {
    detached: false,
    env: {},
    stdio: 'ignore',
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('close', resolve)
    child.once('error', () => resolve(null))
  })
  const childPid = await spawned(child)
  const childExitCode = await exited
  forkDiagnosticStep = 3
  const children = readdirSync('/proc')
    .filter((pid) => /^\d+$/.test(pid) && Number(pid) !== process.pid)
    .flatMap((pid) => {
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, 'utf8')
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
        return Number(fields[2]) === process.pid ? [Number(pid)] : []
      } catch {
        return []
      }
    })
  const pressure = {
    before,
    after: counters('pids.events'),
    refused: childPid !== undefined && childExitCode !== 0,
    childExitCode,
    children,
    current: Number(readFileSync('/sys/fs/cgroup/pids.current', 'utf8')),
    peak: Number(readFileSync('/sys/fs/cgroup/pids.peak', 'utf8')),
    max: Number(readFileSync('/sys/fs/cgroup/pids.max', 'utf8')),
  }
  forkDiagnosticStep = 4
  // The shell's EXIT trap already released four owned sleepers before Bun received close.
  const releasedForReport = 4
  await Bun.sleep(50)
  forkDiagnosticStep = 5
  const held = heldPressure({ ...report, ...pressure, releasedForReport }, 'pids-pressure-held')
  witness(directory, held)
  await Bun.sleep(PRESSURE_HOLD_MS)
  forkDiagnosticStep = 6
  return { ...held, releasedAtMs: Date.now() }
}

async function fillTmpfs(directory: string, report: Report): Promise<Report> {
  witness(directory, { ...report, phase: 'preparing' })
  const path = join(directory, TASK_FILES.original)
  const handle = await open(path, 'wx', 0o600)
  const chunk = Buffer.alloc(1024 * 1024, 0x5a)
  let written = 0
  let code = ''
  try {
    for (let count = 0; count < 300; count += 1) {
      let offset = 0
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset)
        offset += result.bytesWritten
        written += result.bytesWritten
      }
    }
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code ?? 'unknown'
  }
  const filesystem = await statfs(directory)
  const held = heldPressure(
    {
      ...report,
      code,
      written,
      filesystemType: filesystem.type,
      fullFreeBytes: filesystem.bavail * filesystem.bsize,
    },
    'tmpfs-pressure-held',
  )
  // The witness's single block already exists. Keep ENOSPC present during real API/worker completion.
  witness(directory, held)
  await Bun.sleep(PRESSURE_HOLD_MS)
  await handle.close()
  await unlink(path)
  return {
    ...held,
    releasedAtMs: Date.now(),
    freeBytesAfterRelease: (await statfs(directory)).bavail * filesystem.bsize,
  }
}

async function tree(): Promise<Report> {
  const child = spawn('/bin/sh', ['/app/apps/media/test/probe-descendant.sh'], {
    detached: false,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  child.on('error', () => {})
  const report = await new Promise<{ child: number; grandchild: number }>((resolve, reject) => {
    let data = ''
    const timeout = setTimeout(() => reject(new Error('tree_not_started')), 1000)
    child.stdout?.on('data', (bytes: Buffer) => {
      data += bytes.toString()
      if (!data.includes('\n')) return
      clearTimeout(timeout)
      try {
        resolve(JSON.parse(data.trim()) as { child: number; grandchild: number })
      } catch {
        reject(new Error('invalid_tree_report'))
      }
    })
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new Error('tree_not_started'))
    })
  })
  return { leader: process.pid, ...report }
}

function images(
  directory: string,
  request: MediaRequest,
  report: Report,
  large = false,
): MediaSuccess {
  const data = Buffer.concat([PREFIX, Buffer.from(JSON.stringify(report))])
  const files = []
  for (const variant of ['original', 'thumb', 'preview'] as const) {
    const bytes = large && variant === 'original' ? 4 * 1024 * 1024 : data.length
    const output = large && variant === 'original' ? Buffer.alloc(bytes) : data
    if (large && variant === 'original') data.copy(output)
    writeFileSync(join(directory, TASK_FILES[variant]), output, { mode: 0o600 })
    files.push({
      variant,
      mime: 'image/gif' as const,
      bytes,
      sha256: hash(output),
      width: 1,
      height: 1,
    })
  }
  return {
    ...mediaIdentity(request),
    status: 'ok',
    kind: 'image',
    mime: 'image/gif',
    width: 1,
    height: 1,
    durationMs: null,
    metadataCleared: true,
    thumbhash: 'AQ==',
    files,
  }
}

async function main(): Promise<void> {
  const directory = process.argv[2]
  if (!directory || process.argv.length !== 3) throw new Error('invalid_task_directory')
  await assertTaskDirectory(directory)
  const request = decodeMediaRequest(await readFile(join(directory, TASK_FILES.request)))
  const raw = await readFile(join(directory, TASK_FILES.input))
  const separator = raw.indexOf(0)
  const marker = raw.subarray(0, separator < 0 ? raw.length : separator).toString('utf8')
  if (!marker.startsWith(MARKER)) throw new Error('invalid_probe_marker')
  const operation = marker.slice(MARKER.length)
  if (!ALLOWED.has(operation)) throw new Error('invalid_probe_marker')
  if (operation !== 'isolation' && separator !== -1) throw new Error('invalid_probe_marker')
  let report: Report = { testOnly: true, operation, leader: process.pid }
  if (operation === 'isolation')
    report = { ...report, ...(await isolation(directory, raw.subarray(separator + 1))) }
  if (operation === 'fork') report = { ...report, ...(await forkLimit(directory, report)) }
  if (operation === 'tmpfs') report = { ...report, ...(await fillTmpfs(directory, report)) }
  if (operation === 'oom') {
    witness(directory, { ...report, phase: 'preparing' })
    const allocations: Buffer[] = []
    const current = () => Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8'))
    const memoryMax = Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8'))
    while (current() < memoryMax - 24 * 1024 * 1024) {
      allocations.push(Buffer.alloc(8 * 1024 * 1024, 0xa5))
      await Bun.sleep(1)
    }
    witness(
      directory,
      heldPressure({ ...report, memoryMax, memoryCurrent: current() }, 'memory-pressure-held'),
    )
    await Bun.sleep(PRESSURE_HOLD_MS)
    for (;;) {
      allocations.push(Buffer.alloc(8 * 1024 * 1024, 0xa5))
      await Bun.sleep(1)
    }
  }
  if (operation.startsWith('tree-')) report = { ...report, ...(await tree()) }
  const result = images(directory, request, report, operation === 'large-output')
  if (operation === 'tree-timeout' || operation === 'tree-cancel') await Bun.sleep(90_000)
  if (operation === 'cleanup-failure') await chmod(directory, 0o000)
  if (operation === 'wrong-nonce') result.nonce = '0'.repeat(64)
  if (operation === 'wrong-generation') result.generation += 1
  const first = result.files[0]
  if (!first) throw new Error('missing_output')
  if (operation === 'wrong-magic') {
    const wrong = Buffer.alloc(first.bytes, 0x41)
    await writeFile(join(directory, TASK_FILES.original), wrong)
    first.sha256 = hash(wrong)
  }
  if (operation === 'wrong-hash') first.sha256 = '0'.repeat(64)
  if (operation === 'wrong-length') first.bytes += 1
  if (operation === 'symlink-output' || operation === 'hardlink-output') {
    await unlink(join(directory, TASK_FILES.thumb))
    if (operation === 'symlink-output')
      await symlink(TASK_FILES.original, join(directory, TASK_FILES.thumb))
    else await link(join(directory, TASK_FILES.original), join(directory, TASK_FILES.thumb))
  }
  const untrusted: Record<string, unknown> = { ...result }
  if (operation === 'missing-variant') untrusted.files = result.files.slice(0, 1)
  if (operation === 'unknown-variant')
    untrusted.files = [{ ...first, variant: '../escape' }, ...result.files.slice(1)]
  if (operation === 'extra-field') untrusted.path = '/tmp/forbidden-result-field'
  if (operation === 'kind-mismatch') untrusted.kind = 'file'
  const json = Buffer.from(JSON.stringify(untrusted))
  if (json.length > MEDIA_LIMITS.headerBytes) throw new Error('probe_report_too_large')
  writeFileSync(join(directory, TASK_FILES.result), json, { mode: 0o600 })
  // Descendants intentionally outlive the leader; success must still kill/reap the complete group.
  process.exit(0)
}

if (import.meta.main)
  await main().catch((error: unknown) => {
    if (forkDirectory) {
      try {
        const code = error instanceof Error ? error.name : 'unknown'
        witness(forkDirectory, {
          testOnly: true,
          phase: 'pids-failed',
          diagnosticStep: forkDiagnosticStep,
          diagnosticCode: ['Error', 'TypeError', 'RangeError'].includes(code) ? code : 'other',
        })
        // Keep only the fixed diagnostic visible to the existing observer before normal task cleanup.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600)
      } catch {}
    }
    process.exit(1)
  })
