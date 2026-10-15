/** Private, bounded operator inputs. No shell expansion, symlinks or raw subprocess diagnostics. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'

export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
export const releaseSchema = z
  .object({
    format: z.literal(1),
    applicationSha: z.string().regex(/^[a-f0-9]{40}$/),
    applicationSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()

export async function privateJson<T>(
  path: string,
  schema: z.ZodType<T>,
  maximum = 128_000,
): Promise<T> {
  const info = await lstat(path)
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > maximum)
    throw new Error('operator input must be a bounded regular private file')
  return schema.parse(JSON.parse(await readFile(path, 'utf8')))
}
export async function privateWrite(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
}
export async function freshDirectory(
  root: string,
  name: string = crypto.randomUUID(),
): Promise<string> {
  if (!/^[a-z0-9-]{1,80}$/.test(name)) throw new Error('invalid operator directory name')
  const base = resolve(root)
  const info = await lstat(base)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0)
    throw new Error('operator staging root must be a private directory')
  const target = join(base, name)
  await mkdir(target, { mode: 0o700 })
  return target
}
export async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  if (!(await lstat(path)).isFile()) throw new Error('regular backup file required')
  const hash = createHash('sha256')
  let size = 0
  for await (const bytes of Bun.file(path).stream()) {
    hash.update(bytes)
    size += bytes.length
  }
  return { size, sha256: hash.digest('hex') }
}
export async function plainFiles(path: string, prefix = ''): Promise<string[]> {
  if (!(await lstat(path)).isDirectory()) throw new Error('plain backup directory required')
  const result: string[] = []
  for (const item of await readdir(path, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) result.push(...(await plainFiles(join(path, item.name), relative)))
    else if (item.isFile()) result.push(relative)
    else throw new Error('backup symlinks and special files forbidden')
  }
  return result.sort()
}

export async function runPrivate(
  command: string[],
  options: {
    env?: Record<string, string | undefined>
    cwd?: string
    timeoutMs?: number
  } = {},
): Promise<string> {
  // Whitelist child environment: provider, SMTP, token and database secrets are not inherited by restic or pg_dump.
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', TMPDIR: '/tmp', ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 3 * 60 * 60 * 1000)
  try {
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of stream) {
        size += chunk.length
        if (size > 16 * 1024 * 1024) {
          child.kill('SIGKILL')
          throw new Error('operator output limit')
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks).toString('utf8')
    }
    const outputs = await Promise.all([read(child.stdout), read(child.stderr)])
    if ((await child.exited) !== 0) throw new Error('operator subprocess failed')
    return outputs[0] ?? ''
  } finally {
    clearTimeout(timer)
  }
}
export function postgresEnvironment(value: string): Record<string, string> {
  const url = new URL(value)
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  )
    throw new Error('invalid owner connection')
  const ssl = url.searchParams.get('sslmode') ?? 'prefer'
  if (!['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(ssl))
    throw new Error('invalid PostgreSQL TLS policy')
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: ssl,
    PGCONNECT_TIMEOUT: '10',
  }
}
