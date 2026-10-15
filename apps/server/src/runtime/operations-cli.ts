/** Native operator entrypoint. Secrets stay in private files/environment; output contains status and hashes only. */
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  applicationRecoveryKeysSchema,
  backupInventoryReceiptSchema,
  benchmarkProfileSchema,
  loadFixtureSchema,
  permissionReviewSchema,
} from '@chatapp/contracts'
import { attachmentObjects, users } from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { runMigrations } from '@chatapp/db/migrate'
import { S3Client } from 'bun'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { createAuth } from '../auth/better-auth.ts'
import { sdkPasswords } from '../auth/passwords.ts'
import { readSecret } from '../cli/secret-prompt.ts'
import { loadConfig } from '../config/index.ts'
import { loadJournalSettings } from '../config/journal.ts'
import { loadOffsiteTarget } from '../config/offsite.ts'
import { checkAccountPassword } from '../domain/admin.ts'
import { BackupError, createConsistentBackup } from '../domain/backups.ts'
import { BENCHMARK_DATA, seedBenchmark } from '../domain/benchmark.ts'
import { checkpointDeletionJournal } from '../domain/deletion-checkpoint.ts'
import type { Deps } from '../domain/deps.ts'
import { operationsHealth } from '../domain/operations-health.ts'
import {
  confirmRecoveryPermissions,
  issueRecoveryCredential,
  recoveryPermissionInventory,
  unlockRecovery,
  verifyRecoveryObjects,
} from '../domain/recovery-permissions.ts'
import {
  assertRestoreUnlocked,
  isolateRestoredDatabase,
  replayDeletionJournal,
} from '../domain/restore.ts'
import { systemClock } from '../lib/clock.ts'
import { silentLogger } from '../lib/logger.ts'
import { createConditionalStore } from '../storage/conditional.ts'
import { createBlobStore } from '../storage/s3.ts'
import { openOperatorJournal, readJournalKeys } from './deletion-journal.ts'
import {
  GarageInitializationError,
  GaragePreparationError,
  initializeGarage,
} from './garage-initialize.ts'
import { uuidv7 } from './ids.ts'
import { createMonitoring } from './monitoring.ts'
import { notifyOperations } from './operations-alert.ts'
import {
  freshDirectory,
  hashFile,
  postgresEnvironment,
  privateJson,
  privateWrite,
  releaseSchema,
  runPrivate,
  sha256,
} from './operations-files.ts'
import { NativeRestic, verifyPayload } from './restic.ts'

const HELP = `Operator commands (production configuration required):
  journal:init                 Explicitly initialize this deployment's new namespace; never use after data loss
  storage:init                 Initialize a dedicated Garage; persist app key in a private staging file
  backup:init                  Initialize the dedicated encrypted offsite repository
  backup:run                   Consistent exported snapshot, immutable objects, keys and remote readback
  backup:verify                Restore and hash every offsite snapshot, including old extras
  backup:maintain              Verify catalog, retain 7 daily/4 weekly within 28 days, then journal checkpoint
  restore:download SNAPSHOT    Download a full snapshot identifier into a fresh private staging directory
  restore:import PAYLOAD EPOCH  Import into an empty dedicated database, isolate, replay, restore surviving objects
  restore:replay PAYLOAD EPOCH  Resume trusted deletion replay; no public service may run
  restore:permissions EPOCH FILE  Export complete grant inventory with default-deny review template
  restore:confirm FILE         Apply the separately reviewed permission file
  restore:credential EPOCH USER_ID  Issue a new password via a hidden terminal prompt
  restore:unlock EPOCH PREVIOUS_WRITER NEXT_WRITER  Recheck evidence, fence source writer, release isolation
  migrate                     Apply forward migrations with a separate owner account
  monitor                     Check offsite backup age, deletion backlog, journal integrity and storage
  benchmark:seed PROFILE RUN_ID  Explicit opt-in synthetic load data; never removes existing data
  help
Fresh restore configuration must use a new RESTORE_EPOCH and target storage. No command connects by SSH or publishes a service.`
const argument = (at: number) =>
  process.argv[at] ??
  (() => {
    throw new Error('operator argument missing')
  })()

async function main() {
  const command = process.argv[2] ?? 'help'
  if (command === 'help') {
    console.log(HELP)
    return
  }
  if (command === 'storage:init') {
    if (process.env.APP_ENV !== 'production') throw new Error('explicit production mode required')
    console.log(JSON.stringify(await initializeGarage(process.env)))
    return
  }
  if (process.env.APP_ENV !== 'production')
    throw new Error('operator entrypoint requires explicit production mode')
  const config = loadConfig(process.env)
  if (
    !config.databaseOwnerUrl ||
    new URL(config.databaseOwnerUrl).username === new URL(config.databaseUrl).username
  )
    throw new Error('separate privileged operator connection required')
  const settings = loadJournalSettings(process.env)
  if (!settings) throw new Error('independent journal required')
  const journal = await openOperatorJournal(settings)
  const sourceCommands = [
    'journal:init',
    'backup:init',
    'backup:run',
    'backup:verify',
    'backup:maintain',
    'migrate',
    'monitor',
    'benchmark:seed',
  ]
  if (!sourceCommands.includes(command) && !command.startsWith('restore:'))
    throw new Error('unknown operator command')
  const database = createDatabase(config.databaseOwnerUrl, {
    max: 6,
    applicationName: 'chatapp-operations',
    statementTimeoutMs: 120_000,
    lockTimeoutMs: 30_000,
  })
  const deps: Deps = {
    db: database.db,
    clock: systemClock,
    newId: uuidv7,
    passwords: sdkPasswords,
    log: silentLogger,
    config: {
      origin: config.origin,
      timezone: config.timezone,
      auth: config.auth,
      product: config.product,
    },
    blobs: createBlobStore(config.s3),
  }
  const repository = async () =>
    await NativeRestic.create({
      target: loadOffsiteTarget(process.env, 'BACKUP', 'production'),
      prefix: process.env.BACKUP_REPOSITORY_PREFIX ?? '',
      passwordFile: process.env.RESTIC_PASSWORD_FILE ?? '',
      stage: process.env.BACKUP_STAGE_DIR ?? '/var/lib/chatapp/backup',
      caFile: process.env.BACKUP_CA_FILE || undefined,
    })
  try {
    if (command === 'journal:init') {
      if (process.env.RESTORE_MODE === 'isolated' || process.env.RESTORE_PREVIOUS_WRITER_EPOCH)
        throw new Error('recovery must never initialize a new deletion history')
      // A lost head in an already used namespace must not be recreated. Both local tables must still be empty.
      const rows = await deps.db.execute<{ count: number }>(sql`select
        (select count(*) from deletion_operations) + (select count(*) from deletion_journal_state where applied_seq > 0)
        + (select count(*) from backup_runs) + (select count(*) from users where not is_bot) as count`)
      if (Number(rows[0]?.count) !== 0)
        throw new Error('journal initialization requires a new unused deployment')
      const existing = await createConditionalStore(settings.target).list(settings.prefix)
      if (existing.keys.length || existing.cursor)
        throw new Error('journal namespace already contains data; never reinitialize a lost head')
      await journal.initialize()
      console.log(JSON.stringify({ status: 'journal_initialized' }))
      return
    }
    if (command === 'migrate') {
      const url = new URL(config.databaseUrl)
      await runMigrations({
        ownerUrl: config.databaseOwnerUrl,
        appRole: {
          role: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        },
      })
      console.log(JSON.stringify({ status: 'migrated' }))
      return
    }
    if (sourceCommands.includes(command)) await assertRestoreUnlocked(deps.db)
    if (command === 'benchmark:seed') {
      if (process.env.BENCHMARK_ENABLED !== 'true')
        throw new Error('explicit controlled-data benchmark opt-in required')
      const profile = benchmarkProfileSchema.parse(argument(3)),
        runId = z.uuid().parse(argument(4))
      const release = releaseSchema.parse(JSON.parse(await readFile('/app/release.json', 'utf8')))
      const stage = await freshDirectory(
        process.env.BACKUP_STAGE_DIR ?? '/var/lib/chatapp/backup',
        `benchmark-${runId}`,
      )
      const { randomBytes } = await import('node:crypto')
      const password = randomBytes(32).toString('base64url')
      const capacity = await deps.blobs?.capacity()
      if (
        !capacity ||
        capacity.dataFreeBytes <
          BENCHMARK_DATA[profile].objects * BENCHMARK_DATA[profile].objectSize + 2 * 1024 ** 3
      )
        throw new Error('benchmark data requires measured free storage and reserve')
      const seeded = await seedBenchmark(deps, runId, profile, {
        passwordHash: await sdkPasswords.hash(password),
        putObject: async (key, size) => {
          const bytes = randomBytes(size),
            expected = sha256(bytes)
          const stored = await deps.blobs?.put(key, new Blob([bytes]).stream())
          if (stored !== size || (await createHashStream(deps.blobs?.read(key))) !== expected)
            throw new Error('benchmark storage readback mismatch')
          return { size, sha256: expected }
        },
        progress: (phase, completed, total) =>
          console.log(JSON.stringify({ event: 'benchmark.progress', phase, completed, total })),
      })
      const auth = createAuth(deps, { baseOrigin: config.origin, secret: config.auth.secret })
      const authenticated = []
      for (const user of seeded.users) {
        const result = await auth.api.signInEmail({
          body: { email: user.email, password },
          headers: new Headers({ origin: config.origin }),
          returnHeaders: true,
        })
        const cookie = result.headers
          .getSetCookie()
          .map((line) => line.split(';')[0])
          .join('; ')
        if (!cookie) throw new Error('benchmark session issuance failed')
        authenticated.push({
          userId: user.id,
          cookie,
          conversationId: seeded.messagingRoomId,
          targets: seeded.messagingTargets[user.id],
        })
      }
      await privateWrite(
        join(stage, 'fixture.json'),
        loadFixtureSchema.parse({
          format: 1,
          runId,
          origin: config.origin,
          sourceHash: release.applicationSourceHash,
          profile,
          dataset: seeded.dataset,
          users: authenticated,
          hotConversationId: seeded.messagingRoomId,
        }),
      )
      console.log(
        JSON.stringify({
          status: 'benchmark_prepared',
          dataset: seeded.dataset,
          fixture: join(stage, 'fixture.json'),
        }),
      )
      return
    }
    if (command === 'monitor') {
      const result = await operationsHealth(deps, journal)
      let alertDelivery: string
      try {
        alertDelivery = await notifyOperations(
          result,
          createMonitoring(process.env),
          join(
            process.env.BACKUP_STAGE_DIR ?? '/var/lib/chatapp/backup',
            'operations-alert-state.json',
          ),
        )
      } catch {
        alertDelivery = 'failed'
        process.exitCode = 1
      }
      console.log(JSON.stringify({ ...result, alertDelivery }))
      if (result.problems.length) process.exitCode = 1
      return
    }
    if (command === 'backup:init') {
      await (await repository()).init()
      console.log(JSON.stringify({ status: 'repository_initialized' }))
      return
    }
    if (command === 'backup:verify') {
      const inventory = await (await repository()).readVerifiedInventory()
      console.log(
        JSON.stringify(
          backupInventoryReceiptSchema.parse({
            status: 'verified',
            snapshots: inventory.length,
            inventory: inventory.map((item) => ({
              snapshotId: item.snapshotId,
              runId: item.manifest.runId,
              snapshotAt: item.manifest.snapshotAt,
              sourceHash: item.manifest.applicationSourceHash ?? null,
              objectCount: item.manifest.objects.length,
            })),
          }),
        ),
      )
      return
    }
    if (command === 'backup:maintain') {
      const repo = await repository()
      await deps.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('chatapp.backup.catalog'))`)
        await tx.execute(sql`set local idle_in_transaction_session_timeout = 0`)
        const inventory = await repo.readVerifiedInventory()
        for (const item of inventory) await journal.readSince(item.manifest.journal)
        const result = await repo.retain(inventory, deps.clock.now())
        console.log(JSON.stringify({ status: 'backup_retained', ...result }))
      })
      // checkpoint obtains its own catalog lock and re-verifies all remaining snapshots before chain truncation.
      const checkpoint = await checkpointDeletionJournal(deps, journal, () =>
        repo.readVerifiedInventory(),
      )
      console.log(JSON.stringify({ status: 'journal_checkpointed', floor: checkpoint.floor.seq }))
      return
    }
    if (command === 'backup:run') {
      if ((await journal.head()).head.writerEpoch !== settings.writerEpoch)
        throw new Error('source journal writer differs from configuration')
      const release = releaseSchema.parse(JSON.parse(await readFile('/app/release.json', 'utf8')))
      const { raw: keyring } = await readJournalKeys(settings.keyringFile)
      const repo = await repository(),
        directory = await freshDirectory(repo.stage)
      const payload = join(directory, 'payload')
      await mkdir(payload, { mode: 0o700 })
      await mkdir(join(payload, 'objects'), { mode: 0o700 })
      await mkdir(join(payload, 'recovery'), { mode: 0o700 })
      try {
        const applicationKeys = {
          betterAuthSecret: config.auth.secret,
          tokenEncryptionKey: Buffer.from(config.auth.tokenEncryptionKey).toString('base64url'),
          aiKeyEncryptionKey: config.aiKeyEncryptionKey
            ? Buffer.from(config.aiKeyEncryptionKey).toString('base64url')
            : null,
          vapid: config.push ?? null,
          restoreEpoch: config.auth.restoreEpoch,
          ...release,
        }
        await privateWrite(join(payload, 'recovery/application-keys.json'), applicationKeys)
        await privateWrite(join(payload, 'recovery/journal-keyring.json'), keyring)
        const recoveryFiles = await Promise.all(
          ['application-keys.json', 'journal-keyring.json'].map(async (name) => ({
            name,
            sha256: (await hashFile(join(payload, 'recovery', name))).sha256,
          })),
        )
        const manifest = await createConsistentBackup(deps, {
          ...release,
          keyVersions: Object.keys(keyring.keys).map(Number),
          recoveryFiles,
          exportDatabase: async (snapshot) => {
            const path = join(payload, 'database.dump')
            await writeFile(path, '', { mode: 0o600, flag: 'wx' })
            await runPrivate(
              [
                'pg_dump',
                '--format=custom',
                '--no-owner',
                '--no-privileges',
                `--snapshot=${snapshot}`,
                `--file=${path}`,
              ],
              { env: postgresEnvironment(config.databaseOwnerUrl ?? '') },
            )
            await chmod(path, 0o600)
            return await hashFile(path)
          },
          copyObject: async (object) => {
            const path = join(payload, 'objects', sha256(object.key))
            await writeFile(path, '', { mode: 0o600, flag: 'wx' })
            await Bun.write(
              path,
              deps.blobs?.read(object.key) ??
                (() => {
                  throw new Error('object port unavailable')
                })(),
            )
            const actual = await hashFile(path)
            if (actual.size !== object.size || actual.sha256 !== object.sha256)
              throw new Error('immutable object changed')
          },
          uploadAndVerify: async (manifest) => {
            await privateWrite(join(payload, 'manifest.json'), manifest)
            const id = await repo.backup(directory, `chatapp:${manifest.runId}`)
            console.log(JSON.stringify({ event: 'backup.uploaded', snapshotId: id }))
            const restoredRoot = await freshDirectory(repo.stage)
            try {
              const restored = await repo.download(id, restoredRoot)
              if (sha256(JSON.stringify(restored.manifest)) !== sha256(JSON.stringify(manifest)))
                throw new Error('remote manifest differs')
              await journal.readSince(manifest.journal)
            } finally {
              await rm(restoredRoot, { recursive: true, force: true })
            }
            return {
              manifestKey: id,
              manifestHash: (await hashFile(join(payload, 'manifest.json'))).sha256,
            }
          },
        })
        console.log(
          JSON.stringify({
            status: 'backup_verified',
            runId: manifest.runId,
            objectCount: manifest.objects.length,
            sourceHash: manifest.applicationSourceHash,
            snapshotAt: manifest.snapshotAt,
          }),
        )
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
      return
    }
    if (command === 'restore:download') {
      const repo = await repository()
      const result = await repo.download(
        argument(3),
        process.env.RESTORE_STAGE_DIR ?? '/var/lib/chatapp/restore',
      )
      // This path contains no credential values. The payload stays private and is never served by the API.
      console.log(
        JSON.stringify({
          status: 'download_verified',
          payload: result.directory,
          sourceHash: result.manifest.applicationSourceHash,
        }),
      )
      return
    }
    if (command === 'restore:import' || command === 'restore:replay') {
      const payload = resolve(argument(3)),
        epoch = z.uuid().parse(argument(4))
      const root = resolve(process.env.RESTORE_STAGE_DIR ?? '/var/lib/chatapp/restore')
      if (!payload.startsWith(`${root}/`) || !(await lstat(payload)).isDirectory())
        throw new Error('private restore staging required')
      const manifest = await verifyPayload(payload)
      const release = releaseSchema.parse(JSON.parse(await readFile('/app/release.json', 'utf8')))
      if (
        manifest.applicationSha !== release.applicationSha ||
        manifest.applicationSourceHash !== release.applicationSourceHash
      )
        throw new Error('matching immutable recovery image required')
      const original = await privateJson(
        join(payload, 'recovery/application-keys.json'),
        applicationRecoveryKeysSchema,
      )
      if (
        original.betterAuthSecret !== config.auth.secret ||
        original.tokenEncryptionKey !==
          Buffer.from(config.auth.tokenEncryptionKey).toString('base64url') ||
        original.aiKeyEncryptionKey !==
          (config.aiKeyEncryptionKey
            ? Buffer.from(config.aiKeyEncryptionKey).toString('base64url')
            : null) ||
        JSON.stringify(original.vapid) !== JSON.stringify(config.push ?? null) ||
        original.applicationSha !== release.applicationSha ||
        original.applicationSourceHash !== release.applicationSourceHash
      )
        throw new Error('matching source application recovery keys required')
      const previousWriter = z.uuid().parse(process.env.RESTORE_PREVIOUS_WRITER_EPOCH)
      if (
        epoch !== config.auth.restoreEpoch ||
        epoch === original.restoreEpoch ||
        settings.writerEpoch === previousWriter ||
        (await journal.head()).head.writerEpoch !== previousWriter
      )
        throw new Error('fresh restore and writer generations required')
      if (command === 'restore:import') {
        const tables = await deps.db.execute<{ count: number }>(
          sql`select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','drizzle') and c.relkind in ('r','p')`,
        )
        if (tables[0]?.count !== 0)
          throw new Error('restore target database must be empty; existing data is preserved')
        const client = new S3Client({
          endpoint: config.s3.endpoint,
          bucket: config.s3.bucket,
          region: config.s3.region,
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        })
        if ((await client.list({ maxKeys: 1 })).contents?.length)
          throw new Error('restore target bucket must be empty')
        await deps.db.execute(
          sql`revoke connect on database ${sql.identifier(postgresEnvironment(config.databaseOwnerUrl).PGDATABASE ?? '')} from public`,
        )
        await runPrivate(
          [
            'pg_restore',
            '--single-transaction',
            '--exit-on-error',
            '--no-owner',
            '--no-privileges',
            '--dbname',
            postgresEnvironment(config.databaseOwnerUrl).PGDATABASE ?? '',
            join(payload, 'database.dump'),
          ],
          { env: postgresEnvironment(config.databaseOwnerUrl) },
        )
        await isolateRestoredDatabase(deps, epoch)
      }
      const [schema] = await deps.db.execute<{ hash: string }>(
        sql`select hash from drizzle.__drizzle_migrations order by id desc limit 1`,
      )
      if (schema?.hash !== manifest.schemaHash)
        throw new Error('restored schema does not match snapshot manifest')
      const result = await replayDeletionJournal(deps, journal, manifest, epoch)
      const live = await deps.db
        .select()
        .from(attachmentObjects)
        .where(eq(attachmentObjects.status, 'live'))
      for (const item of live) {
        const object = manifest.objects.find((object) => object.key === item.storageKey)
        if (!object || object.size !== item.sizeBytes || object.sha256 !== item.sha256)
          throw new Error('restored live object lacks manifest evidence')
        const bytes = await deps.blobs?.put(
          object.key,
          Bun.file(join(payload, 'objects', sha256(object.key))).stream(),
        )
        if (bytes !== object.size) throw new Error('restored object size differs')
        const copied = createHashStream(deps.blobs?.read(object.key))
        if ((await copied) !== object.sha256) throw new Error('restored storage readback differs')
      }
      await verifyRecoveryObjects(deps, epoch, manifest, async (key) => {
        const stat = await deps.blobs?.stat(key)
        if (!stat) throw new Error('restored object missing')
        return { size: stat.size, sha256: await createHashStream(deps.blobs?.read(key)) }
      })
      console.log(
        JSON.stringify({ status: 'isolated_replayed', ...result, restoredObjects: live.length }),
      )
      return
    }
    if (command === 'restore:permissions') {
      const result = await recoveryPermissionInventory(deps, z.uuid().parse(argument(3)))
      await privateWrite(argument(4), result)
      console.log(
        JSON.stringify({
          status: 'permission_inventory_exported',
          inventoryHash: result.inventoryHash,
        }),
      )
      return
    }
    if (command === 'restore:confirm') {
      const review = await privateJson(argument(3), permissionReviewSchema, 32 * 1024 * 1024)
      console.log(
        JSON.stringify({
          status: 'permissions_reconfirmed',
          ...(await confirmRecoveryPermissions(deps, review)),
        }),
      )
      return
    }
    if (command === 'restore:credential') {
      const epoch = z.uuid().parse(argument(3)),
        id = z.uuid().parse(argument(4))
      const [user] = await deps.db.select().from(users).where(eq(users.id, id))
      if (!user?.username) throw new Error('unknown recovery identity')
      const password = await readSecret('New recovery password: ')
      if (
        checkAccountPassword(
          config.product,
          { email: user.email, username: user.username, displayName: user.name },
          password,
        )
      )
        throw new Error('recovery password does not satisfy the account policy')
      if (process.stdin.isTTY && (await readSecret('Repeat recovery password: ')) !== password)
        throw new Error('passwords differ')
      await issueRecoveryCredential(deps, epoch, id, password)
      console.log(JSON.stringify({ status: 'fresh_credential_issued' }))
      return
    }
    if (command === 'restore:unlock') {
      const epoch = z.uuid().parse(argument(3)),
        previous = z.uuid().parse(argument(4)),
        next = z.uuid().parse(argument(5))
      if (next !== settings.writerEpoch)
        throw new Error('new writer must match runtime configuration')
      await unlockRecovery(deps, journal, epoch, previous, next)
      // Grants are reinstalled only after the durable fence is released; no schema changes are made here.
      const { applyAppGrants, ensureAppRole } = await import('@chatapp/db/roles')
      const url = new URL(config.databaseUrl)
      await ensureAppRole(deps.db, {
        role: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      })
      await applyAppGrants(deps.db, { role: decodeURIComponent(url.username) })
      console.log(JSON.stringify({ status: 'recovery_unlocked' }))
      return
    }
    throw new Error('unknown operator command')
  } finally {
    await database.close()
  }
}
async function createHashStream(stream: ReadableStream<Uint8Array> | undefined) {
  if (!stream) throw new Error('object readback unavailable')
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}
if (import.meta.main)
  main().catch((error: unknown) => {
    if (error instanceof GaragePreparationError)
      console.error(
        JSON.stringify({
          status: 'failed',
          stage: 'garage-preparation',
          phase: error.stage,
          reason: error.reason,
        }),
      )
    if (error instanceof GarageInitializationError)
      console.error(
        JSON.stringify({
          status: 'failed',
          stage: 'garage-initialization',
          operation: error.operation,
          reason: error.reason,
          statusCode: error.statusCode,
        }),
      )
    if (
      error instanceof BackupError &&
      [
        'snapshot-metadata',
        'database-export',
        'manifest-validation',
        'lease-and-object-copy',
        'restic-upload-and-readback',
        'backup-catalog-busy',
      ].includes(error.stage)
    )
      console.error(JSON.stringify({ status: 'failed', stage: error.stage }))
    console.error(
      'operator command failed; configuration, snapshot and isolation remain unapproved',
    )
    process.exitCode = 1
  })
