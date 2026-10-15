/** Explicit controlled-data load entrypoint, pinned to the official amd64/arm64 k6 index. */

import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { POLICIES } from '../apps/server/src/http/policies.ts'
import { rateLimitIpKey as ipGroup } from '../apps/server/src/lib/ip.ts'
import {
  benchmarkProfileSchema,
  loadControllerSchema,
  loadFixtureSchema,
} from '../packages/contracts/src/benchmark.ts'
import { runSlowWebSockets } from './production-slow-ws.ts'
export const K6_IMAGE =
  'grafana/k6:2.3.0@sha256:9c2dee7f8ed74d317e4027c06a10f169b625638189de8d4555d0b3486a5aeb34'
export async function runProductionLoad(
  file: string,
  profile: string,
  output: string,
  distribution = 'normal',
  options: {
    networkId?: string
    caFile?: string
    hosts?: Record<string, string>
    connectHost?: string
    connectPort?: number
    clientMatrix?: boolean
  } = {},
) {
  if (!file || !output)
    throw new Error(
      'usage: production-load.ts PRIVATE_FIXTURE smoke|full NEW_RESULT_DIR [normal|hot]',
    )
  benchmarkProfileSchema.parse(profile)
  const fixtureFile = resolve(file),
    info = await lstat(fixtureFile)
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024 * 1024)
    throw new Error('private bounded benchmark fixture required')
  const fixture = loadFixtureSchema.parse(JSON.parse(await readFile(fixtureFile, 'utf8')))
  if (new URL(fixture.origin).protocol !== 'https:')
    throw new Error('HTTPS benchmark origin required')
  if (profile === 'full' && fixture.profile !== 'full') throw new Error('full dataset required')
  const controller = loadControllerSchema.parse({
    distribution,
    clientMatrix:
      options.clientMatrix ??
      (process.env.CHATAPP_LOAD_CLIENT_MATRIX === undefined
        ? profile === 'full'
        : process.env.CHATAPP_LOAD_CLIENT_MATRIX === 'true'),
    sourceIps: process.env.CHATAPP_LOAD_LOCAL_IPS?.split(',') ?? [],
  })
  if (
    process.env.CHATAPP_LOAD_CLIENT_MATRIX !== undefined &&
    !['true', 'false'].includes(process.env.CHATAPP_LOAD_CLIENT_MATRIX)
  )
    throw new Error('explicit client matrix required')
  const assigned = new Set(
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address.split('%')[0]),
  )
  if (controller.sourceIps.some((ip) => !assigned.has(ip)))
    throw new Error('source IPs must already be configured on this controller')
  const groups = new Set(controller.sourceIps.map(ipGroup))
  if (profile === 'full' && groups.size < Math.ceil(500 / POLICIES.wsConnectIp.limit))
    throw new Error(
      'full load requires enough verified source IP groups for unchanged connection admission',
    )
  // Initial connects and the storm at 302s occupy separate admission windows; use one equally weighted IP per group.
  if (profile === 'full' && groups.size !== controller.sourceIps.length)
    throw new Error('full load requires one configured source IP per independent rate-limit group')
  const slowCount = controller.clientMatrix ? (profile === 'full' ? 50 : 1) : 0
  const fastCount = (profile === 'full' ? 500 : 4) - slowCount
  if (fixture.users.length < fastCount + slowCount)
    throw new Error('distinct steady clients required')
  const seconds = profile === 'full' ? 2100 : 30
  const sourceBefore = await Promise.all(
    ['scripts/production-load.ts', 'scripts/production-slow-ws.ts', 'infra/load/chat.js'].map(
      (path) => readFile(path),
    ),
  )
  const controllerHash = createHash('sha256').update(Buffer.concat(sourceBefore)).digest('hex')
  const result = resolve(output)
  await mkdir(result, { mode: 0o700 })
  const args = [
    'docker',
    'run',
    '--rm',
    '--network',
    options.networkId ?? 'host',
    '--user',
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    profile === 'full' ? '2g' : '512m',
    '--memory-swap',
    profile === 'full' ? '2g' : '512m',
    '--cpus',
    profile === 'full' ? '2' : '0.5',
    '--tmpfs',
    '/tmp:size=67108864,mode=1777,nosuid,nodev',
    '--mount',
    `type=bind,src=${fixtureFile},dst=/run/chatapp-load/fixture.json,readonly`,
    '--mount',
    `type=bind,src=${resolve('infra/load/chat.js')},dst=/run/chatapp-load/chat.js,readonly`,
    '--mount',
    `type=bind,src=${result},dst=/result`,
    '--env',
    `CHATAPP_LOAD_PROFILE=${profile}`,
    '--env',
    `CHATAPP_LOAD_DISTRIBUTION=${controller.distribution}`,
    '--env',
    `CHATAPP_LOAD_FAST_CONNECTIONS=${fastCount}`,
    '--env',
    `CHATAPP_LOAD_CLIENT_MATRIX=${controller.clientMatrix}`,
    K6_IMAGE,
    'run',
    '--no-usage-report',
    '--log-output',
    'stderr',
  ]
  if (options.networkId && !/^[a-f0-9]{64}$/.test(options.networkId))
    throw new Error('verified network ID required')
  if (options.caFile)
    args.splice(
      args.indexOf(K6_IMAGE),
      0,
      '--mount',
      `type=bind,src=${resolve(options.caFile)},dst=/run/chatapp-load/ca.pem,readonly`,
      '--env',
      'SSL_CERT_FILE=/run/chatapp-load/ca.pem',
    )
  if (options.hosts) {
    // Hosts has no CLI/environment equivalent in k6. Port overrides preserve the real Host and TLS identity.
    await writeFile(
      join(result, 'controller-config.json'),
      JSON.stringify({ hosts: options.hosts }) + '\n',
      { mode: 0o600, flag: 'wx' },
    )
    args.push('--config', '/result/controller-config.json')
  }
  if (controller.sourceIps.length) args.push(`--local-ips=${controller.sourceIps.join(',')}`)
  if (profile === 'smoke') args.push('--out', 'json=/result/private-metrics.jsonl')
  args.push('/run/chatapp-load/chat.js')
  const abort = new AbortController()
  const slow = slowCount
    ? runSlowWebSockets(
        { ...fixture, users: fixture.users.slice(fastCount, fastCount + slowCount) },
        {
          seconds: seconds + 5,
          count: slowCount,
          sourceIps: controller.sourceIps,
          ...(options.caFile ? { ca: await readFile(options.caFile, 'utf8') } : {}),
          ...(options.connectHost ? { connectHost: options.connectHost } : {}),
          ...(options.connectPort ? { connectPort: options.connectPort } : {}),
          signal: abort.signal,
        },
      )
    : Promise.resolve(null)
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
  // Raw diagnostics may include a cookie or user content on transport failure. Keep them private, never print/upload them.
  const streams = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  await writeFile(join(result, 'private-run.log'), streams.join('\n'), { mode: 0o600, flag: 'wx' })
  const exit = await child.exited
  if (profile === 'smoke') {
    try {
      await chmod(join(result, 'private-metrics.jsonl'), 0o600)
    } catch {}
  }
  if (exit !== 0) abort.abort()
  const slowReceipt = await slow
  if (slowReceipt)
    await writeFile(join(result, 'slow-ws.json'), JSON.stringify(slowReceipt, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
  const sourceAfter = await Promise.all(
    ['scripts/production-load.ts', 'scripts/production-slow-ws.ts', 'infra/load/chat.js'].map(
      (path) => readFile(path),
    ),
  )
  const controllerUnchanged =
    createHash('sha256').update(Buffer.concat(sourceAfter)).digest('hex') === controllerHash
  let summaryPresent = false
  try {
    await chmod(join(result, 'summary.json'), 0o600)
    summaryPresent = true
  } catch {}
  const receipt = {
    format: 1,
    profile,
    distribution: controller.distribution,
    clientMatrix: controller.clientMatrix,
    slowClientsPassed: slowReceipt?.healthy ?? null,
    sourceIpGroups: groups.size,
    sourceIpsVerifiedOnController: controller.sourceIps.length > 0,
    controllerHash,
    controllerUnchanged,
    sourceHash: fixture.sourceHash,
    dataset: fixture.dataset,
    exitCode: exit,
    summaryPresent,
    controllerArchitecture: process.arch,
    controllerLocation: options.networkId ? 'owned-local-test-network' : 'unverified',
    scope:
      'weighted or hot chat plus optional real slow-TLS clients and bounded connection storm; background media/vector/model/backup, target ARM resources and independent recovery remain separate gates',
  }
  await writeFile(join(result, 'result.json'), JSON.stringify(receipt, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  console.log(JSON.stringify(receipt))
  return {
    ...receipt,
    passed:
      exit === 0 && summaryPresent && controllerUnchanged && (!slowReceipt || slowReceipt.healthy),
  }
}
if (import.meta.main)
  (async () => {
    const [file, profile = 'smoke', output, distribution = 'normal'] = process.argv.slice(2)
    if (!file || !output) throw new Error('private fixture and output required')
    if (!(await runProductionLoad(file, profile, output, distribution)).passed) process.exitCode = 1
  })().catch(() => {
    console.error('load execution rejected or failed; no capacity acceptance claimed')
    process.exitCode = 1
  })
