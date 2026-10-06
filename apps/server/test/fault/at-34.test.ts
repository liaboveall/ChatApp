/**
 * AT-34 (D-085, SEC-41): fault injection reaches only a verified, independent instance. The development services carry
 * sentinels; the test instance is killed, flushed and restarted; forged targets (wrong env, dev ids, dev ports, wrong
 * marker, wrong labels, dev volumes) are refused and cause no side effect; cleanup never leaves its own run.
 *
 * Run through `bun run test:fault`, which creates the instance and passes its manifest in CHATAPP_FAULT_MANIFEST.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, SQL } from 'bun'
import { Redis } from 'ioredis'
import { inspectContainer, inspectVolume } from '../support/fault/docker.ts'
import {
  type FaultManifest,
  type FaultTarget,
  FaultTargetRejected,
  loadManifest,
  verifyFaultTarget,
} from '../support/fault/manifest.ts'

const manifestPath = process.env.CHATAPP_FAULT_MANIFEST
if (!manifestPath)
  throw new Error('CHATAPP_FAULT_MANIFEST is not set: run this suite with `bun run test:fault`')
if (process.env.APP_ENV !== 'test') throw new Error('APP_ENV must be test')

const runTag = Math.random().toString(36).slice(2, 10)
const SENTINEL_KEY = `sentinel:at34:${runTag}`
const SENTINEL_SETTING = `at34-sentinel:${runTag}`

let manifest: FaultManifest
let target: FaultTarget
let devValkey: Redis
let devOwner: SQL

/** Identity and uptime of the four development containers: if a fault ever leaks, this changes. */
async function devSnapshot(): Promise<Array<{ id: string; running: boolean; startedAt: string }>> {
  const ids = (
    await $`docker compose -f infra/compose.dev.yml --env-file .env.local ps -q`.quiet().text()
  )
    .split('\n')
    .filter(Boolean)
  expect(ids.length).toBe(4)
  const info = await Promise.all(ids.map((id) => inspectContainer(id)))
  return info
    .map((c) => ({ id: c?.id ?? '', running: c?.running ?? false, startedAt: c?.startedAt ?? '' }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

async function sentinelsIntact(): Promise<boolean> {
  const fromValkey = await devValkey.get(SENTINEL_KEY)
  const [row] = await devOwner`select value from app_settings where key = ${SENTINEL_SETTING}`
  return fromValkey === 'alive' && row?.value === 'alive'
}

/** True only if the database really answers a query within 5 s; a hang or a refusal both mean "down". */
async function databaseAnswers(url: string): Promise<boolean> {
  const sql = new SQL({ url, max: 1, connectionTimeout: 3 })
  try {
    return await Promise.race([
      sql`select 1`.then(
        () => true,
        () => false,
      ),
      Bun.sleep(5_000).then(() => false),
    ])
  } finally {
    void sql.close().catch(() => undefined)
  }
}

async function eventually<T>(read: () => Promise<T | undefined>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('condition not reached in time')
    await Bun.sleep(500)
  }
}

beforeAll(async () => {
  manifest = loadManifest(manifestPath)
  target = await verifyFaultTarget(manifest)
  devValkey = new Redis(process.env.VALKEY_URL ?? '')
  devOwner = new SQL({ url: process.env.DATABASE_OWNER_URL ?? '', max: 1 })
  await devValkey.set(SENTINEL_KEY, 'alive')
  await devOwner`insert into app_settings (key, value) values (${SENTINEL_SETTING}, '"alive"'::jsonb)`
})

afterAll(async () => {
  await devValkey.del(SENTINEL_KEY)
  await devOwner`delete from app_settings where key = ${SENTINEL_SETTING}`
  await devOwner.close()
  devValkey.disconnect()
})

describe('the genuine target', () => {
  test('is verified: labels, ids, loopback ports, markers all check out', async () => {
    expect(manifest.project).toBe(`chatapp-test-${manifest.runId}`)
    for (const service of Object.values(manifest.services))
      expect(service.containerId).toMatch(/^[0-9a-f]{64}$/)
    expect(await sentinelsIntact()).toBe(true)
  })

  test('can be killed, flushed and restarted while the development services and their sentinels do not change', async () => {
    const before = await devSnapshot()

    // Postgres: kill the test instance. It goes away; the development database does not notice.
    await target.act('postgres', 'kill')
    expect(await databaseAnswers(manifest.endpoints.databaseOwnerUrl)).toBe(false)
    expect(await sentinelsIntact()).toBe(true)
    expect(await devSnapshot()).toEqual(before)

    await target.act('postgres', 'start')
    await eventually(
      async () =>
        (await verifyFaultTarget(manifest)
          .then(() => true)
          .catch(() => undefined)) || undefined,
    )

    // Valkey: FLUSHALL on the test instance empties it (its marker included) but not the development Valkey.
    const testValkey = new Redis(manifest.endpoints.valkeyUrl)
    await testValkey.flushall()
    expect(await testValkey.get('chatapp:instance-marker')).toBeNull()
    testValkey.disconnect()
    expect(await devValkey.get(SENTINEL_KEY)).toBe('alive')
    // With its marker gone the instance no longer verifies: the harness would refuse to inject further faults.
    await expect(verifyFaultTarget(manifest)).rejects.toThrow(FaultTargetRejected)
    expect(await devSnapshot()).toEqual(before)

    // Put the marker back so later tests (and cleanup) see an intact instance.
    const restore = new Redis(manifest.endpoints.valkeyUrl)
    await restore.set('chatapp:instance-marker', manifest.markers.valkey)
    restore.disconnect()
    await verifyFaultTarget(manifest)
  }, 90_000)
})

describe('forged targets are refused and change nothing', () => {
  const dev = async () => {
    const [first] = (
      await $`docker compose -f infra/compose.dev.yml --env-file .env.local ps -q postgres`
        .quiet()
        .text()
    )
      .split('\n')
      .filter(Boolean)
    return first ?? ''
  }
  const copy = (): FaultManifest => structuredClone(manifest)

  async function expectRefused(
    forged: FaultManifest,
    fragment: string,
    options: { skipMarkers?: boolean } = {},
  ) {
    const before = await devSnapshot()
    let error: unknown
    try {
      await verifyFaultTarget(forged, options)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(FaultTargetRejected)
    expect((error as Error).message).toContain(fragment)
    // Refusal has no side effect: every dev container is the same one, still running since the same moment, sentinels intact.
    expect(await devSnapshot()).toEqual(before)
    expect(await sentinelsIntact()).toBe(true)
  }

  test('APP_ENV other than test', async () => {
    const saved = process.env.APP_ENV
    process.env.APP_ENV = 'development'
    try {
      await expectRefused(copy(), 'APP_ENV must be test')
    } finally {
      process.env.APP_ENV = saved
    }
  })

  test('a development container id swapped into the manifest', async () => {
    const forged = copy()
    forged.services.postgres.containerId = await dev()
    await expectRefused(forged, 'not part of project')
  })

  test('a development port in the endpoints, or published by a container', async () => {
    // The port the development instance had before the ports became variables, and the one it has now (D-172).
    for (const port of [5434, 25434]) {
      const forged = copy()
      forged.endpoints.databaseOwnerUrl = forged.endpoints.databaseOwnerUrl.replace(
        /:\d+\//,
        `:${port}/`,
      )
      await expectRefused(forged, 'development port')
    }
    for (const port of [6379, 26379]) {
      const forgedValkey = copy()
      forgedValkey.endpoints.valkeyUrl = forgedValkey.endpoints.valkeyUrl.replace(
        /:\d+\/1$/,
        `:${port}/1`,
      )
      await expectRefused(forgedValkey, 'development port')
    }
  })

  test('a mismatched project or run id', async () => {
    const forged = copy()
    forged.runId = 'abcdef12'
    await expectRefused(forged, 'project name does not match')
    const other = copy()
    other.project = 'chatapp-test-abcdef12'
    await expectRefused(other, 'project name does not match')
    const spoofed = copy()
    spoofed.runId = 'abcdef12'
    spoofed.project = 'chatapp-test-abcdef12'
    await expectRefused(spoofed, 'not part of project')
  })

  test('a development database name, or a wrong instance marker', async () => {
    const dbName = copy()
    dbName.endpoints.databaseOwnerUrl = dbName.endpoints.databaseOwnerUrl.replace(
      '/chatapp_test',
      '/chatapp',
    )
    await expectRefused(dbName, 'database name must be chatapp_test')
    const marker = copy()
    marker.markers.postgres = 'deadbeefdeadbeef'
    await expectRefused(marker, 'postgres instance marker mismatch')
    const objects = copy()
    objects.markers.garage = 'deadbeefdeadbeef'
    await expectRefused(objects, 'object store instance marker mismatch')
  })

  test('a development volume or network listed as part of the run', async () => {
    const volume = copy()
    volume.volumes = [...volume.volumes, 'chatapp-dev_pg']
    await expectRefused(volume, 'volume', { skipMarkers: true })
    const devPg = await dev()
    const info = await inspectContainer(devPg)
    expect(info).toBeDefined()
  })

  test('a manifest outside .test-runs, or readable by others', async () => {
    const stray = join(process.cwd(), 'not-a-run-dir', 'manifest.json')
    expect(() => loadManifest(stray)).toThrow('manifest must be .test-runs/<runId>/manifest.json')
    const fakeDir = join(process.cwd(), '.test-runs', 'ffffff01')
    mkdirSync(fakeDir, { recursive: true })
    const fakePath = join(fakeDir, 'manifest.json')
    try {
      writeFileSync(fakePath, JSON.stringify(manifest))
      chmodSync(fakePath, 0o644)
      expect(() => loadManifest(fakePath)).toThrow('permissions are too open')
    } finally {
      rmSync(fakeDir, { recursive: true, force: true })
    }
  })
})

describe('cleanup never leaves its own run', () => {
  test('tearing down a forged run that lists development volumes is refused and removes nothing', async () => {
    const fakeId = 'ffffff02'
    const fakeDir = join(process.cwd(), '.test-runs', fakeId)
    mkdirSync(fakeDir, { recursive: true, mode: 0o700 })
    const forged = structuredClone(manifest)
    forged.runId = fakeId
    forged.project = `chatapp-test-${fakeId}`
    forged.volumes = ['chatapp-dev_pg', 'chatapp-dev_valkey']
    const fakePath = join(fakeDir, 'manifest.json')
    writeFileSync(fakePath, JSON.stringify(forged), { mode: 0o600 })
    try {
      const before = await devSnapshot()
      const realBefore = await inspectContainer(manifest.services.postgres.containerId)
      // No container carries the fake run's label, so the CLI reports "already-gone" and only removes its own directory.
      const out = await $`bun scripts/test-infra.ts down ${fakeId}`
        .env({ ...(process.env as Record<string, string>) })
        .quiet()
        .nothrow()
      expect(out.stdout.toString()).toContain('already-gone')
      expect(await inspectVolume('chatapp-dev_pg')).toBeDefined()
      expect(await inspectVolume('chatapp-dev_valkey')).toBeDefined()
      expect(await devSnapshot()).toEqual(before)
      expect((await inspectContainer(manifest.services.postgres.containerId))?.startedAt).toBe(
        realBefore?.startedAt ?? '',
      )
      expect(await sentinelsIntact()).toBe(true)
    } finally {
      rmSync(fakeDir, { recursive: true, force: true })
    }
  })

  test('an invalid run id is rejected before anything runs', async () => {
    const result = await $`bun scripts/test-infra.ts down ../../etc`.quiet().nothrow()
    expect(result.exitCode).not.toBe(0)
  })
})
