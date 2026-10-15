/** New, dedicated Garage only. Its Admin API credentials are never given to the ordinary API/worker. */
import { lstat, mkdir, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { privateJson, privateWrite } from './operations-files.ts'

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
  const token = source.GARAGE_ADMIN_TOKEN
  const prefix = /^chatapp\/([a-f0-9-]{36})$/.exec(source.BACKUP_REPOSITORY_PREFIX ?? '')
  const owner = z.uuid().parse(source.CHATAPP_OWNER ?? prefix?.[1]),
    bucket = source.S3_BUCKET
  if (!token || !bucket || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(bucket))
    throw new Error('dedicated Garage operator configuration required')
  const directory = source.BACKUP_STAGE_DIR ?? '/var/lib/chatapp/backup'
  const info = await lstat(directory)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('private staging directory required')
  const file = join(directory, 'storage-initialized.json')
  const lock = join(directory, 'storage-initialization-lock')
  await mkdir(lock, { mode: 0o700 })
  try {
    const request = async (operation: string, input?: unknown): Promise<unknown> => {
      const response = await fetch(`http://garage:3903/v2/${operation}`, {
        method: input ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: input ? JSON.stringify(input) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error('private Garage initialization failed')
      return await response.json()
    }
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
