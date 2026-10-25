import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { privateJson, runPrivate } from '../apps/server/src/runtime/operations-files.ts'
import { releaseManifestSchema } from '../packages/contracts/src/operations.ts'
import { PRODUCTION_DEPENDENCIES } from './production-images.ts'
export const TRIVY_IMAGE =
  'aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa'
async function main() {
  const file = process.argv[2]
  if (!file) throw new Error('private release manifest required')
  const manifest = await privateJson(file, releaseManifestSchema, 32 * 1024 * 1024)
  // One immutable image per Docker archive: Trivy receives no socket or application configuration.
  const directory = resolve(dirname(file)),
    stage = join(directory, `scan-${crypto.randomUUID()}`)
  await mkdir(stage, { mode: 0o700 })
  let failed = false
  const images = { ...manifest.images }
  if (['server', 'media', 'ops', 'postgres', 'nginx'].some((name) => !images[name]))
    throw new Error('complete source-bound runtime images required')
  for (const [name, reference] of Object.entries(PRODUCTION_DEPENDENCIES))
    if (!images[name]) {
      await runPrivate(['docker', 'pull', reference])
      images[name] = (
        await runPrivate(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}'])
      ).trim()
    }
  await writeFile(
    join(directory, 'scanned-image-identities.json'),
    JSON.stringify({
      sourceHash: manifest.APPLICATION_SOURCE_HASH,
      images,
      gatewayScope: 'container image; production host Nginx requires separate validation',
    }) + '\n',
    { mode: 0o600, flag: 'wx' },
  )
  try {
    for (const [name, id] of Object.entries(images)) {
      if (!id) throw new Error('complete runtime image set required')
      const path = join(stage, `${name}.tar`)
      await runPrivate(['docker', 'save', '--output', path, id])
      try {
        const scanner = Bun.spawn(
          [
            'docker',
            'run',
            '--rm',
            '--user',
            `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
            '--read-only',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--tmpfs',
            '/tmp:size=4294967296,mode=1777,nosuid,nodev',
            '--mount',
            `type=bind,src=${path},dst=/input/image.tar,readonly`,
            '--mount',
            `type=bind,src=${directory},dst=/result`,
            TRIVY_IMAGE,
            '--cache-dir',
            '/tmp/trivy-cache',
            'image',
            '--input',
            '/input/image.tar',
            '--scanners',
            'vuln',
            '--severity',
            'HIGH,CRITICAL',
            '--exit-code',
            '1',
            '--format',
            'json',
            '--output',
            `/result/trivy-${name}.json`,
          ],
          { env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe' },
        )
        const [stdout, stderr, code] = await Promise.all([
          new Response(scanner.stdout).text(),
          new Response(scanner.stderr).text(),
          scanner.exited,
        ])
        await writeFile(join(directory, `trivy-${name}.log`), `${stdout}\n${stderr}`, {
          mode: 0o600,
        })
        if (code !== 0) {
          failed = true
          console.error(
            JSON.stringify({
              image: name,
              status: 'scan_failed',
              exitCode: code,
              report: `trivy-${name}.json`,
            }),
          )
        }
      } catch {
        failed = true
        console.error(
          JSON.stringify({ image: name, status: 'scan_error', report: `trivy-${name}.log` }),
        )
      }
      await rm(path, { force: true })
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  if (failed) throw new Error('runtime vulnerability gate failed')
  console.log(
    JSON.stringify({
      status: 'runtime_vulnerability_gate_passed',
      sourceHash: manifest.APPLICATION_SOURCE_HASH,
    }),
  )
}
if (import.meta.main)
  main().catch(() => {
    console.error(
      'runtime vulnerability scan failed or found HIGH/CRITICAL issues; inspect the saved report',
    )
    process.exitCode = 1
  })
