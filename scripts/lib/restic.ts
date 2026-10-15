/** Pinned official restic runtime. Credentials are private files, never arguments or diagnostic output. */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { OffsiteTarget } from '../../apps/server/src/storage/conditional.ts'
import { type BackupManifest, backupManifestSchema } from '../../packages/contracts/src/backup.ts'

export const RESTIC_IMAGE =
  'restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510'
export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
export async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  if (!(await lstat(path)).isFile()) throw new Error('backup file must be a regular file')
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of Bun.file(path).stream()) {
    size += bytes.length
    hash.update(bytes)
  }
  return { size, sha256: hash.digest('hex') }
}

export class ResticRepository {
  private constructor(
    readonly directory: string,
    readonly payload: string,
    private readonly envFile: string,
    private readonly passwordFile: string,
  ) {}
  static async create(options: {
    target: OffsiteTarget
    prefix: string
    directory: string
    passwordFile: string
    payload: string
  }) {
    if (
      !/^m7-restic\/[a-f0-9-]{36}$/.test(options.prefix) ||
      !options.target.bucket.endsWith('-test')
    )
      throw new Error('restic test ownership required')
    const directory = resolve(options.directory),
      passwordFile = resolve(options.passwordFile),
      payload = resolve(options.payload)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const envFile = join(directory, 'restic.env')
    const values = {
      RESTIC_REPOSITORY: `s3:${options.target.endpoint}/${options.target.bucket}/${options.prefix}`,
      AWS_ACCESS_KEY_ID: options.target.accessKeyId,
      AWS_SECRET_ACCESS_KEY: options.target.secretAccessKey,
      AWS_DEFAULT_REGION: options.target.region,
      RESTIC_PASSWORD_FILE: '/run/password',
      RESTIC_CACHE_DIR: '/tmp/cache',
    }
    if (Object.values(values).some((value) => /[\r\n]/.test(value)))
      throw new Error('invalid restic setting')
    await writeFile(
      envFile,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    )
    await chmod(envFile, 0o600)
    return new ResticRepository(directory, payload, envFile, passwordFile)
  }
  async run(args: string[], restoreTarget?: string): Promise<string> {
    const mounts = [
      '--mount',
      `type=bind,src=${this.passwordFile},dst=/run/password,readonly`,
      '--mount',
      `type=bind,src=${this.payload},dst=/payload,readonly`,
    ]
    if (restoreTarget) {
      await mkdir(restoreTarget, { recursive: true, mode: 0o700 })
      mounts.push('--mount', `type=bind,src=${resolve(restoreTarget)},dst=/restore`)
    }
    const process = Bun.spawn(
      [
        'docker',
        'run',
        '--rm',
        '--network',
        'host',
        '--user',
        `${processUid()}:${processGid()}`,
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=512m',
        '--env-file',
        this.envFile,
        ...mounts,
        RESTIC_IMAGE,
        '--retry-lock',
        '30s',
        '-o',
        's3.bucket-lookup=path',
        ...args,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    const outputs = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ])
    if ((await process.exited) !== 0) throw new Error('restic operation failed')
    return outputs[0] ?? ''
  }
  async init() {
    await this.run(['init'])
  }
  async backup(tag: string): Promise<string> {
    const output = await this.run(['backup', '/payload', '--json', '--tag', tag])
    for (const line of output.trim().split('\n').reverse()) {
      const item = JSON.parse(line) as { message_type?: string; snapshot_id?: string }
      if (
        item.message_type === 'summary' &&
        item.snapshot_id &&
        /^[a-f0-9]{64}$/.test(item.snapshot_id)
      )
        return item.snapshot_id
    }
    throw new Error('restic snapshot confirmation missing')
  }
  async restore(snapshot: string, target: string) {
    if (!/^[a-f0-9]{64}$/.test(snapshot)) throw new Error('invalid snapshot id')
    await this.run(['restore', snapshot, '--target', '/restore', '--verify'], target)
  }
  async verify(snapshot: string, target: string) {
    await this.run(['check', '--read-data'])
    await this.restore(snapshot, target)
    await assertPlainTree(join(target, 'payload'))
    await compareTree(this.payload, join(target, 'payload'))
  }
  async readVerifiedInventory(): Promise<{ snapshotId: string; manifest: BackupManifest }[]> {
    await this.run(['check', '--read-data'])
    const listed: unknown = JSON.parse(await this.run(['snapshots', '--json']))
    if (
      !Array.isArray(listed) ||
      listed.some(
        (item) =>
          !item ||
          typeof item !== 'object' ||
          !('id' in item) ||
          typeof item.id !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.id),
      )
    )
      throw new Error('backup catalog invalid')
    const result: { snapshotId: string; manifest: BackupManifest }[] = []
    for (const snapshot of listed) {
      const target = join(this.directory, 'inventory', crypto.randomUUID())
      try {
        await this.restore(snapshot.id, target)
        const payload = join(target, 'payload')
        await assertPlainTree(payload)
        const manifest = backupManifestSchema.parse(
          JSON.parse(await readFile(join(payload, 'manifest.json'), 'utf8')),
        )
        const database = await hashFile(join(payload, 'database.dump'))
        if (
          database.size !== manifest.database.size ||
          database.sha256 !== manifest.database.sha256
        )
          throw new Error('backup database verification failed')
        for (const object of manifest.objects) {
          const file = await hashFile(join(payload, 'objects', sha256(object.key)))
          if (file.size !== object.size || file.sha256 !== object.sha256)
            throw new Error('backup object verification failed')
        }
        for (const file of manifest.recoveryFiles)
          if ((await hashFile(join(payload, 'recovery', file.name))).sha256 !== file.sha256)
            throw new Error('backup recovery material verification failed')
        result.push({ snapshotId: snapshot.id, manifest })
      } finally {
        await rm(target, { recursive: true, force: true })
      }
    }
    return result
  }
  async clearCredentials() {
    await rm(this.envFile, { force: true })
  }
}
const processUid = () => process.getuid?.() ?? 1000
const processGid = () => process.getgid?.() ?? 1000
async function assertPlainTree(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error('backup payload must be a directory')
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await assertPlainTree(join(path, entry.name))
    else if (!entry.isFile()) throw new Error('backup symlinks and special files are forbidden')
  }
}
async function compareTree(source: string, restored: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true })
  const copyEntries = await readdir(restored)
  if (entries.length !== copyEntries.length) throw new Error('restic restored tree differs')
  for (const entry of entries) {
    if (entry.isDirectory()) await compareTree(join(source, entry.name), join(restored, entry.name))
    else if (entry.isFile()) {
      const original = await hashFile(join(source, entry.name)),
        copy = await hashFile(join(restored, entry.name))
      if (original.size !== copy.size || original.sha256 !== copy.sha256)
        throw new Error('restic restored bytes differ')
    } else throw new Error('backup symlinks and special files are forbidden')
  }
}
