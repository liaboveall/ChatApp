import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { MEDIA_LIMITS, type MediaFailureCode } from '@chatapp/contracts/media'
import { MediaError } from '../policy.ts'

export class CleanupError extends Error {
  constructor() {
    super('media_cleanup_failed')
    this.name = 'CleanupError'
  }
}

type Inode = { dev: number; ino: number; uid: number }
export type TaskDirectory = { path: string; inode: Inode }

export function taskDirectoryName(name: string): boolean {
  return /^task-[A-Za-z0-9]{6}$/.test(name)
}

/** Only a private, direct child of the container's /tmp. Never recursively remove the supplied root. */
export function temporaryRootPath(path: string): boolean {
  return (
    dirname(path) === '/tmp' &&
    path === join('/tmp', basename(path)) &&
    /^[-A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(basename(path))
  )
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function sameInode(first: Inode, second: Inode): boolean {
  return first.dev === second.dev && first.ino === second.ino && first.uid === second.uid
}

async function privateDirectory(path: string, inode?: Inode): Promise<Inode> {
  const stat = await lstat(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (inode && !sameInode(stat, inode)) ||
    (await realpath(path)) !== path
  )
    throw new CleanupError()
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid }
}

export class TaskRoot {
  private constructor(
    readonly path: string,
    private readonly inode: Inode,
  ) {}

  static async prepare(path: string): Promise<TaskRoot> {
    if (!temporaryRootPath(path)) throw new CleanupError()
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) throw new CleanupError()
    }
    const root = new TaskRoot(path, await privateDirectory(path))
    const entries = await readdir(path, { withFileTypes: true })
    // Validate the whole list before deleting anything, including on a restarted container.
    if (entries.some((entry) => !taskDirectoryName(entry.name) || !entry.isDirectory()))
      throw new CleanupError()
    const directories: TaskDirectory[] = []
    for (const entry of entries) {
      const taskPath = join(path, entry.name)
      directories.push({ path: taskPath, inode: await privateDirectory(taskPath) })
    }
    for (const directory of directories) await root.remove(directory, false)
    if ((await readdir(path)).length !== 0) throw new CleanupError()
    return root
  }

  async assert(directory?: TaskDirectory): Promise<void> {
    await privateDirectory(this.path, this.inode)
    if (directory) {
      if (dirname(directory.path) !== this.path || !taskDirectoryName(basename(directory.path)))
        throw new CleanupError()
      await privateDirectory(directory.path, directory.inode)
    }
  }

  async create(): Promise<TaskDirectory> {
    await this.assert()
    const path = await mkdtemp(join(this.path, 'task-'))
    return { path, inode: await privateDirectory(path) }
  }

  async remove(directory: TaskDirectory, requireEmpty = true): Promise<void> {
    try {
      await this.assert(directory)
      // fs.rm unlinks symlinks inside this directory; it never follows their targets.
      await rm(directory.path, { recursive: true, force: false, maxRetries: 0 })
      await this.assert()
      try {
        await lstat(directory.path)
        throw new CleanupError()
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw new CleanupError()
      }
      if (requireEmpty && (await readdir(this.path)).length !== 0) throw new CleanupError()
    } catch {
      throw new CleanupError()
    }
  }
}

export async function assertTaskDirectory(path: string): Promise<void> {
  if (!temporaryRootPath(dirname(path)) || !taskDirectoryName(basename(path)))
    throw new MediaError('invalid_request')
  await privateDirectory(dirname(path))
  await privateDirectory(path)
}

export async function closeFile(handle: FileHandle): Promise<void> {
  try {
    await handle.close()
  } catch {
    throw new CleanupError()
  }
}

export async function openRegular(
  path: string,
  limit: number,
  code: MediaFailureCode = 'processor_failed',
): Promise<FileHandle> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      !Number.isSafeInteger(stat.size) ||
      stat.size < 1 ||
      stat.size > limit
    )
      throw new MediaError(code)
    return handle
  } catch (error) {
    await closeFile(handle)
    throw error
  }
}

export async function readSmallFile(path: string, limit: number): Promise<Uint8Array> {
  const handle = await openRegular(path, limit)
  try {
    const data = Buffer.alloc(limit + 1)
    let bytes = 0
    while (bytes < data.byteLength) {
      const read = await handle.read(data, bytes, data.byteLength - bytes, bytes)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
    }
    if (bytes === 0 || bytes > limit || bytes !== (await handle.stat()).size)
      throw new MediaError('processor_failed')
    return data.subarray(0, bytes)
  } finally {
    await closeFile(handle)
  }
}

export async function fileDigest(
  handle: FileHandle,
  limit: number,
  code: MediaFailureCode = 'processor_failed',
  signal?: AbortSignal,
): Promise<{ bytes: number; sha256: string }> {
  const before = await handle.stat()
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > limit)
    throw new MediaError(code)
  const buffer = Buffer.alloc(MEDIA_LIMITS.chunkBytes)
  const hash = createHash('sha256')
  let bytes = 0
  for (;;) {
    signal?.throwIfAborted()
    const read = await handle.read(buffer, 0, buffer.byteLength, bytes)
    if (read.bytesRead === 0) break
    bytes += read.bytesRead
    if (bytes > limit) throw new MediaError(code)
    hash.update(buffer.subarray(0, read.bytesRead))
  }
  const after = await handle.stat()
  if (
    bytes !== before.size ||
    after.size !== bytes ||
    after.nlink !== 1 ||
    !sameInode(before, after) ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new MediaError(code)
  return { bytes, sha256: hash.digest('hex') }
}

export async function verifyFile(
  path: string,
  expected: { bytes: number; sha256: string },
  code: MediaFailureCode = 'processor_failed',
  signal?: AbortSignal,
): Promise<FileHandle> {
  const handle = await openRegular(path, expected.bytes, code)
  try {
    const actual = await fileDigest(handle, expected.bytes, code, signal)
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new MediaError(code)
    return handle
  } catch (error) {
    await closeFile(handle)
    throw error
  }
}

export async function inspectFile(
  path: string,
  limit: number,
): Promise<{ bytes: number; sha256: string }> {
  const handle = await openRegular(path, limit, 'output_limit')
  try {
    return await fileDigest(handle, limit, 'output_limit')
  } finally {
    await closeFile(handle)
  }
}

export async function filePrefix(path: string): Promise<Uint8Array> {
  const handle = await openRegular(path, MEDIA_LIMITS.inputBytes, 'invalid_input')
  try {
    const buffer = Buffer.alloc(512)
    const read = await handle.read(buffer, 0, buffer.byteLength, 0)
    return buffer.subarray(0, read.bytesRead)
  } finally {
    await closeFile(handle)
  }
}

export async function writeFileChunk(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const written = await handle.write(chunk, offset, chunk.byteLength - offset, null)
    if (written.bytesWritten < 1) throw new MediaError('processor_failed')
    offset += written.bytesWritten
  }
}
