/** Native ARM quality evaluation, with a fresh fault instance and generated credentials kept only locally. */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evaluationSourceManifest, sourceDigest } from '../apps/server/evals/source-manifest.ts'
import { assertEmbeddingEvidence } from '../apps/server/src/runtime/embedding-evidence.ts'
import { readEnvFile, setEnv, writeEnvFile } from './lib/env-file.ts'
import { verifyMediaTestLocation } from './lib/media-test-infra.ts'
import { startInstance, stopInstance } from './lib/test-infra.ts'

await verifyMediaTestLocation()
if (process.arch !== 'arm64') throw new Error('This acceptance command requires native ARM')
const { manifest } = await startInstance()
try {
  const sourceHash = sourceDigest(JSON.stringify(await evaluationSourceManifest()))
  const before = new Set(await readdir('.test-runs/m5'))
  let image: string | undefined, resources: Record<string, unknown> | undefined
  for (const directory of [...before].filter((p) => p.startsWith('mixed-'))) {
    const file = Bun.file(`.test-runs/m5/${directory}/result.json`)
    if (!(await file.exists())) continue
    const result = (await file.json()) as Record<string, unknown>
    if (result.architecture === 'arm64' && result.sourceHash === sourceHash)
      [image, resources] = [String(result.workerImageId), result]
  }
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image))
    throw new Error('Run the native Debian mixed benchmark on this exact source first')
  const env = await readEnvFile('.env.local')
  setEnv(env, 'DATABASE_OWNER_URL_TEST', manifest.endpoints.databaseOwnerUrl)
  setEnv(env, 'DATABASE_URL_TEST', manifest.endpoints.databaseUrl)
  setEnv(env, 'VALKEY_URL_TEST', manifest.endpoints.valkeyUrl)
  await writeEnvFile(env)
  for (const phase of ['--dev', '--holdout']) {
    const proc = Bun.spawn(
      [
        'docker',
        'run',
        '--rm',
        '--network=host',
        '--user=0:0',
        '--cpus=2',
        '--memory=1536m',
        '--read-only',
        '--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=128m',
        '--mount',
        `type=bind,src=${resolve('.')},dst=/app`,
        '--workdir=/app',
        image,
        'bun',
        '--no-env-file',
        'apps/server/evals/m5-search.ts',
        'bge',
        ...(phase === '--dev' ? [phase] : []),
      ],
      { stdout: 'inherit', stderr: 'inherit' },
    )
    if ((await proc.exited) !== 0) throw new Error(`Native ${phase} quality gate failed`)
  }
  let quality: Record<string, unknown> | undefined
  for (const directory of (await readdir('.test-runs/m5')).filter(
    (p) => !before.has(p) && p.startsWith('search-bge-holdout-'),
  )) {
    const result = JSON.parse(
      await readFile(`.test-runs/m5/${directory}/result.json`, 'utf8'),
    ) as Record<string, unknown>
    if (result.sourceHash === sourceHash) quality = result
  }
  assertEmbeddingEvidence('bge-small-zh-q8-75c43b06', quality, resources)
  const directory = `.test-runs/m5/native-gate-${sourceHash.slice(0, 16)}`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(
    `${directory}/result.json`,
    `${JSON.stringify({ sourceHash, modelVersion: 'bge-small-zh-q8-75c43b06', qualityAndResourcesPass: true }, null, 2)}\n`,
    { mode: 0o600 },
  )
  console.log(JSON.stringify({ directory, qualityAndResourcesPass: true, sourceHash }))
} finally {
  await stopInstance(manifest.runId)
}
