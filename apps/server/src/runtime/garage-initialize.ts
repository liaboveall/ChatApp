/** New, dedicated Garage only. Its Admin API credentials are never given to the ordinary API/worker. */
import { lstat, mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { privateJson, privateWrite } from './operations-files.ts'

type GarageOperation =
  | 'GetClusterLayout'
  | 'GetClusterStatus'
  | 'UpdateClusterLayout'
  | 'ApplyClusterLayout'
  | 'CreateKey'
  | 'CreateBucket'
  | 'AllowBucketKey'

type PreparationStage =
  | GarageOperation
  | 'configuration'
  | 'staging-directory'
  | 'staging-lock'
  | 'existing-credentials'
  | 'key-phase'
  | 'bucket-phase'
  | 'save-credentials'
export class GaragePreparationError extends Error {
  constructor(
    readonly stage: PreparationStage,
    readonly reason: 'invalid_structure' | 'filesystem_access' | 'precondition_failed',
  ) {
    super('private Garage preparation failed')
  }
}

/** Only fixed operation names and HTTP status are safe for operator diagnostics. */
export class GarageInitializationError extends Error {
  constructor(
    readonly operation: GarageOperation,
    readonly reason: 'network_or_timeout' | 'http_status' | 'invalid_json',
    readonly statusCode?: number,
  ) {
    super('private Garage initialization failed')
  }
}

export const storageCredentialsSchema = z
  .object({
    format: z.literal(1),
    owner: z.uuid(),
    bucket: z.string(),
    bucketId: z.string().regex(/^[a-f0-9]{64}$/),
    accessKeyId: z.string().regex(/^GK[a-f0-9]{24}$/),
    secretAccessKey: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export async function initializeGarage(source: Record<string, string | undefined>) {
  let stage: PreparationStage = 'configuration'
  try {
    return await prepareGarage(source, (next) => {
      stage = next
    })
  } catch (error) {
    if (error instanceof GarageInitializationError) throw error
    const filesystemError =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EROFS'].includes(String(error.code))
    throw new GaragePreparationError(
      stage,
      error instanceof z.ZodError
        ? 'invalid_structure'
        : filesystemError
          ? 'filesystem_access'
          : 'precondition_failed',
    )
  }
}
async function prepareGarage(
  source: Record<string, string | undefined>,
  mark: (stage: PreparationStage) => void,
) {
  const token = source.GARAGE_ADMIN_TOKEN
  const prefix = /^chatapp\/([a-f0-9-]{36})$/.exec(source.BACKUP_REPOSITORY_PREFIX ?? '')
  const owner = z.uuid().parse(source.CHATAPP_OWNER ?? prefix?.[1]),
    bucket = source.S3_BUCKET
  if (!token || !bucket || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(bucket))
    throw new Error('dedicated Garage operator configuration required')
  const directory = source.BACKUP_STAGE_DIR ?? '/var/lib/chatapp/backup'
  mark('staging-directory')
  const info = await lstat(directory)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('private staging directory required')
  const file = join(directory, 'storage-initialized.json')
  const lock = join(directory, 'storage-initialization-lock')
  mark('staging-lock')
  await mkdir(lock, { mode: 0o700 })
  try {
    const request = async (operation: GarageOperation, input?: unknown): Promise<unknown> => {
      mark(operation)
      let response: Response
      try {
        response = await fetch(`http://garage:3903/v2/${operation}`, {
          method: input ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: input ? JSON.stringify(input) : undefined,
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        })
      } catch {
        throw new GarageInitializationError(operation, 'network_or_timeout')
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new GarageInitializationError(operation, 'http_status', response.status)
      }
      try {
        return await response.json()
      } catch {
        throw new GarageInitializationError(operation, 'invalid_json', response.status)
      }
    }
    mark('existing-credentials')
    try {
      const existing = await privateJson(file, storageCredentialsSchema)
      if (existing.owner !== owner || existing.bucket !== bucket)
        throw new Error('Garage initialization identity differs')
      return { status: 'storage_prepared', credentialFile: file }
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error
    }
    const layout = z
      .object({ version: z.number().int(), roles: z.array(z.unknown()) })
      .passthrough()
      .parse(await request('GetClusterLayout'))
    const status = z
      .object({
        nodes: z.array(
          z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), isUp: z.boolean() }).passthrough(),
        ),
      })
      .passthrough()
      .parse(await request('GetClusterStatus'))
    if (status.nodes.length !== 1 || !status.nodes[0]?.isUp)
      throw new Error('one dedicated live Garage node required')
    if (layout.version === 0 && !layout.roles.length) {
      const capacity = Number(source.GARAGE_CAPACITY_BYTES ?? '40000000000')
      if (
        !Number.isSafeInteger(capacity) ||
        capacity < 1_000_000_000 ||
        capacity > 1_000_000_000_000
      )
        throw new Error('bounded Garage capacity required')
      await request('UpdateClusterLayout', {
        roles: [{ id: status.nodes[0].id, zone: 'chatapp', capacity, tags: ['chatapp'] }],
      })
      await request('ApplyClusterLayout', { version: 1 })
    } else if (layout.version !== 1 || layout.roles.length !== 1)
      throw new Error('existing Garage layout requires operator review')
    const keySchema = z
      .object({
        owner: z.uuid(),
        nodeId: z.string(),
        accessKeyId: z.string(),
        secretAccessKey: z.string(),
      })
      .strict()
    const keyFile = join(directory, 'storage-key-phase.json'),
      bucketFile = join(directory, 'storage-bucket-phase.json')
    let credentials: z.infer<typeof keySchema>
    mark('key-phase')
    try {
      credentials = await privateJson(keyFile, keySchema)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error
      const createdKey = z
        .object({ accessKeyId: z.string(), secretAccessKey: z.string() })
        .passthrough()
        .parse(await request('CreateKey', { name: `chatapp-${owner}`, neverExpires: true }))
      credentials = {
        owner,
        nodeId: status.nodes[0].id,
        accessKeyId: createdKey.accessKeyId,
        secretAccessKey: createdKey.secretAccessKey,
      }
      await privateWrite(keyFile, credentials)
    }
    if (credentials.owner !== owner || credentials.nodeId !== status.nodes[0].id)
      throw new Error('Garage key phase belongs to a different deployment')
    const bucketSchema = z.object({ owner: z.uuid(), alias: z.string(), id: z.string() }).strict()
    let created: z.infer<typeof bucketSchema>
    mark('bucket-phase')
    try {
      created = await privateJson(bucketFile, bucketSchema)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error
      const newBucket = z
        .object({ id: z.string() })
        .passthrough()
        .parse(await request('CreateBucket', { globalAlias: bucket }))
      created = { owner, alias: bucket, id: newBucket.id }
      await privateWrite(bucketFile, created)
    }
    if (created.owner !== owner || created.alias !== bucket)
      throw new Error('Garage bucket phase belongs to a different deployment')
    await request('AllowBucketKey', {
      bucketId: created.id,
      accessKeyId: credentials.accessKeyId,
      permissions: { read: true, write: true, owner: false },
    })
    mark('save-credentials')
    await privateWrite(
      file,
      storageCredentialsSchema.parse({
        format: 1,
        owner,
        bucket,
        bucketId: created.id,
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      }),
    )
    return { status: 'storage_prepared', credentialFile: file }
  } finally {
    await rmdir(lock)
  }
}
