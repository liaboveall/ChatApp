/** M5 mixed native benchmark. Uses only a disposable, ownership-verified API/worker/media infrastructure. */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { evaluationSourceManifest, sourceDigest } from '../apps/server/evals/source-manifest.ts'
import { MediaTestInstance, verifyMediaTestLocation } from './lib/media-test-infra.ts'

await verifyMediaTestLocation()
const instance = await MediaTestInstance.start(),
  dir = resolve('.test-runs/m5', `mixed-${instance.manifest.runId}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const sourceHash = sourceDigest(JSON.stringify(await evaluationSourceManifest()))
try {
  await instance.limitToTwoCores()
  const root = resolve(
      '.test-runs/m5/models/Xenova/bge-small-zh-v1.5/75c43b069aac4d136ba6bc1122f995fedcfd2781',
    ),
    files: { path: string; data: string }[] = []
  let modelFileBytes = 0
  for (const name of await readdir(root, { recursive: true })) {
    const path = join(root, name)
    if (!(await stat(path)).isFile()) continue
    const bytes = await readFile(path)
    modelFileBytes += bytes.byteLength
    files.push({ path: relative(root, path), data: bytes.toString('base64') })
  }
  const code = (await readFile('apps/server/test/media/embedding-mixed.ts', 'utf8')).replaceAll(
      "'../../src/",
      "'/app/apps/server/src/",
    ),
    png = Buffer.from(await instance.sample('generate', 'png')).toString('base64'),
    gif = Buffer.from(await instance.sample('generate', 'gif')).toString('base64')
  const raw = await instance.exec(
      'worker',
      code,
      Buffer.from(JSON.stringify({ files, png, gif })),
      240000,
    ),
    probe = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>
  if (probe.error) {
    await writeFile(join(dir, 'failure.json'), `${JSON.stringify(probe, null, 2)}\n`, {
      mode: 0o600,
    })
    throw new Error(`mixed-load probe: ${String(probe.error)}`)
  }
  const worker = await instance.snapshot('worker'),
    media = await instance.snapshot('media'),
    metadata = instance.metadata(),
    result = {
      ...metadata,
      ...probe,
      sourceHash,
      sourceUnchanged:
        sourceHash === sourceDigest(JSON.stringify(await evaluationSourceManifest())),
      cpuLimit: 2,
      sharedCpuSet: '0,1',
      native: true,
      debian: true,
      mixedLoad: true,
      modelVersion: 'bge-small-zh-q8-75c43b06',
      modelFileBytes,
      workerPeakBytes: worker.memoryPeak,
      mediaPeakBytes: media.memoryPeak,
      childPeakBytes: probe.childPeakBytes,
      p95Ms: probe.p95Ms,
      source: 'current checkout, actual API/worker/media containers',
      limitation:
        'AI workload uses the SDK mock; model quality has a separate real-provider evaluation',
    }
  await writeFile(join(dir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ dir, ...result }))
} finally {
  await instance.close()
}
