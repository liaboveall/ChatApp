/** Native pinned restic runtime; available only in the operator image, never in API/media. */
import { lstat, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type BackupManifest, backupManifestSchema } from '@chatapp/contracts'
import { z } from 'zod'
import type { OffsiteTarget } from '../storage/conditional.ts'
import { freshDirectory, hashFile, plainFiles, runPrivate, sha256 } from './operations-files.ts'

const snapshotsSchema = z.array(
  z
    .object({
      id: z.string().regex(/^[a-f0-9]{64}$/),
      time: z.iso.datetime(),
      paths: z.array(z.string()),
      tags: z.array(z.string()).optional(),
    })
    .passthrough(),
)
export type VerifiedSnapshot = { snapshotId: string; manifest: BackupManifest }
export class NativeRestic {
  private constructor(
    private readonly environment: Record<string, string>,
    readonly stage: string,
    private readonly caFile?: string,
  ) {}
  static async create(options: {
    target: OffsiteTarget
    prefix: string
    passwordFile: string
    stage: string
    caFile?: string
  }) {
    if (!/^chatapp\/[a-f0-9-]{36}$/.test(options.prefix))
      throw new Error('dedicated repository namespace required')
    const password = await lstat(options.passwordFile)
    if (
      !password.isFile() ||
      (password.mode & 0o777) !== 0o600 ||
      password.size < 32 ||
      password.size > 4096
    )
      throw new Error('private separate restic password required')
    const stage = resolve(options.stage)
    const info = await lstat(stage)
    if (!info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new Error('private backup staging required')
    if (options.caFile) {
      const certificate = await lstat(options.caFile)
      if (!certificate.isFile() || certificate.size > 1024 * 1024)
        throw new Error('bounded regular trust certificate required')
    }
    return new NativeRestic(
      {
        RESTIC_REPOSITORY: `s3:${options.target.endpoint}/${options.target.bucket}/${options.prefix}`,
        AWS_ACCESS_KEY_ID: options.target.accessKeyId,
        AWS_SECRET_ACCESS_KEY: options.target.secretAccessKey,
        AWS_DEFAULT_REGION: options.target.region,
        RESTIC_PASSWORD_FILE: resolve(options.passwordFile),
        RESTIC_CACHE_DIR: '/tmp/restic-cache',
      },
      stage,
      options.caFile,
    )
  }
  run(args: string[], cwd?: string) {
    return runPrivate(
      [
        'restic',
        ...(this.caFile ? ['--cacert', this.caFile] : []),
        '--retry-lock',
        '30s',
        '-o',
        's3.bucket-lookup=path',
        ...args,
      ],
      {
        env: this.environment,
        cwd,
      },
    )
  }
  async init() {
    await this.run(['init'])
  }
  async snapshots() {
    return snapshotsSchema.parse(JSON.parse(await this.run(['snapshots', '--json'])))
  }
  async backup(directory: string, tag: string): Promise<string> {
    const output = await this.run(['backup', 'payload', '--json', '--tag', tag], directory)
    for (const line of output.trim().split('\n').reverse()) {
      const item = z
        .object({ message_type: z.string(), snapshot_id: z.string().optional() })
        .passthrough()
        .parse(JSON.parse(line))
      if (item.message_type === 'summary' && /^[a-f0-9]{64}$/.test(item.snapshot_id ?? ''))
        return item.snapshot_id ?? ''
    }
    throw new Error('offsite snapshot confirmation missing')
  }
  async download(
    id: string,
    root = this.stage,
  ): Promise<{ directory: string; manifest: BackupManifest }> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('full immutable snapshot identifier required')
    const snapshot = (await this.snapshots()).find((item) => item.id === id)
    if (
      snapshot?.paths.length !== 1 ||
      !snapshot.paths[0]?.endsWith('/payload') ||
      !/^\/[A-Za-z0-9_/-]+\/payload$/.test(snapshot.paths[0]) ||
      snapshot.paths[0].split('/').some((item) => item === '..' || item === '.')
    )
      throw new Error('snapshot payload layout invalid')
    const directory = await freshDirectory(root)
    // A relative backup of `payload` stores its absolute source in metadata, but its tree starts at /payload.
    // Restore the complete tree; filtering by the metadata path can succeed while restoring zero files.
    await this.run(['restore', id, '--target', directory, '--verify'])
    if ((await plainFiles(directory)).some((path) => !path.startsWith('payload/')))
      throw new Error('unexpected file outside snapshot payload')
    const payload = join(directory, 'payload')
    const manifest = await verifyPayload(payload)
    return { directory: payload, manifest }
  }
  async readVerifiedInventory(): Promise<VerifiedSnapshot[]> {
    await this.run(['check', '--read-data'])
    const result: VerifiedSnapshot[] = []
    for (const snapshot of await this.snapshots()) {
      const root = await freshDirectory(this.stage)
      try {
        const restored = await this.download(snapshot.id, root)
        result.push({ snapshotId: snapshot.id, manifest: restored.manifest })
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
    return result
  }
  /** Catalog must be independently verified first. An unknown extra snapshot stops retention rather than hiding it. */
  async retain(inventory: VerifiedSnapshot[], now: Date): Promise<{ removed: number }> {
    if (inventory.some((item) => Date.parse(item.manifest.snapshotAt) > now.getTime() + 300_000))
      throw new Error('future backup timestamps require operator review before retention')
    const listed = await this.snapshots()
    const known = new Set(inventory.map((item) => item.snapshotId))
    if (listed.length !== known.size || listed.some((item) => !known.has(item.id)))
      throw new Error('backup catalog changed before retention')
    const cutoff = now.getTime() - 28 * 86_400_000
    const eligible = inventory
      .filter((item) => Date.parse(item.manifest.snapshotAt) > cutoff)
      .sort((a, b) => Date.parse(b.manifest.snapshotAt) - Date.parse(a.manifest.snapshotAt))
    if (!eligible.length) throw new Error('fresh verified backup required before retention')
    const daily = new Set<string>(),
      weekly = new Set<string>(),
      keep = new Set<string>()
    for (const item of eligible) {
      const at = Date.parse(item.manifest.snapshotAt)
      const day = new Date(at).toISOString().slice(0, 10)
      const week = String(Math.floor((at + 3 * 86_400_000) / (7 * 86_400_000)))
      if (daily.size < 7 && !daily.has(day)) {
        daily.add(day)
        keep.add(item.snapshotId)
      }
      if (weekly.size < 4 && !weekly.has(week)) {
        weekly.add(week)
        keep.add(item.snapshotId)
      }
    }
    const remove = inventory.filter((item) => !keep.has(item.snapshotId))
    if (remove.length)
      await this.run(['forget', ...remove.map((item) => item.snapshotId), '--prune'])
    await this.run(['check', '--read-data'])
    return { removed: remove.length }
  }
}
export async function verifyPayload(path: string): Promise<BackupManifest> {
  const info = await lstat(join(path, 'manifest.json'))
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('bounded manifest required')
  const manifest = backupManifestSchema.parse(
    JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')),
  )
  const expected = [
    'manifest.json',
    'database.dump',
    ...manifest.objects.map((item) => `objects/${sha256(item.key)}`),
    ...manifest.recoveryFiles.map((item) => `recovery/${item.name}`),
  ].sort()
  const actual = await plainFiles(path)
  if (actual.length !== expected.length || actual.some((item, i) => item !== expected[i]))
    throw new Error('unexpected or missing backup payload file')
  const database = await hashFile(join(path, 'database.dump'))
  if (database.size !== manifest.database.size || database.sha256 !== manifest.database.sha256)
    throw new Error('backup database integrity mismatch')
  for (const item of manifest.objects) {
    const file = await hashFile(join(path, 'objects', sha256(item.key)))
    if (file.size !== item.size || file.sha256 !== item.sha256)
      throw new Error('backup object integrity mismatch')
  }
  for (const item of manifest.recoveryFiles)
    if ((await hashFile(join(path, 'recovery', item.name))).sha256 !== item.sha256)
      throw new Error('backup recovery material integrity mismatch')
  return manifest
}
