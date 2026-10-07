/** Native complete upload → API → durable work → isolated decoder → Garage → authorized download chain. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MediaTestInstance, verifyMediaTestLocation } from './lib/media-test-infra.ts'

await verifyMediaTestLocation()
const gateway = process.argv.includes('--gateway')
const instance = await MediaTestInstance.start(
  gateway ? { origin: 'https://chat.localhost:8443', apiPort: 26402 } : undefined,
)
const directory = join('.test-runs', 'm3', instance.manifest.runId)
let edgeStarted = false
try {
  if (gateway) {
    // The fixed local gateway belongs to this command; never replace somebody's running gateway.
    const existing = Bun.spawn(
      ['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=chatapp-edge'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const ids = await new Response(existing.stdout).text()
    if ((await existing.exited) !== 0 || ids.trim())
      throw new Error('local edge gateway is already in use')
    edgeStarted = true
    const edge = Bun.spawn(['bun', 'scripts/edge.ts', 'up', '--m3'], {
      stdout: 'inherit',
      stderr: 'inherit',
    })
    if ((await edge.exited) !== 0) throw new Error('local edge gateway failed to start')
  }
  const samples: Record<string, string> = {}
  for (const name of ['jpeg', 'png', 'gif', 'video', 'ffv1'])
    samples[name] = Buffer.from(await instance.sample('generate', name)).toString('base64')
  const source = (await readFile('apps/server/test/media/business-flow.ts', 'utf8')).replaceAll(
    "'../../src/",
    "'/app/apps/server/src/",
  )
  const evidence = JSON.parse(
    new TextDecoder().decode(
      await instance.exec(
        'worker',
        `${source}\ntry { await runBusinessFlow(${gateway ? "'https://host.docker.internal:8443'" : ''}) } catch (error) { console.log(JSON.stringify({ error: error instanceof Error && error.message.startsWith('business-test:') ? error.message : error instanceof Error ? error.name : 'unknown' })) }`,
        Buffer.from(JSON.stringify({ samples })),
        240_000,
      ),
    ),
  ) as Record<string, unknown>
  if (evidence.error) throw new Error(String(evidence.error))
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'business-result.json'),
    JSON.stringify({ status: 'pass', architecture: process.arch, evidence }, null, 2),
  )
  console.log(`M3 business flow passed (${instance.manifest.runId}): ${JSON.stringify(evidence)}`)
} catch (error) {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'business-result.json'),
    JSON.stringify(
      { status: 'fail', error: error instanceof Error ? error.name : 'unknown' },
      null,
      2,
    ),
  )
  throw error
} finally {
  try {
    await instance.close()
  } finally {
    if (edgeStarted) {
      const edge = Bun.spawn(['bun', 'scripts/edge.ts', 'down'], {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      if ((await edge.exited) !== 0) {
        console.error('local edge gateway cleanup failed')
        process.exitCode = 1
      }
    }
  }
}
