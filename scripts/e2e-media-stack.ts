/** Browser scenario 6 uses fresh, verified infrastructure and a real isolated media decoder. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MediaTestInstance, verifyMediaTestLocation } from './lib/media-test-infra.ts'

export async function withBrowserMedia(run: () => Promise<void>): Promise<void> {
  process.chdir(fileURLToPath(new URL('..', import.meta.url)))
  await verifyMediaTestLocation()
  const instance = await MediaTestInstance.start({
    origin: 'http://localhost:4174',
    apiPort: 26401,
  })
  try {
    const directory = join('.test-runs', 'e2e-media')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const source = (await readFile('apps/server/test/media/browser-seed.ts', 'utf8')).replaceAll(
      "'../../src/",
      "'/app/apps/server/src/",
    )
    const accounts = await instance.exec(
      'worker',
      `${source}\nawait seedBrowser()`,
      new Uint8Array(),
      60_000,
    )
    await writeFile(join(directory, 'accounts.json'), accounts, { mode: 0o600 })
    for (const sample of ['jpeg', 'png', 'gif', 'video', 'ffv1'])
      await writeFile(
        join(directory, `${sample}.input`),
        await instance.sample('generate', sample),
        { mode: 0o600 },
      )
    console.log('M3 browser stack ready: verified real API, worker, Garage and isolated media')
    await run()
    if (process.exitCode) {
      // Keep bounded failure reasons before the owned test database is removed.
      const failures = await instance.exec(
        'worker',
        `import { createDatabase } from '@chatapp/db/client';
import { workItems } from '@chatapp/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import { loadConfig } from '/app/apps/server/src/config/env.ts';
const database = createDatabase(loadConfig(process.env).databaseUrl);
try {
  console.log(JSON.stringify(await database.db.select({
    id: workItems.id, entityId: workItems.entityId, status: workItems.status,
    attempts: workItems.attempts, lastErrorCode: workItems.lastErrorCode,
  }).from(workItems).where(and(eq(workItems.kind, 'media'), isNotNull(workItems.lastErrorCode)))));
} finally { await database.close(); }`,
      )
      await writeFile(join(directory, 'failed-media-jobs.json'), failures, { mode: 0o600 })
      console.log('M3 browser failure reasons saved to .test-runs/e2e-media/failed-media-jobs.json')
    }
  } finally {
    await instance.close()
  }
}
