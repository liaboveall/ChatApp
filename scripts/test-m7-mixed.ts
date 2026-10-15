/** Local mixed smoke, always on a fresh, verified compose.test project. Full ARM capacity is a separate run. */
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { S3Client } from 'bun'
import { createConsistentBackup } from '../apps/server/src/domain/backups.ts'
import type { Deps } from '../apps/server/src/domain/deps.ts'
import { systemClock } from '../apps/server/src/lib/clock.ts'
import { silentLogger } from '../apps/server/src/lib/logger.ts'
import { loadFixtureSchema } from '../packages/contracts/src/benchmark.ts'
import { processHealthSchema } from '../packages/contracts/src/operations.ts'
import { createDatabase } from '../packages/db/src/client.ts'
import { MediaTestInstance, verifyMediaTestLocation } from './lib/media-test-infra.ts'
import { candidateInventory } from './production.ts'
import { runProductionLoad } from './production-load.ts'

async function capture(args: string[]) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  const [out] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if ((await child.exited) !== 0) throw new Error('mixed infrastructure command failed')
  return out.trim()
}
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
async function harnessFingerprint() {
  const files = [
    'scripts/test-m7-mixed.ts',
    'scripts/lib/media-test-infra.ts',
    'scripts/lib/test-infra.ts',
    'scripts/edge.ts',
    'apps/server/test/media/embedding-mixed.ts',
    'infra/compose.test.yml',
    'infra/compose.media.yml',
    'infra/compose.edge.yml',
  ]
  return hash(
    JSON.stringify(
      await Promise.all(
        files.map(async (path) => ({
          path,
          sha256: hash(await readFile(path)),
        })),
      ),
    ),
  )
}
async function saveStream(path: string, stream: ReadableStream<Uint8Array>) {
  await writeFile(path, new Uint8Array(0), { flag: 'wx', mode: 0o600 })
  const writer = Bun.file(path).writer(),
    reader = stream.getReader(),
    digest = createHash('sha256')
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      digest.update(chunk.value)
      writer.write(chunk.value)
      await writer.flush()
    }
  } finally {
    await writer.end()
    await reader.cancel()
  }
  return { size, sha256: digest.digest('hex') }
}

await verifyMediaTestLocation()
if (process.argv.length > 2)
  throw new Error(
    'this entrypoint is the bounded local smoke; full capacity uses the target ARM dataset and external controller',
  )
const inventory = await candidateInventory(),
  sourceHash = inventory.applicationSourceHash,
  harnessHash = await harnessFingerprint()
const existingEdge = await capture([
  'docker',
  'ps',
  '-aq',
  '--filter',
  'label=com.docker.compose.project=chatapp-edge',
])
if (existingEdge) throw new Error('edge gateway already belongs to another run')
const instance = await MediaTestInstance.start({
  origin: 'https://chat.localhost:8443',
  apiPort: 26402,
  mockStream: { chunkChars: 2, chunkDelayMs: 25 },
})
const controlId = crypto.randomUUID()
const dir = resolve('.test-runs/m7-mixed', instance.manifest.runId)
await mkdir(dir, { recursive: true, mode: 0o700 })
const database = createDatabase(instance.manifest.endpoints.databaseOwnerUrl, {
  max: 6,
  applicationName: 'm7-mixed-observer',
})
let edgeId: string | undefined,
  probe: Promise<Uint8Array> | undefined,
  probeSettled = false
let backupLoop: Promise<void> | undefined,
  cleaned = false
let backupFailed = false
const backups: {
  databaseBytes: number
  objectBytes: number
  objects: number
  durationMs: number
}[] = []
const outcome: Record<string, unknown> = {
  format: 1,
  status: 'running',
  sourceHash,
  harnessHash,
  mockStream: { chunkChars: 2, chunkDelayMs: 25 },
  scope:
    'local 30-second mixed smoke; synthetic models, native media/BGE, HTTPS weighted chat, actual slow TLS reads and native consistent local backup copies',
}
try {
  await instance.limitToTwoCores()
  const root = resolve(
    '.test-runs/m5/models/Xenova/bge-small-zh-v1.5/75c43b069aac4d136ba6bc1122f995fedcfd2781',
  )
  const files: { path: string; data: string }[] = []
  for (const name of await readdir(root, { recursive: true })) {
    const path = join(root, name),
      info = await lstat(path)
    if (info.isDirectory()) continue
    if (!info.isFile() || info.size > 64 * 1024 * 1024)
      throw new Error('regular bounded public model required')
    files.push({ path: relative(root, path), data: (await readFile(path)).toString('base64') })
  }
  const samples = {
    png: Buffer.from(await instance.sample('generate', 'png')).toString('base64'),
    gif: Buffer.from(await instance.sample('generate', 'gif')).toString('base64'),
  }
  // Fixed edge is refused when occupied. Pin its exact container before later cleanup.
  await capture(['bun', '--no-env-file', 'scripts/edge.ts', 'up', '--m3'])
  edgeId = await capture([
    'docker',
    'ps',
    '-q',
    '--filter',
    'label=com.docker.compose.project=chatapp-edge',
    '--filter',
    'label=com.docker.compose.service=nginx',
  ])
  if (!/^[a-f0-9]{12,64}$/.test(edgeId)) throw new Error('one owned edge container required')
  const networks = JSON.parse(
    await capture(['docker', 'inspect', '--format', '{{json .NetworkSettings.Networks}}', edgeId]),
  ) as Record<string, { NetworkID: string; IPAddress: string }>
  const network = Object.values(networks)[0]
  if (!network || !/^[a-f0-9]{64}$/.test(network.NetworkID) || !/^[0-9.]+$/.test(network.IPAddress))
    throw new Error('owned edge network unavailable')
  const code = (await readFile('apps/server/test/media/embedding-mixed.ts', 'utf8')).replaceAll(
    "'../../src/",
    "'/app/apps/server/src/",
  )
  probe = instance.exec(
    'worker',
    code,
    Buffer.from(
      JSON.stringify({
        files,
        ...samples,
        controlId,
        sourceHash,
        seconds: 30,
      }),
    ),
    240_000,
  )
  void probe.then(
    () => {
      probeSettled = true
    },
    () => {
      probeSettled = true
    },
  )
  const deadline = Date.now() + 120_000
  for (;;) {
    const [state] =
      await database.client`select value from app_settings where key = ${`m7.mixed.${controlId}`}`
    if (
      state?.value &&
      typeof state.value === 'object' &&
      'phase' in state.value &&
      state.value.phase === 'ready'
    )
      break
    if (probeSettled || Date.now() > deadline) throw new Error('mixed native probe did not prepare')
    await delay(200)
  }
  await writeFile(
    join(dir, 'fixture.json'),
    await instance.exec(
      'worker',
      "console.log(await Bun.file('/tmp/m7-mixed-fixture.json').text())",
    ),
    { flag: 'wx', mode: 0o600 },
  )
  const fixture = loadFixtureSchema.parse(
    JSON.parse(await readFile(join(dir, 'fixture.json'), 'utf8')),
  )
  if (fixture.sourceHash !== sourceHash || fixture.runId !== controlId)
    throw new Error('mixed fixture identity mismatch')
  const endpoints = instance.manifest.endpoints
  const store = new S3Client({
    endpoint: endpoints.s3Endpoint,
    region: 'garage',
    bucket: endpoints.s3Bucket,
    accessKeyId: endpoints.s3AccessKeyId,
    secretAccessKey: endpoints.s3SecretAccessKey,
    retry: 0,
  })
  const deps: Deps = {
    db: database.db,
    clock: systemClock,
    newId: () => crypto.randomUUID(),
    log: silentLogger,
    config: {
      origin: fixture.origin,
      timezone: 'Asia/Shanghai',
      product: { name: 'Mixed fixture', agentUsername: 'agent', agentDisplayName: '助手' },
      auth: {
        tokenEncryptionKey: randomBytes(32),
        cursorKey: randomBytes(32),
        restoreEpoch: 'local-mixed-fixture',
      },
    },
    passwords: {
      async hash() {
        throw new Error('not used')
      },
      async verify() {
        throw new Error('not used')
      },
    },
  }
  const applicationSha = await capture(['git', 'rev-parse', 'HEAD'])
  const material = Buffer.from(
    JSON.stringify({ version: 1, syntheticKey: randomBytes(32).toString('base64url') }),
  )
  await writeFile(join(dir, 'fixture-material.json'), material, { flag: 'wx', mode: 0o600 })
  const copyBackup = async () => {
    await instance.verify()
    const start = performance.now(),
      path = join(dir, `backup-${backups.length}`)
    await mkdir(path, { mode: 0o700 })
    await mkdir(join(path, 'objects'), { mode: 0o700 })
    const owner = new URL(endpoints.databaseOwnerUrl)
    const manifest = await createConsistentBackup(deps, {
      applicationSha,
      applicationSourceHash: sourceHash,
      keyVersions: [1],
      recoveryFiles: [{ name: 'fixture-material.json', sha256: hash(material) }],
      async exportDatabase(snapshot) {
        const child = Bun.spawn(
          [
            'docker',
            'exec',
            '--user',
            'postgres',
            instance.manifest.services.postgres.containerId,
            'pg_dump',
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--snapshot=${snapshot}`,
            `--username=${decodeURIComponent(owner.username)}`,
            `--dbname=${owner.pathname.slice(1)}`,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const err = new Response(child.stderr).text()
        const result = await saveStream(join(path, 'database.dump'), child.stdout)
        await writeFile(join(path, 'private-dump.log'), await err, { flag: 'wx', mode: 0o600 })
        if ((await child.exited) !== 0) throw new Error('native snapshot export failed')
        return result
      },
      async copyObject(object) {
        const copied = await saveStream(
          join(path, 'objects', hash(object.key)),
          store.file(object.key).stream(),
        )
        if (copied.size !== object.size || copied.sha256 !== object.sha256)
          throw new Error('backup object readback failed')
      },
      async uploadAndVerify(manifest) {
        const file = join(path, 'manifest.json'),
          bytes = JSON.stringify(manifest)
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
        const digest = hash(await readFile(file))
        if (digest !== hash(bytes)) throw new Error('local manifest readback failed')
        return { manifestKey: `local-mixed/${manifest.runId}/manifest.json`, manifestHash: digest }
      },
    })
    backups.push({
      databaseBytes: manifest.database.size,
      objects: manifest.objects.length,
      objectBytes: manifest.objects.reduce((sum, row) => sum + row.size, 0),
      durationMs: performance.now() - start,
    })
  }
  await database.client`update app_settings set value = ${{ phase: 'run' }}::jsonb where key = ${`m7.mixed.${controlId}`}`
  backupLoop = (async () => {
    do {
      await copyBackup()
      await delay(100)
    } while (!probeSettled)
  })().catch(async (error) => {
    backupFailed = true
    await writeFile(
      join(dir, 'private-backup-failure.log'),
      error instanceof Error && 'stage' in error ? String(error.stage) : 'backup-io-failed',
      { mode: 0o600, flag: 'wx' },
    )
  })
  // Observe both tasks even if either fails; no unhandled rejection may leave this owned test stack behind.
  const load = await runProductionLoad(
    join(dir, 'fixture.json'),
    'smoke',
    join(dir, 'load'),
    'normal',
    {
      networkId: network.NetworkID,
      hosts: { 'chat.localhost:8443': `${network.IPAddress}:443` },
      caFile: resolve('.test-runs/edge/certs/chat.localhost.crt'),
      connectHost: '127.0.0.1',
      connectPort: 8443,
      clientMatrix: true,
    },
  )
  const raw = await probe
  await writeFile(join(dir, 'private-probe.json'), raw, { flag: 'wx', mode: 0o600 })
  const native = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
  if (native.error || !load.passed) throw new Error('mixed component failed')
  await backupLoop
  if (backupFailed) throw new Error('mixed backup failed')
  const worker = await instance.snapshot('worker'),
    media = await instance.snapshot('media'),
    api = await instance.snapshot('api')
  const eventLoops = await Promise.all(
    (['worker', 'api'] as const).map(async (service) => {
      const value = processHealthSchema.parse(
        JSON.parse(
          new TextDecoder().decode(
            await instance.exec(
              service,
              'console.log(await Bun.file(process.env.PROCESS_HEALTH_FILE).text())',
            ),
          ),
        ),
      )
      if (
        value.service !== service ||
        !value.eventLoop?.samples ||
        Date.now() - value.updatedAt > 35000
      )
        throw new Error('main process telemetry unavailable')
      return { service, ...value.eventLoop }
    }),
  )
  if (
    Number(native.childPeakBytes) > 1024 ** 3 ||
    worker.memoryPeak > 1536 * 1024 ** 2 ||
    media.memoryPeak > 512 * 1024 ** 2 ||
    api.memoryPeak > 1024 ** 3 ||
    worker.memoryPeak + media.memoryPeak > 2 * 1024 ** 3 ||
    [worker, media, api].some((value) => value.memoryEvents.oom || value.memoryEvents.oom_kill)
  )
    throw new Error('mixed resource limits exceeded')
  if (
    !backups.length ||
    Number(native.maxModels) < 4 ||
    Number(native.vectorRequests) < 1 ||
    Number(native.mixedOverlapSamples) < 1
  )
    throw new Error('mixed workload missing')
  Object.assign(outcome, {
    status: 'pass',
    ...instance.metadata(),
    native,
    backups,
    load,
    workerPeakBytes: worker.memoryPeak,
    mediaPeakBytes: media.memoryPeak,
    apiPeakBytes: api.memoryPeak,
    eventLoops,
    eventLoopScope:
      'main API/worker processes, cumulative since process readiness; nanoseconds converted to milliseconds',
    sourceUnchanged: sourceHash === (await candidateInventory()).applicationSourceHash,
    harnessUnchanged: harnessHash === (await harnessFingerprint()),
    limitations: [
      '8 benchmark users plus 10 native workload users; 120 seed messages and three 4KiB objects',
      '30 seconds, four fast/slow baseline connections and four extra reconnections; no full 500-connection or target dataset admission',
      'load and observation processes share this host; only application/worker/media are pinned to cores 0,1',
      'local verified backup copies use synthetic fixture material; no offsite upload, production schedule or independent recovery proof',
      'failure/backpressure matrices and whole ARM resource admission remain open',
    ],
  })
  if (!outcome.sourceUnchanged || !outcome.harnessUnchanged) throw new Error('mixed source changed')
} catch (error) {
  await writeFile(
    join(dir, 'private-failure.log'),
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : 'unknown',
    { mode: 0o600, flag: 'wx' },
  )
  Object.assign(outcome, { status: 'fail', reason: 'mixed-smoke-failed' })
  const snapshots = await Promise.allSettled(
    ['worker', 'media', 'api'].map((service) =>
      instance.snapshot(service as 'worker' | 'media' | 'api'),
    ),
  )
  await writeFile(join(dir, 'private-failure-context.json'), JSON.stringify(snapshots, null, 2), {
    mode: 0o600,
    flag: 'wx',
  })
  process.exitCode = 1
} finally {
  await finish()
}
async function finish() {
  probeSettled = true
  await backupLoop?.catch(() => {})
  await instance.close()
  if (probe) {
    try {
      const bytes = await probe
      try {
        await writeFile(join(dir, 'private-probe.json'), bytes, { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
    } catch (error) {
      await writeFile(
        join(dir, 'private-probe-failure.log'),
        error instanceof Error ? error.message : 'unknown',
        { mode: 0o600, flag: 'wx' },
      )
    }
  }
  await database.close()
  if (edgeId) {
    const current = await capture([
      'docker',
      'ps',
      '-q',
      '--filter',
      'label=com.docker.compose.project=chatapp-edge',
      '--filter',
      'label=com.docker.compose.service=nginx',
    ])
    if (current !== edgeId) throw new Error('edge ownership changed; cleanup rejected')
    await capture(['bun', '--no-env-file', 'scripts/edge.ts', 'down'])
  }
  cleaned = true
  await writeFile(
    join(dir, 'result.json'),
    JSON.stringify({ ...outcome, cleaned }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  )
  await chmod(join(dir, 'result.json'), 0o600)
  console.log(JSON.stringify({ status: outcome.status, cleaned, dir }))
}
