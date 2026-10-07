#!/usr/bin/env bun
/**
 * bun --no-env-file scripts/test-media.ts [--phase runtime|fault|all] [--case name-pattern]
 * Fresh, verified compose.test instance only. Bounded commands, no decoder on the host, no dev-instance operations.
 * .test-runs/m3/<runId>/result.json contains metadata/results only, never credentials, inspect output or manifest copies.
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClientInput } from '../apps/server/test/media/container-client.ts'
import {
  MEDIA_LIMITS,
  type MediaSuccess,
  mediaSuccessSchema,
} from '../packages/contracts/src/media.ts'
import {
  type CgroupSnapshot,
  MediaTestInstance,
  verifyMediaTestLocation,
} from './lib/media-test-infra.ts'

const MiB = 1024 * 1024
const FAULT_MS = 6000
const MARKER = (operation: string) => Buffer.from(`M3_PROBE:${operation}`)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Evidence = Record<string, unknown>
type Case = { name: string; phase: 'runtime' | 'fault'; run(): Promise<Evidence> }
type Result = {
  name: string
  phase: string
  status: 'pass' | 'fail'
  elapsedMs: number
  evidence?: Evidence
  error?: string
  recovery?: string
}

class EvidenceFailure extends Error {
  constructor(
    message: string,
    readonly evidence: Evidence,
  ) {
    super(`m3: ${message}`)
  }
}
function assert(value: unknown, message: string, evidence?: Evidence): asserts value {
  if (!value) {
    if (evidence) throw new EvidenceFailure(message, evidence)
    throw new Error(`m3: ${message}`)
  }
}
function object(value: unknown): Record<string, unknown> {
  assert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected result object',
  )
  return value as Record<string, unknown>
}
function number(value: unknown): number {
  assert(typeof value === 'number' && Number.isFinite(value), 'expected numeric evidence')
  return value
}
function json(bytes: Uint8Array): Record<string, unknown> {
  return object(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
}
function safeError(error: unknown): string {
  if (error instanceof Error && /^(m3:|media-test:|fault target rejected:)/.test(error.message))
    return error.message.slice(0, 220)
  return error instanceof Error ? error.name : 'unknown_failure'
}
function resources(snapshot: CgroupSnapshot): Evidence {
  return {
    memoryMax: snapshot.memoryMax,
    memorySwapMax: snapshot.memorySwapMax,
    memoryCurrent: snapshot.memoryCurrent,
    memoryPeak: snapshot.memoryPeak,
    memoryEvents: snapshot.memoryEvents,
    pidsMax: snapshot.pidsMax,
    pidsCurrent: snapshot.pidsCurrent,
    pidsPeak: snapshot.pidsPeak,
    pidsEvents: snapshot.pidsEvents,
    processes: snapshot.processes,
    tmpTotalBytes: snapshot.tmpTotalBytes,
    tmpFreeBytes: snapshot.tmpFreeBytes,
  }
}
function success(response: Record<string, unknown>): {
  result: MediaSuccess
  files: Array<{ variant: string; bytes: Buffer }>
} {
  const parsed = mediaSuccessSchema.safeParse(response.result)
  assert(
    parsed.success,
    `expected successful result, got ${typeof response.code === 'string' ? response.code : 'invalid_response'}`,
  )
  assert(Array.isArray(response.files), 'missing client output bytes')
  const files = response.files.map((value: unknown) => {
    const entry = object(value)
    assert(
      typeof entry.variant === 'string' && typeof entry.data === 'string',
      'invalid output transport',
    )
    const bytes = Buffer.from(entry.data, 'base64')
    const metadata = parsed.data.files.find((file) => file.variant === entry.variant)
    assert(
      metadata && metadata.bytes === bytes.length && metadata.sha256 === digest(bytes),
      'independent output length/hash mismatch',
    )
    return { variant: entry.variant, bytes }
  })
  assert(
    files.length === parsed.data.files.length &&
      new Set(files.map((file) => file.variant)).size === files.length,
    'variant whitelist mismatch',
  )
  assert(number(response.maxChunkBytes) <= MEDIA_LIMITS.chunkBytes, 'client chunks exceeded 64 KiB')
  return { result: parsed.data, files }
}
function failed(response: Record<string, unknown>, expected: string | string[]): Evidence {
  const allowed = typeof expected === 'string' ? [expected] : expected
  assert(
    typeof response.code === 'string' && allowed.includes(response.code),
    `expected ${allowed.join('/')}, got ${typeof response.code === 'string' ? response.code : 'success'}`,
    {
      observedCode: response.code,
      elapsedMs: response.elapsedMs,
      fixedError: response.errorMessageFixed,
    },
  )
  assert(response.errorMessageFixed === true, 'client error retained unsafe details')
  return { code: response.code, elapsedMs: response.elapsedMs, fixedError: true }
}
function pids(report: Record<string, unknown>): number[] {
  const values = [
    report.leader,
    report.child,
    report.grandchild,
    ...(Array.isArray(report.children) ? report.children : []),
  ].filter((value) => value !== undefined)
  assert(
    values.every((value) => typeof value === 'number' && Number.isSafeInteger(value) && value > 1),
    'invalid probe process identity',
  )
  return values as number[]
}
function businessDuringPressure(
  business: Awaited<ReturnType<MediaTestInstance['businessAvailable']>>,
  witness: Record<string, unknown>,
): void {
  const start = number(witness.heldFromMs)
  const end = number(witness.holdAtLeastUntilMs)
  assert(
    business.startedAtMs >= start &&
      business.apiReadyAtMs <= end &&
      business.workFinishedAtMs >= start &&
      business.workFinishedAtMs <= end,
    'API/work completion did not occur inside the actual held-pressure window',
    { business, pressureWindow: { heldFromMs: start, holdAtLeastUntilMs: end } },
  )
}
function reportFrom(response: Record<string, unknown>): Record<string, unknown> {
  const output = success(response)
  const original = output.files.find((file) => file.variant === 'original')
  assert(original?.bytes.subarray(0, 6).toString() === 'GIF89a', 'missing test-only GIF prefix')
  const report = json(original.bytes.subarray(13))
  assert(report.testOnly === true, 'probe report is not marked test-only')
  return report
}

export async function runMediaTests(args: string[]): Promise<number> {
  let phase = 'all'
  let selection = /.*/
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--phase') {
      phase = args[++index] ?? ''
      assert(['runtime', 'fault', 'all'].includes(phase), 'invalid phase')
    } else if (arg === '--case') {
      const pattern = args[++index]
      assert(pattern && pattern.length <= 120, 'invalid case pattern')
      selection = new RegExp(pattern)
    } else
      throw new Error('m3: usage: test-media.ts [--phase runtime|fault|all] [--case name-pattern]')
  }
  await verifyMediaTestLocation()
  let interrupted = false
  const interrupt = () => {
    interrupted = true
  }
  process.on('SIGTERM', interrupt)
  process.on('SIGINT', interrupt)
  const started = performance.now()
  const instance = await MediaTestInstance.start()
  const runId = instance.manifest.runId
  const directory = join('.test-runs', 'm3', runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const results: Result[] = []
  const snapshots: Evidence[] = []
  let teardown = 'not_started'
  let code = 1
  const samples = new Map<string, Buffer>()
  const sample = async (name: string) => {
    const cached = samples.get(name)
    if (cached) return cached
    const generated = Buffer.from(await instance.sample('generate', name))
    samples.set(name, generated)
    return generated
  }
  const client = async (bytes: Uint8Array, options: Omit<ClientInput, 'input'> = {}) =>
    instance.client({ input: Buffer.from(bytes).toString('base64'), ...options })
  const probe = async (operation: string, options: Omit<ClientInput, 'input'> = {}) =>
    client(MARKER(operation), options)
  let currentPhase: 'runtime' | 'fault' = 'runtime'
  const persist = async () =>
    writeFile(
      join(directory, 'result.json'),
      JSON.stringify(
        {
          version: 1,
          ...instance.metadata(),
          productionDeadlineMs: MEDIA_LIMITS.taskMs,
          faultDeadlineMs: FAULT_MS,
          command: ['bun', '--no-env-file', 'scripts/test-media.ts', ...args].join(' '),
          elapsedMs: performance.now() - started,
          plannedCases: selected.map((entry) => entry.name),
          unexecutedCases: selected
            .filter((entry) => !results.some((result) => result.name === entry.name))
            .map((entry) => entry.name),
          results,
          resources: snapshots,
          teardown,
          missingEvidence: [
            ...(process.arch === 'arm64' ? [] : ['real ARM Linux resource/fault verification']),
            'M7 mixed-load capacity',
            'attachment DB/generation fencing/UI (not in this admission slice)',
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
  const emptyTasks = async () => {
    await instance.waitUntil(
      async () => {
        const state = await instance.taskState()
        return state.entries === 0 && state.privateRoot
      },
      10_000,
      'empty private task root',
    )
  }
  const recover = async () => {
    if (!(await instance.mediaRunning())) await instance.action('media', 'start')
    await emptyTasks()
    if (currentPhase === 'runtime') success(await client(await sample('png')))
    else assert(reportFrom(await probe('noop')).operation === 'noop', 'IPC recovery probe failed')
    await emptyTasks()
  }
  const pendingTree = async (): Promise<Record<string, unknown>> => {
    const sinceMs = Date.now()
    let report: Record<string, unknown> | null = null
    await instance.waitUntil(
      async () => {
        report = await instance.probeReport('tree', sinceMs)
        return report !== null && typeof report.grandchild === 'number'
      },
      3500,
      'probe grandchild tree',
    )
    assert(report, 'pending tree missing')
    return report
  }
  const pendingPressure = async (
    phaseName: 'pids-pressure-held' | 'tmpfs-pressure-held' | 'memory-pressure-held',
  ): Promise<Record<string, unknown>> => {
    const sinceMs = Date.now()
    let report: Record<string, unknown> | null = null
    await instance.waitUntil(
      async () => {
        report = await instance.probeReport(phaseName, sinceMs)
        return report?.phase === phaseName
      },
      4000,
      'fixed probe holding actual cgroup/tmpfs pressure',
    )
    assert(report, 'held-pressure witness missing')
    return report
  }
  const cases: Case[] = []
  const add = (name: string, casePhase: 'runtime' | 'fault', run: () => Promise<Evidence>) =>
    cases.push({ name, phase: casePhase, run })

  add('runtime-image-and-socket-policy', 'runtime', async () => {
    assert(!(await instance.runtimeContainsTests()), 'runtime image contains test entry points')
    const socket = await instance.socketPolicy()
    assert(
      socket.onlySocket &&
        socket.entries === 1 &&
        socket.uid === 10001 &&
        socket.gid === 10001 &&
        socket.mode === 0o700 &&
        socket.socket &&
        socket.socketUid === 10001 &&
        socket.socketGid === 10001 &&
        socket.socketMode === 0o600,
      'socket ownership/permissions',
    )
    assert(await instance.workerCannotWriteSocketVolume(), 'worker can write the socket volume')
    const media = await instance.snapshot('media'),
      worker = await instance.snapshot('worker'),
      api = await instance.snapshot('api')
    assert(
      media.memoryMax + worker.memoryMax === 2 * 1024 * MiB && api.memoryMax === 1024 * MiB,
      'background/API memory budget',
    )
    snapshots.push({
      phase: 'runtime-start',
      media: resources(media),
      worker: resources(worker),
      api: resources(api),
    })
    return {
      runtimeTestsAbsent: true,
      socket,
      workerSocketReadOnly: true,
      backgroundBytes: media.memoryMax + worker.memoryMax,
      business: await instance.businessAvailable(),
    }
  })

  for (const name of ['jpeg', 'png', 'gif'] as const)
    add(`real-${name}-variants`, 'runtime', async () => {
      const input = await sample(name)
      const source = json(await instance.sample('source', name, input))
      if (name === 'jpeg')
        assert(
          source.orientation === 6 &&
            source.hasExif &&
            source.hasIcc &&
            source.hasXmp &&
            source.privateExifPresent,
          'JPEG input lacks real private EXIF/orientation/ICC/XMP',
        )
      if (name === 'gif') assert(source.frames === 3, 'GIF source does not contain three frames')
      const output = success(await client(input))
      assert(
        output.result.kind === 'image' && output.files.length === 3,
        'real image variants missing',
      )
      const facts = []
      for (const file of output.files) {
        const fact = json(await instance.sample('output', name, file.bytes))
        assert(
          fact.metadataCleared === true &&
            fact.hasExif === false &&
            fact.hasIcc === false &&
            fact.hasXmp === false,
          'image metadata was not independently cleared',
        )
        if (name === 'jpeg')
          assert(fact.orientationPixelsCorrect === true, 'orientation-6 decoded pixels are wrong')
        if (name === 'png') assert(fact.transparencyPreserved === true, 'PNG transparency lost')
        if (name === 'gif')
          assert(fact.animationPreserved === true, 'GIF frames/timing/pixels lost')
        facts.push({ variant: file.variant, ...fact })
      }
      return {
        inputBytes: input.length,
        outputBytes: output.result.files.reduce((sum, file) => sum + file.bytes, 0),
        source,
        variants: facts,
      }
    })

  add('real-avatar-256', 'runtime', async () => {
    const output = success(await client(await sample('jpeg'), { operation: 'avatar' }))
    assert(output.result.width === 256 && output.result.height === 256, 'avatar is not 256x256')
    for (const file of output.files) {
      const facts = json(await instance.sample('avatar', 'jpeg', file.bytes))
      assert(
        facts.width === 256 && facts.height === 256 && facts.metadataCleared,
        'avatar variant size/metadata invalid',
      )
    }
    return { width: 256, height: 256, variants: 3, independentlyDecoded: true }
  })

  add('real-video-metadata-cleared', 'runtime', async () => {
    const input = await sample('video')
    const source = json(await instance.sample('source', 'video', input))
    assert(
      source.sourceHasFormatPrivate &&
        source.sourceHasStreamPrivate &&
        source.hasLocation &&
        number(source.chapters) > 0,
      'video source lacks format/stream/location/chapter private metadata',
    )
    const output = success(await client(input, { operation: 'video' }))
    assert(
      output.result.kind === 'video' && output.result.metadataCleared,
      'compatible video fell back instead of being cleaned',
    )
    const original = output.files[0]
    assert(original, 'video output missing')
    const facts = json(await instance.sample('output', 'video', original.bytes))
    assert(
      facts.metadataCleared === true &&
        facts.chapters === 0 &&
        facts.hasLocation === false &&
        facts.hasPrivate === false,
      'ffprobe found uncleared or non-whitelisted video metadata',
      { inspected: facts },
    )
    return {
      inputBytes: input.length,
      outputBytes: original.bytes.length,
      source,
      output: facts,
      ffprobeVerified: true,
    }
  })

  add('real-video-output-limit-falls-back-within-reservation', 'runtime', async () => {
    const input = await sample('video-tight')
    const cleaned = success(await client(input, { operation: 'video' }))
    assert(
      cleaned.result.kind === 'video' &&
        cleaned.result.files[0] &&
        cleaned.result.files[0].bytes > input.length,
      'fixture must actually grow on remux',
    )
    const fallback = success(
      await client(input, { operation: 'video', maxOutputBytes: input.length }),
    )
    assert(
      fallback.result.kind === 'file' &&
        fallback.result.metadataCleared === false &&
        fallback.files[0]?.bytes.equals(input),
      'output limit did not return byte-preserving download-only fallback',
    )
    failed(
      await client(input, { operation: 'video', maxOutputBytes: input.length - 1 }),
      'output_limit',
    )
    return {
      inputBytes: input.length,
      remuxBytes: cleaned.result.files[0].bytes,
      preserved: true,
      undersizedReservationRefused: true,
    }
  })
  add('real-ffv1-download-only-byte-preservation', 'runtime', async () => {
    const input = await sample('ffv1')
    const source = json(await instance.sample('source', 'ffv1', input))
    assert(
      Array.isArray(source.codecs) && source.codecs.includes('ffv1'),
      'fallback source is not real FFV1',
    )
    const output = success(await client(input, { operation: 'video' }))
    const original = output.files[0]
    assert(original, 'fallback original missing')
    assert(
      output.result.kind === 'file' &&
        output.result.mime === 'application/octet-stream' &&
        output.result.metadataCleared === false &&
        original.bytes.equals(input),
      'fallback was cleaned/altered or falsely marked playable',
    )
    return {
      rawBytes: input.length,
      returnedBytes: original.bytes.length,
      hashUnchanged: digest(original.bytes) === digest(input),
      downloadOnly: true,
      sourceCodec: 'ffv1',
    }
  })

  for (const [name, bytes] of [
    ['html', '<!doctype html><script>fetch("https://example.invalid")</script>'],
    ['svg', '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///etc/passwd"/></svg>'],
    [
      'xml',
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY p SYSTEM "file:///etc/passwd">]><x>&p;</x>',
    ],
  ] as const)
    add(`reject-disguised-${name}`, 'runtime', async () =>
      failed(await client(Buffer.from(bytes)), 'unsupported'),
    )

  for (const [key, value] of [
    ['command', 'touch /tmp/forbidden'],
    ['url', 'https://example.invalid/input'],
    ['path', '/etc/passwd'],
    ['filename', 'photo.jpg'],
    ['userId', 'not-a-principal'],
  ] as const)
    add(`reject-header-${key}`, 'runtime', async () => {
      const response = await client(await sample('png'), { mode: 'raw', request: { [key]: value } })
      assert(
        object(response.reply).code === 'invalid_request' && response.transportTimedOut === false,
        'strict header field was accepted or timed out',
      )
      return { field: key, code: 'invalid_request' }
    })

  for (const length of [0, MEDIA_LIMITS.headerBytes + 1, 0xffffffff])
    add(`reject-frame-length-${length}`, 'runtime', async () => {
      const response = await client(await sample('png'), { mode: 'raw', frameLength: length })
      assert(
        response.responseBytes === 0 && response.transportTimedOut === false,
        'overlong/zero frame was not closed promptly',
      )
      return { declaredHeaderBytes: length, responseBytes: 0, elapsedMs: response.elapsedMs }
    })

  for (const [name, override, tail] of [
    ['short-body', 'short', ''],
    ['wrong-hash', 'hash', ''],
    ['tail-byte', 'tail', 'eA=='],
    ['second-job-same-connection', 'second', ''],
  ] as const)
    add(`reject-input-${name}`, 'runtime', async () => {
      const input = await sample('png')
      const response = await client(input, {
        mode: 'raw',
        request:
          override === 'short'
            ? { inputBytes: input.length + 1 }
            : override === 'hash'
              ? { inputSha256: '0'.repeat(64) }
              : {},
        tail,
        secondJob: override === 'second',
      })
      const expected =
        override === 'tail' || override === 'second' ? 'input_limit' : 'invalid_input'
      assert(
        object(response.reply).code === expected && response.transportTimedOut === false,
        'input length/hash/EOF admission failed',
      )
      return {
        code: expected,
        actualBytesVerified: true,
        ...(override === 'second' ? { secondFrame: 'complete-valid-header-and-body' } : {}),
      }
    })

  add('reject-fragmented-invalid-header', 'runtime', async () => {
    const response = await client(await sample('png'), {
      mode: 'raw',
      fragmented: true,
      request: { path: '/forbidden' },
    })
    const rejected =
      response.reply === null
        ? response.responseBytes === 0
        : object(response.reply).code === 'invalid_request'
    assert(rejected && response.transportTimedOut === false, 'fragmented strict header bypass')
    return {
      byteAtATime: true,
      outcome: response.reply === null ? 'connection_closed' : 'invalid_request',
    }
  })
  add('real-fragmented-valid-header-and-body', 'runtime', async () => {
    const response = await client(await sample('png'), { mode: 'raw', fragmented: true })
    const parsed = mediaSuccessSchema.safeParse(response.reply)
    assert(
      parsed.success && parsed.data.kind === 'image' && response.transportTimedOut === false,
      'valid fragmented protocol failed',
    )
    return {
      byteAtATime: true,
      responseBytes: response.responseBytes,
      status: 'ok',
      variants: parsed.data.files.length,
    }
  })

  for (const name of ['side-bomb', 'pixel-bomb', 'frame-bomb', 'animated-pixel-bomb'] as const)
    add(`reject-${name}`, 'runtime', async () => {
      const input = await sample(name)
      const facts = json(await instance.sample('source', name, input))
      return {
        ...failed(await client(input), 'input_limit'),
        inputBytes: input.length,
        actualRasterBounds: facts,
      }
    })
  add('reject-real-output-limit', 'runtime', async () => {
    const input = await sample('jpeg')
    const response = await client(input, { maxOutputBytes: 16 })
    if (response.code !== 'output_limit') {
      const source = (await Bun.file('apps/media/test/limit-diagnostic.ts').text())
        .replace("from '../src/runtime/image.ts'", "from '/app/apps/media/src/runtime/image.ts'")
        .replace(
          "from '../src/runtime/streams.ts'",
          "from '/app/apps/media/src/runtime/streams.ts'",
        )
      const diagnostic = json(
        await instance.exec('media', `${source}\nawait runLimitDiagnostic()`, input),
      )
      throw new EvidenceFailure('real JPEG output_limit misclassified', {
        observedIPCCode: response.code,
        requestedOutputBytes: 16,
        diagnostic,
      })
    }
    return failed(response, 'output_limit')
  })

  add('production-default-60s-deadline', 'runtime', async () => {
    assert(MEDIA_LIMITS.taskMs === 60_000, 'production contract deadline changed')
    const pending = client(await sample('png'), { mode: 'stalled-input', timeoutMs: 66_000 })
    await instance.waitUntil(
      async () => (await instance.taskState()).entries === 1,
      5000,
      'stalled production upload',
    )
    const business = await instance.businessAvailable()
    const response = await pending
    assert(
      response.transportTimedOut === false &&
        number(response.elapsedMs) >= 59_000 &&
        number(response.elapsedMs) < 63_000,
      'production 60s supervisor deadline did not close the connection',
      { observedMs: response.elapsedMs, clientTimedOut: response.transportTimedOut },
    )
    return {
      defaultDeadlineMs: 60_000,
      observedMs: response.elapsedMs,
      clientGuardMs: 66_000,
      business,
    }
  })

  add('fault-startup-abandoned-task-recovery', 'fault', async () => {
    assert(
      await instance.logFlag('media_test_startup_recovered'),
      'fault startup did not recover abandoned TASK_FILES',
    )
    await emptyTasks()
    return { abandonedTaskRecovered: true, faultImageOnly: true, taskDeadlineMs: FAULT_MS }
  })

  add('probe-network-credentials-files-and-child-env', 'fault', async () => {
    const bytes = Buffer.concat([
      MARKER('isolation'),
      Buffer.from([0]),
      await instance.networkTargets(),
    ])
    const report = reportFrom(await client(bytes))
    assert(
      Array.isArray(report.network) &&
        report.network.length === 4 &&
        report.network.every(
          (code) =>
            code === 'ENETUNREACH' ||
            code === 'EHOSTUNREACH' ||
            code === 'EACCES' ||
            code === 'ECONNREFUSED' ||
            code === 'ETIMEDOUT' ||
            code === 'deadline',
        ),
      'network probe unexpectedly reached public/metadata/real DB/Garage',
      { networkCodes: report.network },
    )
    assert(
      Object.values(object(report.absent)).every((absent) => absent === true),
      'media can read business/host/secret/socket files',
    )
    assert(
      report.rootWrite === 'EROFS' &&
        report.uid === 10001 &&
        report.gid === 10001 &&
        report.seccomp === 2 &&
        report.noNewPrivileges === 1 &&
        report.capabilities === '0000000000000000',
      'actual Linux root/user/seccomp/capability isolation failed',
    )
    const expectedKeys = [
      'BUN_JSC_numberOfGCMarkers',
      'BUN_JSC_numberOfDFGCompilerThreads',
      'BUN_JSC_numberOfFTLCompilerThreads',
      'BUN_JSC_maxNumberOfWorklistThreads',
      'LANG',
      'MALLOC_ARENA_MAX',
      'OMP_NUM_THREADS',
      'PATH',
      'TMPDIR',
      'UV_THREADPOOL_SIZE',
      'VIPS_CONCURRENCY',
    ].sort()
    assert(
      JSON.stringify(report.environmentKeys) === JSON.stringify(expectedKeys) &&
        report.parentCanaryInherited === false &&
        report.tmpdirMatchesTask === true,
      'child inherited ambient credentials/canary or nontechnical environment',
      {
        environmentKeys: report.environmentKeys,
        parentCanaryInherited: report.parentCanaryInherited,
        tmpdirMatchesTask: report.tmpdirMatchesTask,
      },
    )
    assert(await instance.pidsGone(pids(report)), 'successful isolation probe left processes')
    return {
      networkTargets: [
        'public',
        '169.254 metadata',
        'verified run Postgres IP',
        'verified run Garage IP',
      ],
      networkCodes: report.network,
      absentPaths: object(report.absent),
      rootWrite: report.rootWrite,
      environmentKeys: report.environmentKeys,
      canaryNotInherited: true,
      seccomp: 2,
      uid: 10001,
      groupReaped: true,
    }
  })

  add('probe-pids-max-64-and-reaping', 'fault', async () => {
    const before = await instance.snapshot('media')
    const pending = probe('fork')
    const witness = await pendingPressure('pids-pressure-held')
    const business = await instance.businessAvailable()
    businessDuringPressure(business, witness)
    const response = await pending
    if (response.code !== undefined)
      throw new EvidenceFailure('PID probe did not return its hard-limit witness', {
        diagnostic: await instance.probeReport('pids-failed', 0),
        taskExit: await instance.failedTaskExit(),
        response: failed(response, ['processor_failed', 'invalid_response', 'transport_failed']),
        before: resources(before),
        after: resources(await instance.snapshot('media')),
        business,
      })
    const report = reportFrom(response)
    assert(
      report.refused === true &&
        report.max === 64 &&
        report.peak === 64 &&
        number(report.current) <= 64 &&
        number(object(report.after).max) > number(object(report.before).max),
      'fork probe did not hit real pids.max/pids.events',
      {
        refused: report.refused,
        current: report.current,
        peak: report.peak,
        max: report.max,
        before: report.before,
        after: report.after,
      },
    )
    assert(await instance.pidsGone(pids(report)), 'fork descendants remained after EOF')
    return {
      actualPidsMax: 64,
      observedCurrent: report.current,
      observedPeak: report.peak,
      childExitCode: report.childExitCode,
      deniedForks: number(object(report.after).max) - number(object(report.before).max),
      releasedForReport: report.releasedForReport,
      pressureWitness: witness,
      descendantsReaped: pids(report).length,
      business,
    }
  })

  add('probe-tmpfs-enospc-release', 'fault', async () => {
    const before = await instance.snapshot('media')
    const pending = probe('tmpfs')
    const witness = await pendingPressure('tmpfs-pressure-held')
    const business = await instance.businessAvailable()
    businessDuringPressure(business, witness)
    const report = reportFrom(await pending)
    assert(
      report.code === 'ENOSPC' &&
        report.filesystemType === 0x01021994 &&
        number(report.written) > 250 * MiB &&
        number(report.written) <= 256 * MiB &&
        number(report.freeBytesAfterRelease) > 250 * MiB,
      'tmpfs did not fill/release under its real 256 MiB limit',
    )
    const after = await instance.snapshot('media')
    return {
      code: 'ENOSPC',
      filledBytes: report.written,
      releasedFreeBytes: report.freeBytesAfterRelease,
      tmpfsBytes: before.tmpTotalBytes,
      memoryPeak: after.memoryPeak,
      pressureWitness: witness,
      business,
    }
  })

  add('probe-oom-events-and-recovery', 'fault', async () => {
    const before = await instance.snapshot('media')
    const pending = probe('oom')
    const witness = await pendingPressure('memory-pressure-held')
    assert(
      number(witness.memoryCurrent) >= number(witness.memoryMax) * 0.9,
      'OOM probe did not hold actual near-limit touched-memory pressure',
      witness,
    )
    const business = await instance.businessAvailable()
    businessDuringPressure(business, witness)
    const response = await pending
    const error = failed(response, ['processor_failed', 'transport_failed', 'invalid_response'])
    assert(
      await instance.mediaRunning(),
      'OOM killed supervisor; memory.events evidence is unavailable until runtime recovery is fixed',
    )
    await emptyTasks()
    const after = await instance.snapshot('media')
    assert(
      (after.memoryEvents.oom_kill ?? 0) > (before.memoryEvents.oom_kill ?? 0) &&
        (after.memoryEvents.max ?? 0) > (before.memoryEvents.max ?? 0),
      'no actual touched-memory cgroup OOM evidence',
    )
    return {
      ...error,
      beforeEvents: before.memoryEvents,
      afterEvents: after.memoryEvents,
      memoryPeak: after.memoryPeak,
      memoryMax: after.memoryMax,
      pressureWitness: witness,
      business,
    }
  })

  add('probe-success-reaps-grandchildren-before-eof', 'fault', async () => {
    const report = reportFrom(await probe('tree-success'))
    assert(
      pids(report).length === 3 && (await instance.pidsGone(pids(report))),
      'successful task did not reap its whole process group before EOF',
    )
    assert(
      (await instance.taskState()).entries === 0,
      'successful task sent EOF before temp cleanup',
    )
    return { processesReaped: 3, cleanupBeforeEOF: true }
  })

  add('probe-timeout-reaps-grandchildren', 'fault', async () => {
    const pending = probe('tree-timeout', { timeoutMs: 9000 })
    const report = await pendingTree()
    const business = await instance.businessAvailable()
    const error = failed(await pending, ['transport_failed', 'invalid_response'])
    await emptyTasks()
    assert(await instance.pidsGone(pids(report)), 'timeout left child/grandchild process groups')
    return { ...error, taskDeadlineMs: FAULT_MS, processesReaped: 3, business }
  })

  add('probe-client-cancel-reaps-grandchildren', 'fault', async () => {
    const pending = probe('tree-cancel', { mode: 'cancel', cancelAfterMs: 4000 })
    const report = await pendingTree()
    const business = await instance.businessAvailable()
    const error = failed(await pending, 'aborted')
    await emptyTasks()
    assert(await instance.pidsGone(pids(report)), 'client cancellation left descendants')
    return { ...error, processesReaped: 3, business }
  })

  add('probe-busy-no-second-job-or-unbounded-queue', 'fault', async () => {
    const response = await probe('tree-timeout', { mode: 'busy' })
    assert(
      response.first === 'aborted' &&
        ['transport_failed', 'connect_failed', 'invalid_response'].includes(
          String(response.second),
        ) &&
        number(response.secondElapsedMs) < 1500,
      'second concurrent connection queued or processed',
    )
    return {
      first: response.first,
      second: response.second,
      secondElapsedMs: response.secondElapsedMs,
      singleConcurrency: true,
    }
  })

  add('probe-disconnected-slow-sink-bounded', 'fault', async () => {
    const before = await instance.snapshot('worker')
    const response = await probe('large-output', { mode: 'blocked-sink', timeoutMs: 1200 })
    const error = failed(response, 'timeout')
    assert(
      response.sinkAborted === true && number(response.rssDelta) < 32 * MiB,
      'blocked sink failed to cancel or accumulated unbounded bytes',
    )
    await emptyTasks()
    const after = await instance.snapshot('worker')
    return {
      ...error,
      sinkAborted: true,
      workerClientRssDelta: response.rssDelta,
      workerMemoryBefore: before.memoryCurrent,
      workerMemoryAfter: after.memoryCurrent,
    }
  })

  add('probe-slow-reader-supervisor-deadline-and-backpressure', 'fault', async () => {
    let settled = false
    const pending = probe('large-output', { mode: 'paused-output', timeoutMs: 10_000 }).then(
      (response) => {
        settled = true
        return response
      },
    )
    await instance.waitUntil(
      async () => (await instance.taskState()).entries === 1,
      2000,
      'paused output active task',
    )
    const business = await instance.businessAvailable()
    await emptyTasks()
    assert(!settled, 'task cleanup only happened after the receiver disconnected')
    const response = await pending
    assert(
      // Bun's native Unix read batch can overshoot the JS high-water mark, but must backpressure this 4 MiB output.
      number(response.maxBufferedBytes) <= 8 * MEDIA_LIMITS.chunkBytes &&
        response.transportTimedOut === false,
      'paused receiver buffering was unbounded',
      {
        bufferedBytes: response.maxBufferedBytes,
        transportTimedOut: response.transportTimedOut,
        elapsedMs: response.elapsedMs,
      },
    )
    return {
      boundedSocketBytes: response.maxBufferedBytes,
      supervisorCleanedBeforeClientClose: true,
      taskDeadlineMs: FAULT_MS,
      business,
    }
  })

  for (const operation of [
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
    add(`reject-child-${operation}`, 'fault', async () =>
      failed(await probe(operation), 'processor_failed'),
    )
  add('reject-child-output-limit', 'fault', async () =>
    failed(await probe('large-output', { maxOutputBytes: 128 }), 'output_limit'),
  )

  add('probe-cleanup-failure-fail-closed-and-restart', 'fault', async () => {
    const response = await probe('cleanup-failure')
    const error = failed(response, ['transport_failed', 'invalid_response'])
    await instance.waitUntil(
      async () => !(await instance.mediaRunning()),
      6000,
      'fail-closed supervisor exit',
    )
    assert(
      await instance.logFlag('media_cleanup_failed'),
      'cleanup failure did not emit fixed fail-closed diagnostic',
    )
    const rejected = await probe('noop')
    failed(rejected, 'connect_failed')
    const business = await instance.businessAvailable()
    await instance.action('media', 'start')
    await emptyTasks()
    assert(
      reportFrom(await probe('noop')).operation === 'noop',
      'restarted supervisor did not recover IPC',
    )
    return { ...error, refusedNewJobBeforeRestart: true, restarted: true, business }
  })

  add('probe-kill-media-stale-socket-and-temp-recovery', 'fault', async () => {
    let stage = 'admit-tree'
    try {
      const pending = probe('tree-timeout', { timeoutMs: 9000 })
      const report = await pendingTree()
      assert(
        (await instance.probeReport('tree', number(report.observedAtMs))) !== null,
        'no observed old task existed before container kill',
      )
      stage = 'verified-kill'
      await instance.action('media', 'kill')
      stage = 'client-failure-after-kill'
      const error = failed(await pending, ['transport_failed', 'invalid_response'])
      stage = 'business-available-while-media-stopped'
      const business = await instance.businessAvailable()
      stage = 'verified-start'
      await instance.action('media', 'start')
      stage = 'startup-empty-taskroot'
      await emptyTasks()
      stage = 'startup-recovery-and-pids'
      assert(
        (await instance.logFlag('media_test_startup_recovered')) &&
          (await instance.pidsGone(pids(report))),
        'restart retained stale tasks/groups',
      )
      stage = 'new-socket-ipc'
      assert(
        reportFrom(await probe('noop')).operation === 'noop',
        'restart did not replace the stale socket and recover IPC',
      )
      return {
        ...error,
        oldTaskWasPresent: true,
        startupAbandonedFilesRecovered: true,
        newIPC: true,
        business,
      }
    } catch (error) {
      throw new EvidenceFailure(`media kill/restart failed at ${stage}`, {
        stage,
        error: safeError(error),
      })
    }
  })

  const selected = cases.filter(
    (entry) => (phase === 'all' || entry.phase === phase) && selection.test(entry.name),
  )
  try {
    assert(selected.length > 0, 'no matching cases')
    console.info(
      `media run ${runId}: ${selected.length} cases; isolated instance verified; background hard limit 2048 MiB`,
    )
    for (const entry of selected) {
      assert(
        !interrupted && performance.now() - started < 14 * 60_000,
        'suite interrupted or exceeded its 14-minute budget',
      )
      if (entry.phase !== currentPhase) {
        await instance.switchImage(entry.phase === 'fault' ? 'fault' : 'runtime')
        currentPhase = entry.phase
      }
      await instance.verify()
      const began = performance.now()
      const result: Result = { name: entry.name, phase: entry.phase, status: 'pass', elapsedMs: 0 }
      try {
        result.evidence = await entry.run()
      } catch (error) {
        result.status = 'fail'
        result.error = safeError(error)
        if (error instanceof EvidenceFailure) result.evidence = error.evidence
      }
      try {
        await recover()
        result.recovery = 'taskroot-empty-and-IPC-usable'
      } catch (error) {
        result.status = 'fail'
        result.recovery = safeError(error)
        try {
          snapshots.push({
            case: entry.name,
            phase: 'recovery-failed',
            ...resources(await instance.snapshot('media')),
          })
        } catch (snapshotError) {
          snapshots.push({
            case: entry.name,
            phase: 'recovery-failed',
            snapshotUnavailable: safeError(snapshotError),
          })
        }
      }
      result.elapsedMs = performance.now() - began
      results.push(result)
      console.info(
        `${result.status.toUpperCase()} ${entry.name} (${Math.round(result.elapsedMs)} ms)${result.error ? `: ${result.error}` : ''}`,
      )
      await persist()
      if (result.recovery !== 'taskroot-empty-and-IPC-usable')
        throw new Error('m3: recovery failed; refusing further probes')
    }
    for (const service of ['media', 'worker', 'api'] as const)
      snapshots.push({ service, phase: 'final', ...resources(await instance.snapshot(service)) })
    code = results.every((result) => result.status === 'pass') ? 0 : 1
  } catch (error) {
    console.error(safeError(error))
  } finally {
    try {
      await instance.close()
      teardown = 'verified-run-only-removed'
    } catch (error) {
      teardown = safeError(error)
      code = 1
    }
    await persist()
    process.off('SIGTERM', interrupt)
    process.off('SIGINT', interrupt)
    console.info(
      `media run ${runId}: ${results.filter((result) => result.status === 'pass').length} pass / ${results.filter((result) => result.status === 'fail').length} fail / ${selected.length - results.length} unexecuted; ${teardown}; evidence ${directory}/result.json`,
    )
  }
  return code
}

if (import.meta.main) {
  try {
    process.exitCode = await runMediaTests(process.argv.slice(2))
  } catch (error) {
    console.error(safeError(error))
    process.exitCode = 1
  }
}
