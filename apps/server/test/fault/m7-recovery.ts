/** Real R2/restic and independent source/restore instances. Small fixture; not full V-19 host/device/RTO acceptance. */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  backupManifestSchema,
  deletionOperationSchema,
  memoryResponseSchema,
  messageEnvelopeSchema,
} from '@chatapp/contracts'
import {
  agentMemories,
  agentRunStates,
  agentRuns,
  attachmentObjects,
  attachments,
  backupRuns,
  deletionOperations,
  messages,
  siteStorage,
  uploadReservations,
  users,
} from '@chatapp/db'
import { createDatabase } from '@chatapp/db/client'
import { applyAppGrants } from '@chatapp/db/roles'
import { eq, sql } from 'drizzle-orm'
import { getEnv, readEnvFile } from '../../../../scripts/lib/env-file.ts' // guard-allow: isolated harness reuses the repository's secret-safe environment reader
import { cleanupOffsiteRun } from '../../../../scripts/lib/offsite-cleanup.ts' // guard-allow: test cleanup is restricted to this run's UUID-owned remote prefixes
import { hashFile, ResticRepository, sha256 } from '../../../../scripts/lib/restic.ts' // guard-allow: test-only restic adapter; never reachable from production
import { recoverySourceFingerprint } from '../../../../scripts/lib/source-fingerprint.ts' // guard-allow: binds the isolated experiment to non-secret current source files
import { startInstance, stopInstance } from '../../../../scripts/lib/test-infra.ts' // guard-allow: fault actions reuse the repository's verified per-run ownership lifecycle
import { loadAiConfig } from '../../src/config/ai.ts'
import { loadOffsiteTarget } from '../../src/config/offsite.ts'
import { createAgentRun } from '../../src/domain/agent-runs.ts'
import {
  BackupError,
  createConsistentBackup,
  withPhysicalDeletion,
} from '../../src/domain/backups.ts'
import { checkpointDeletionJournal } from '../../src/domain/deletion-checkpoint.ts'
import { EncryptedDeletionJournal } from '../../src/domain/deletion-journal.ts'
import {
  assertRestoreUnlocked,
  isolateRestoredDatabase,
  replayDeletionJournal,
} from '../../src/domain/restore.ts'
import { systemClock } from '../../src/lib/clock.ts'
import { createConditionalStore } from '../../src/storage/conditional.ts'
import { createBlobStore } from '../../src/storage/s3.ts'
import { createActiveUser, makeDeps, makePrincipal } from '../support/deps.ts'
import type { FaultManifest } from '../support/fault/manifest.ts'
import { createTestApp, type TestApp } from '../support/http.ts'

const runId = randomUUID(),
  directory = resolve(`.test-runs/m7/recovery-tests/${runId}`)
const payload = join(directory, 'payload'),
  journalPrefix = `m7-recovery/${runId}/`,
  resticPrefix = `m7-restic/${runId}`
const applicationSourceHash = await recoverySourceFingerprint()
await mkdir(join(payload, 'objects'), { recursive: true, mode: 0o700 })
await mkdir(join(payload, 'recovery'), { recursive: true, mode: 0o700 })
const envFile = await readEnvFile('.env.local'),
  env: Record<string, string | undefined> = {}
for (const line of envFile.lines) {
  const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
  if (key) env[key] = getEnv(envFile, key)
}
const confirmation = JSON.parse(await readFile('.test-runs/m7/recovery/current.json', 'utf8')) as {
  outsideHostConfirmed?: boolean
}
if (!confirmation.outsideHostConfirmed)
  throw new Error('off-host recovery materials confirmation required')
if (!env.DELETION_JOURNAL_KEYRING_FILE || !env.BACKUP_PASSWORD_FILE)
  throw new Error('recovery materials missing')
// Test-only harness opts into these explicit dedicated targets; ordinary test processes never create real writers.
Object.assign(process.env, env, { APP_ENV: 'test', RESTORE_MODE: 'isolated' })
const journalTarget = loadOffsiteTarget(env, 'DELETION_JOURNAL', 'test'),
  backupTarget = loadOffsiteTarget(env, 'BACKUP', 'test')
const journalStore = createConditionalStore(journalTarget),
  backupStore = createConditionalStore(backupTarget)
const keyringBytes = await readFile(env.DELETION_JOURNAL_KEYRING_FILE)
const keyring = JSON.parse(keyringBytes.toString('utf8')) as {
  currentKeyVersion: number
  keys: Record<string, string>
}
const journalOptions = {
  store: journalStore,
  prefix: journalPrefix,
  writerEpoch: randomUUID(),
  currentKeyVersion: keyring.currentKeyVersion,
  keys: new Map(
    Object.entries(keyring.keys).map(([version, key]) => [
      Number(version),
      new Uint8Array(Buffer.from(key, 'base64url')),
    ]),
  ),
}
const journal = new EncryptedDeletionJournal(journalOptions)
const repository = await ResticRepository.create({
  target: backupTarget,
  prefix: resticPrefix,
  directory,
  passwordFile: env.BACKUP_PASSWORD_FILE,
  payload,
})
const results: { name: string; pass: boolean }[] = []
let source: FaultManifest | undefined,
  restored: FaultManifest | undefined,
  sourceClosed = false
let sourceDb: ReturnType<typeof createDatabase> | undefined,
  sourceOwner: ReturnType<typeof createDatabase> | undefined,
  app: TestApp | undefined
let restoreDb: ReturnType<typeof createDatabase> | undefined
let snapshotId: string | undefined,
  sourceUnavailableAt: number | undefined,
  replaySeconds: number | undefined
let objectCount = 0,
  objectBytes = 0,
  cleanup = true,
  stage = 'source-start'
const check = (condition: unknown, name: string) => {
  results.push({ name, pass: Boolean(condition) })
  if (!condition) throw new Error(name)
  console.log(`pass ${name}`)
}
try {
  console.log('starting owned independent source instance')
  source = (await startInstance()).manifest
  stage = 'source-fixtures'
  Object.assign(process.env, {
    DATABASE_URL_TEST: source.endpoints.databaseUrl,
    DATABASE_OWNER_URL_TEST: source.endpoints.databaseOwnerUrl,
    VALKEY_URL_TEST: source.endpoints.valkeyUrl,
    S3_ENDPOINT: source.endpoints.s3Endpoint,
    S3_BUCKET_TEST: source.endpoints.s3Bucket,
    S3_ACCESS_KEY_ID_TEST: source.endpoints.s3AccessKeyId,
    S3_SECRET_ACCESS_KEY_TEST: source.endpoints.s3SecretAccessKey,
  })
  sourceDb = createDatabase(source.endpoints.databaseUrl, { max: 6 })
  sourceOwner = createDatabase(source.endpoints.databaseOwnerUrl)
  const sourceAppDb = sourceDb.db
  const sourceBlobs = createBlobStore(
    {
      endpoint: source.endpoints.s3Endpoint,
      region: 'garage',
      bucket: source.endpoints.s3Bucket,
      accessKeyId: source.endpoints.s3AccessKeyId,
      secretAccessKey: source.endpoints.s3SecretAccessKey,
      metricsEndpoint: '',
      metricsToken: undefined,
    },
    { physicalDeletion: (remove) => withPhysicalDeletion({ db: sourceAppDb }, remove) },
  )
  await journal.initialize()
  app = await createTestApp(
    { app: sourceDb, owner: sourceOwner, close: async () => {} },
    {
      valkeyUrl: source.endpoints.valkeyUrl,
      deps: { deletionJournal: journal, blobs: sourceBlobs },
    },
  )
  const deps = app.services.deps
  app.clock.set(new Date())
  const alice = await createActiveUser(deps, { username: 'alice' }),
    bob = await createActiveUser(deps, { username: 'bob' })
  const jar = app.newJar()
  check(
    (
      await app.request('/api/auth/sign-in/email', {
        jar,
        json: { email: alice.email, password: alice.password },
      })
    ).status === 200,
    'source-real-authentication',
  )
  const created = await app.request('/api/conversations', {
    jar,
    json: { kind: 'group', name: 'recovery fixture', memberIds: [bob.id] },
    headers: { 'idempotency-key': randomUUID() },
  })
  if (created.status !== 201) throw new Error('conversation fixture failed')
  const conversation = (await created.json()) as { id: string }
  const sent = await app.request(`/api/conversations/${conversation.id}/messages`, {
    jar,
    json: { clientId: randomUUID(), body: 'confirmed deleted message must never resurrect' },
  })
  if (sent.status !== 201) throw new Error('message fixture failed')
  const message = messageEnvelopeSchema.parse(await sent.json()).message
  const added = await app.request('/api/me/memories', {
    jar,
    json: { content: 'accepted memory deletion must never resurrect', allowSite: false },
  })
  const memory = memoryResponseSchema.parse(await added.json()).memory
  const warmup = await app.request('/api/me/memories', {
    jar,
    json: { content: 'historical checkpoint age fixture', allowSite: false },
  })
  const warmupId = memoryResponseSchema.parse(await warmup.json()).memory.id
  // Only this disposable run simulates an old acceptance timestamp; it does not claim 35 days of real cloud residence.
  app.clock.set(new Date(Date.now() - 36 * 86_400_000))
  check(
    (await app.request(`/api/me/memories/${warmupId}`, { jar, method: 'DELETE' })).status === 200,
    'historical-delete-before-backup-age-fixture',
  )
  app.clock.set(new Date())
  const historicalHead = (await journal.head()).head
  const bobJar = app.newJar()
  check(
    (
      await app.request('/api/auth/sign-in/email', {
        jar: bobJar,
        json: { email: bob.email, password: bob.password },
      })
    ).status === 200,
    'account-fixture-real-authentication',
  )
  const published = await app.request(`/api/conversations/${conversation.id}/messages`, {
    jar: bobJar,
    json: { clientId: randomUUID(), body: 'public account history remains anonymous' },
  })
  const retainedMessage = messageEnvelopeSchema.parse(await published.json()).message
  const privateMemory = memoryResponseSchema.parse(
    await (
      await app.request('/api/me/memories', {
        jar: bobJar,
        json: { content: 'account-private memory must disappear', allowSite: false },
      })
    ).json(),
  ).memory
  const { apiKey: _, ...aiPolicy } = loadAiConfig({ APP_ENV: 'test' })
  deps.config.ai = aiPolicy
  const [bobProfile] = await deps.db.select().from(users).where(eq(users.id, bob.id))
  if (!bobProfile) throw new Error('account fixture missing')
  const privateRun = await createAgentRun(
    deps,
    await makePrincipal(deps, bob),
    {
      trigger: 'agent_chat',
      prompt: 'account-private assistant body',
      mode: 'fast',
      attachmentIds: [],
      timezone: bobProfile.timezone,
    },
    randomUUID(),
  )
  await deps.db
    .update(agentRunStates)
    .set({ messages: ['account-private model state'] })
    .where(eq(agentRunStates.runId, privateRun.id))
  const objectKey = `att/${randomUUID()}/main`,
    bytes = new TextEncoder().encode('retained immutable attachment fixture')
  await sourceBlobs.put(objectKey, new Blob([bytes]).stream())
  const [attachment] = await deps.db
    .insert(attachments)
    .values({
      uploaderId: alice.id,
      purpose: 'message',
      originalName: 'fixture.bin',
      status: 'processing',
    })
    .returning()
  if (!attachment) throw new Error('attachment fixture missing')
  const uploadId = randomUUID()
  await deps.db.insert(uploadReservations).values({
    id: uploadId,
    attachmentId: attachment.id,
    userId: alice.id,
    idempotencyKey: randomUUID(),
    requestHash: 'a'.repeat(64),
    maxBytes: bytes.length,
    status: 'settled',
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  await deps.db.insert(attachmentObjects).values({
    attachmentId: attachment.id,
    generation: 1,
    variant: 'original',
    storageKey: objectKey,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    status: 'live',
    accounted: true,
  })
  await deps.db
    .insert(siteStorage)
    .values({ id: 1, usedBytes: bytes.length })
    .onConflictDoUpdate({ target: siteStorage.id, set: { usedBytes: bytes.length } })
  await deps.db.update(users).set({ storageUsedBytes: bytes.length }).where(eq(users.id, alice.id))
  await deps.db
    .update(attachments)
    .set({
      status: 'ready',
      storageKey: objectKey,
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      chargedBytes: bytes.length,
    })
    .where(eq(attachments.id, attachment.id))
  const publicObjectKey = `att/${randomUUID()}/main`,
    publicBytes = new TextEncoder().encode('anonymous public attachment remains')
  await sourceBlobs.put(publicObjectKey, new Blob([publicBytes]).stream())
  const [publicFile] = await deps.db
    .insert(attachments)
    .values({
      uploaderId: bob.id,
      purpose: 'message',
      originalName: 'public.bin',
      status: 'processing',
      conversationId: conversation.id,
    })
    .returning()
  if (!publicFile) throw new Error('public attachment fixture missing')
  await deps.db.insert(uploadReservations).values({
    attachmentId: publicFile.id,
    userId: bob.id,
    idempotencyKey: randomUUID(),
    requestHash: 'b'.repeat(64),
    maxBytes: publicBytes.length,
    status: 'settled',
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  await deps.db.insert(attachmentObjects).values({
    attachmentId: publicFile.id,
    generation: 1,
    variant: 'original',
    storageKey: publicObjectKey,
    sizeBytes: publicBytes.length,
    sha256: sha256(publicBytes),
    status: 'live',
    accounted: true,
  })
  await deps.db
    .update(attachments)
    .set({
      status: 'ready',
      storageKey: publicObjectKey,
      sha256: sha256(publicBytes),
      sizeBytes: publicBytes.length,
      chargedBytes: publicBytes.length,
      messageId: retainedMessage.id,
    })
    .where(eq(attachments.id, publicFile.id))
  await deps.db
    .update(users)
    .set({ storageUsedBytes: publicBytes.length })
    .where(eq(users.id, bob.id))
  await deps.db
    .update(siteStorage)
    .set({ usedBytes: sql`${siteStorage.usedBytes}+${publicBytes.length}` })
    .where(eq(siteStorage.id, 1))
  await writeFile(join(payload, 'recovery/journal-keyring.json'), keyringBytes, { mode: 0o600 })
  const locator = Buffer.from(
    JSON.stringify({ journalPrefix, writerEpoch: journalOptions.writerEpoch }),
  )
  await writeFile(join(payload, 'recovery/locator.json'), locator, { mode: 0o600 })
  const recoveryFiles = [
    { name: 'journal-keyring.json', sha256: sha256(keyringBytes) },
    { name: 'locator.json', sha256: sha256(locator) },
  ]
  stage = 'restic-init'
  await repository.init()
  const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  const applicationSha = (await new Response(git.stdout).text()).trim()
  if ((await git.exited) !== 0) throw new Error('application revision unavailable')
  stage = 'consistent-backup'
  await createConsistentBackup(
    { ...deps, db: sourceOwner.db, clock: systemClock },
    {
      applicationSha,
      applicationSourceHash,
      keyVersions: [...journalOptions.keys.keys()],
      recoveryFiles,
      exportDatabase: async (snapshot) => {
        if (!source) throw new Error('source unavailable')
        const process = Bun.spawn(
          [
            'docker',
            'exec',
            source.services.postgres.containerId,
            'pg_dump',
            '-U',
            'chatapp',
            '-d',
            'chatapp_test',
            '--format=custom',
            '--no-owner',
            '--no-acl',
            `--snapshot=${snapshot}`,
          ],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const output = join(payload, 'database.dump')
        await writeFile(output, '', { mode: 0o600 })
        const [written] = await Promise.all([
          Bun.write(output, new Response(process.stdout)),
          new Response(process.stderr).text(),
        ])
        if ((await process.exited) !== 0 || written === 0) throw new Error('snapshot dump failed')
        await chmod(output, 0o600)
        return await hashFile(output)
      },
      copyObject: async (object) => {
        const path = join(payload, 'objects', sha256(object.key))
        await writeFile(path, '', { mode: 0o600 })
        await Bun.write(path, new Response(sourceBlobs.read(object.key)))
        const copied = await hashFile(path)
        if (copied.size !== object.size || copied.sha256 !== object.sha256)
          throw new Error('object copy hash mismatch')
      },
      uploadAndVerify: async (manifest) => {
        await writeFile(join(payload, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
        snapshotId = await repository.backup(`m7-${runId}`)
        await repository.verify(snapshotId, join(directory, 'verification'))
        objectCount = manifest.objects.length
        objectBytes = manifest.objects.reduce((total, item) => total + item.size, 0)
        check(
          (await deps.db.select().from(backupRuns))[0]?.status === 'uploading',
          'success-not-set-before-offsite-readback',
        )
        return {
          manifestKey: `${resticPrefix}/snapshots/${snapshotId}`,
          manifestHash: sha256(JSON.stringify(manifest)),
        }
      },
    },
  )
  check(
    (await deps.db.select().from(backupRuns))[0]?.status === 'succeeded',
    'offsite-restic-dump-and-every-object-verified',
  )
  stage = 'post-snapshot-deletions'
  const recalled = await app.request(`/api/messages/${message.id}/recall`, { jar, json: {} })
  check(
    recalled.status === 200 &&
      messageEnvelopeSchema.parse(await recalled.json()).message.body === null,
    'confirmed-message-delete-after-snapshot',
  )
  check(
    (await app.request(`/api/uploads/${uploadId}`, { jar, method: 'DELETE' })).status === 200,
    'confirmed-unbound-attachment-delete-after-snapshot',
  )
  check(
    (
      await app.request('/api/me', {
        jar: bobJar,
        method: 'DELETE',
        json: { password: bob.password },
      })
    ).status === 200,
    'confirmed-account-delete-after-snapshot',
  )
  deps.deletionJournal = {
    append: async (input) => {
      await journal.append(input)
      throw new Error('synthetic source loss after acceptance before local commit')
    },
  }
  const pending = await app.request(`/api/me/memories/${memory.id}`, { jar, method: 'DELETE' })
  check(
    pending.status === 202 &&
      deletionOperationSchema.parse(await pending.json()).status === 'pending',
    'accepted-memory-delete-lost-local-commit',
  )
  check(
    (await deps.db.select().from(deletionOperations)).some((row) => row.status === 'prepared'),
    'prepared-operation-not-falsely-marked-complete',
  )
  stage = 'verified-remote-catalog-and-checkpoint'
  const checkpoint = await checkpointDeletionJournal(
    { ...deps, db: sourceOwner.db, clock: systemClock },
    journal,
    () => repository.readVerifiedInventory(),
  )
  check(
    checkpoint.floor.seq === 1 &&
      checkpoint.floor.hash === historicalHead.hash &&
      checkpoint.deleted >= 1,
    'authenticated-checkpoint-covers-oldest-verified-restic-snapshot',
  )
  check(
    !(await journalStore.read(`${journalPrefix}records/${historicalHead.hash}`)),
    'historical-record-physically-truncated-after-checkpoint',
  )
  await app.close()
  app = undefined
  await sourceDb.close()
  sourceDb = undefined
  await sourceOwner.close()
  sourceOwner = undefined
  sourceUnavailableAt = Date.now()
  stage = 'disable-owned-source'
  await stopInstance(source.runId)
  sourceClosed = true
  await rm(payload, { recursive: true, force: true })
  await mkdir(payload, { mode: 0o700 })
  await rm(join(directory, 'verification'), { recursive: true, force: true })
  check(sourceClosed, 'source-instance-and-plaintext-backup-removed')
  console.log(
    'starting independent restore instance; fetching only remote encrypted backup and journal',
  )
  stage = 'restore-start'
  restored = (await startInstance()).manifest
  const recoveredDir = join(directory, 'restored')
  if (!snapshotId) throw new Error('snapshot locator missing')
  stage = 'restic-restore'
  await repository.restore(snapshotId, recoveredDir)
  const recovered = join(recoveredDir, 'payload'),
    manifest = backupManifestSchema.parse(
      JSON.parse(await readFile(join(recovered, 'manifest.json'), 'utf8')),
    )
  const dump = await hashFile(join(recovered, 'database.dump'))
  check(
    dump.sha256 === manifest.database.sha256 && dump.size === manifest.database.size,
    'remote-database-dump-integrity',
  )
  for (const file of manifest.recoveryFiles)
    check(
      sha256(await readFile(join(recovered, 'recovery', file.name))) === file.sha256,
      `recovery-file-integrity-${file.name}`,
    )
  stage = 'postgres-restore'
  check(
    manifest.applicationSourceHash === applicationSourceHash,
    'restored-manifest-binds-uncommitted-server-source',
  )
  const restore = Bun.spawn(
    [
      'docker',
      'exec',
      '-i',
      restored.services.postgres.containerId,
      'pg_restore',
      '-U',
      'chatapp',
      '-d',
      'chatapp_test',
      '--clean',
      '--if-exists',
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
    ],
    { stdin: Bun.file(join(recovered, 'database.dump')), stdout: 'pipe', stderr: 'pipe' },
  )
  await Promise.all([new Response(restore.stdout).text(), new Response(restore.stderr).text()])
  check((await restore.exited) === 0, 'independent-database-restored-from-r2')
  const owner = createDatabase(restored.endpoints.databaseOwnerUrl)
  try {
    await applyAppGrants(owner.db, { role: 'chatapp_app' })
  } finally {
    await owner.close()
  }
  restoreDb = createDatabase(restored.endpoints.databaseUrl)
  const restoredAppDb = restoreDb.db
  const blobs = createBlobStore(
    {
      endpoint: restored.endpoints.s3Endpoint,
      region: 'garage',
      bucket: restored.endpoints.s3Bucket,
      accessKeyId: restored.endpoints.s3AccessKeyId,
      secretAccessKey: restored.endpoints.s3SecretAccessKey,
      metricsEndpoint: '',
      metricsToken: undefined,
    },
    { physicalDeletion: (remove) => withPhysicalDeletion({ db: restoredAppDb }, remove) },
  )
  for (const object of manifest.objects) {
    const path = join(recovered, 'objects', sha256(object.key)),
      checkBytes = await hashFile(path)
    if (
      checkBytes.size !== object.size ||
      checkBytes.sha256 !== object.sha256 ||
      (await blobs.stat(object.key))
    )
      throw new Error('object restore integrity or freshness failure')
    await blobs.put(object.key, Bun.file(path).stream())
  }
  const restoredKeyring = JSON.parse(
    await readFile(join(recovered, 'recovery/journal-keyring.json'), 'utf8'),
  ) as typeof keyring
  const restoredLocator = JSON.parse(
    await readFile(join(recovered, 'recovery/locator.json'), 'utf8'),
  ) as { journalPrefix: string; writerEpoch: string }
  const recoveryJournal = new EncryptedDeletionJournal({
    store: journalStore,
    prefix: restoredLocator.journalPrefix,
    writerEpoch: restoredLocator.writerEpoch,
    currentKeyVersion: restoredKeyring.currentKeyVersion,
    keys: new Map(
      Object.entries(restoredKeyring.keys).map(([version, key]) => [
        Number(version),
        new Uint8Array(Buffer.from(key, 'base64url')),
      ]),
    ),
  })
  const restoreDeps = { ...makeDeps(restoreDb.db, { blobs }), clock: systemClock }
  const epoch = randomUUID()
  await isolateRestoredDatabase(restoreDeps, epoch)
  stage = 'journal-replay'
  const replay = await replayDeletionJournal(restoreDeps, recoveryJournal, manifest, epoch)
  check(
    replay.replayed === 4 && replay.seq === 5,
    'snapshot-suffix-complete-including-uncommitted-accepted-delete',
  )
  check(
    (await restoreDb.db.select().from(messages).where(eq(messages.id, message.id)))[0]?.body ===
      null,
    'confirmed-deleted-message-does-not-resurrect',
  )
  check(
    (await restoreDb.db.select().from(agentMemories).where(eq(agentMemories.id, memory.id)))[0]
      ?.content === null,
    'accepted-memory-delete-does-not-resurrect',
  )
  check(
    (await restoreDb.db.select().from(attachments).where(eq(attachments.id, attachment.id)))[0]
      ?.status === 'deleting',
    'unbound-attachment-delete-does-not-resurrect',
  )
  check(
    (await restoreDb.db.select().from(users).where(eq(users.id, bob.id)))[0]?.deletedAt instanceof
      Date,
    'account-deletion-replays-from-old-snapshot',
  )
  check(
    !(await restoreDb.db.select().from(agentMemories).where(eq(agentMemories.id, privateMemory.id)))
      .length,
    'account-private-memory-does-not-resurrect',
  )
  check(
    (
      await restoreDb.db
        .select()
        .from(agentRunStates)
        .where(eq(agentRunStates.runId, privateRun.id))
    )[0]?.messages.length === 0 &&
      (await restoreDb.db.select().from(agentRuns).where(eq(agentRuns.id, privateRun.id)))[0]
        ?.contentPurgedAt instanceof Date,
    'account-private-agent-content-does-not-resurrect',
  )
  check(
    (await restoreDb.db.select().from(messages).where(eq(messages.id, retainedMessage.id)))[0]
      ?.body === retainedMessage.body &&
      (await restoreDb.db.select().from(attachments).where(eq(attachments.id, publicFile.id)))[0]
        ?.status === 'ready',
    'anonymous-public-message-and-attachment-are-preserved',
  )
  let fenced = false
  try {
    await assertRestoreUnlocked(restoreDb.db)
  } catch {
    fenced = true
  }
  check(fenced, 'replayed-dataset-stays-isolated-for-permission-reconfirmation')
  replaySeconds = (Date.now() - sourceUnavailableAt) / 1000
  check(
    (await recoverySourceFingerprint()) === applicationSourceHash,
    'recovery-source-unchanged-through-experiment',
  )
} catch (error) {
  if (error instanceof BackupError) stage = error.stage
  results.push({ name: `recovery-failure-${stage}`, pass: false })
  console.error(`fail recovery-failure-${stage}; sensitive upstream output suppressed`)
} finally {
  await app?.close().catch(() => {
    cleanup = false
  })
  await sourceDb?.close().catch(() => {
    cleanup = false
  })
  await sourceOwner?.close().catch(() => {
    cleanup = false
  })
  await restoreDb?.close().catch(() => {
    cleanup = false
  })
  if (source && !sourceClosed)
    await stopInstance(source.runId).catch(() => {
      cleanup = false
    })
  if (restored)
    await stopInstance(restored.runId).catch(() => {
      cleanup = false
    })
  for (const [store, prefix] of [
    [journalStore, journalPrefix],
    [backupStore, `${resticPrefix}/`],
  ] as const) {
    try {
      await cleanupOffsiteRun(store, prefix)
    } catch {
      cleanup = false
    }
  }
  await repository.clearCredentials().catch(() => {
    cleanup = false
  })
  for (const name of ['payload', 'verification', 'restored'])
    await rm(join(directory, name), { recursive: true, force: true }).catch(() => {
      cleanup = false
    })
  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify(
      {
        runId,
        scope: 'small-fixture independent-container recovery only',
        sourceHostPhysicallyUnavailable: false,
        externalSavedMaterials: 'owner-confirmed',
        permissions: 'remain-isolated',
        applicationHeadIsUncommitted: true,
        applicationSourceHash,
        fullDataset: false,
        retentionAgeIsSimulated: true,
        sourceInstanceRemoved: sourceClosed,
        objectCount,
        objectBytes,
        isolatedReplaySeconds: replaySeconds,
        results,
        cleanup,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  )
  console.log(`cleanup=${cleanup}; evidence=${directory}/result.json`)
}
process.exitCode = cleanup && results.every((result) => result.pass) ? 0 : 1
