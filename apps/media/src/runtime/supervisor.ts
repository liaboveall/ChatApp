import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import {
  chmod,
  type FileHandle,
  lstat,
  open,
  readdir,
  realpath,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import {
  decodeMediaRequest,
  decodeMediaResponse,
  encodeMediaHeader,
  MEDIA_LIMITS,
  type MediaFile,
  type MediaIdentity,
  type MediaRequest,
  type MediaResponse,
  mediaIdentity,
  mediaIdentitySchema,
} from '@chatapp/contracts/media'
import {
  failureCode,
  imageFormat,
  MediaError,
  outputName,
  TASK_FILES,
  validateResult,
  videoDemuxer,
} from '../policy.ts'
import {
  CleanupError,
  closeFile,
  hasErrorCode,
  readSmallFile,
  type TaskDirectory,
  TaskRoot,
  verifyFile,
  writeFileChunk,
} from './files.ts'
import { killTaskGroup, spawnTask, type TaskProcess, terminateTask } from './process-group.ts'
import { abortable, endSocket, readHeader, readSocket, writeSocket } from './socket.ts'

export type MediaServerOptions = {
  socketPath: string
  taskEntry: string
  temporaryRoot?: string
  /** Tests can shorten the entire connection deadline, never extend the production hard limit. */
  taskMs?: number
}
export type MediaServer = { close(): Promise<void> }

type Output = { file: MediaFile; handle: FileHandle }
type Connection = {
  socket: Socket
  controller: AbortController
  done: Promise<void>
  identity?: MediaIdentity
  task?: TaskProcess
  replyStarted: boolean
}

function recoverIdentity(header: Uint8Array): MediaIdentity | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const fields = value as Record<string, unknown>
    const parsed = mediaIdentitySchema.safeParse({
      v: fields.v,
      jobId: fields.jobId,
      generation: fields.generation,
      nonce: fields.nonce,
    })
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function receiveInput(
  connection: Connection,
  request: MediaRequest,
  directory: string,
): Promise<void> {
  const handle = await open(
    join(directory, TASK_FILES.input),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    const hash = createHash('sha256')
    let bytes = 0
    while (bytes < request.inputBytes) {
      const chunk = await readSocket(
        connection.socket,
        request.inputBytes - bytes,
        connection.controller.signal,
      )
      if (chunk === null) throw new MediaError('invalid_input')
      await writeFileChunk(handle, chunk)
      hash.update(chunk)
      bytes += chunk.byteLength
    }
    if (await readSocket(connection.socket, 1, connection.controller.signal))
      throw new MediaError('input_limit')
    if (hash.digest('hex') !== request.inputSha256) throw new MediaError('invalid_input')
  } finally {
    await closeFile(handle)
  }
}

async function outputMagic(output: Output): Promise<void> {
  const bytes = Buffer.alloc(512)
  const read = await output.handle.read(bytes, 0, bytes.byteLength, 0)
  const prefix = bytes.subarray(0, read.bytesRead)
  if (
    (output.file.mime === 'image/webp' && imageFormat(prefix) !== 'webp') ||
    (output.file.mime === 'image/gif' && imageFormat(prefix) !== 'gif') ||
    (output.file.mime === 'video/mp4' && videoDemuxer(prefix) !== 'mov')
  )
    throw new MediaError('processor_failed')
}

async function sendOutputs(
  connection: Connection,
  result: MediaResponse,
  outputs: Output[],
): Promise<void> {
  connection.replyStarted = true
  await writeSocket(connection.socket, encodeMediaHeader(result), connection.controller.signal)
  const buffer = Buffer.alloc(MEDIA_LIMITS.chunkBytes)
  for (const output of outputs) {
    const hash = createHash('sha256')
    let bytes = 0
    while (bytes < output.file.bytes) {
      connection.controller.signal.throwIfAborted()
      const read = await output.handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, output.file.bytes - bytes),
        bytes,
      )
      if (read.bytesRead === 0) throw new MediaError('processor_failed')
      const chunk = buffer.subarray(0, read.bytesRead)
      hash.update(chunk)
      await writeSocket(connection.socket, chunk, connection.controller.signal)
      bytes += read.bytesRead
    }
    const extra = await output.handle.read(buffer, 0, 1, bytes)
    if (extra.bytesRead !== 0 || hash.digest('hex') !== output.file.sha256)
      throw new MediaError('processor_failed')
  }
}

async function socketExists(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('media_socket_unavailable'))
    }, 1000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (error: unknown) => {
      clearTimeout(timer)
      socket.destroy()
      if (hasErrorCode(error, 'ECONNREFUSED') || hasErrorCode(error, 'ENOENT')) resolve(false)
      else reject(new Error('media_socket_unavailable'))
    })
  })
}

async function prepareSocket(path: string): Promise<void> {
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    !/^[A-Za-z0-9_.-]+\.sock$/.test(basename(path))
  )
    throw new Error('media_socket_invalid')
  const parent = await lstat(dirname(path))
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o777) !== 0o700 ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw new Error('media_socket_invalid')
  let existing: Stats
  try {
    existing = await lstat(path)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return
    throw new Error('media_socket_invalid')
  }
  if (!existing.isSocket() || existing.uid !== process.getuid?.() || existing.nlink !== 1)
    throw new Error('media_socket_invalid')
  if (await socketExists(path)) throw new Error('media_socket_in_use')
  const current = await lstat(path)
  if (!current.isSocket() || current.ino !== existing.ino || current.dev !== existing.dev)
    throw new Error('media_socket_invalid')
  await unlink(path)
}

/** Linux-only supervisor. Options are trusted entry-point configuration, never IPC fields. */
export async function startMediaServer(options: MediaServerOptions): Promise<MediaServer> {
  if (process.platform !== 'linux') throw new Error('media_requires_linux')
  const taskMs = options.taskMs ?? MEDIA_LIMITS.taskMs
  if (!Number.isSafeInteger(taskMs) || taskMs < 1 || taskMs > MEDIA_LIMITS.taskMs)
    throw new Error('media_deadline_invalid')
  if (!isAbsolute(options.taskEntry) || normalize(options.taskEntry) !== options.taskEntry)
    throw new Error('media_entry_invalid')
  const entry = await lstat(options.taskEntry)
  if (!entry.isFile() || (await realpath(options.taskEntry)) !== options.taskEntry)
    throw new Error('media_entry_invalid')
  await prepareSocket(options.socketPath)
  const root = await TaskRoot.prepare(options.temporaryRoot ?? '/tmp/chatapp-media')
  let active: Connection | undefined
  // Admission opens only after socket permissions and shutdown handlers are installed.
  let stopping = true
  let closePromise: Promise<void> | undefined

  const fatal = (): never => {
    stopping = true
    active?.socket.destroy()
    if (active?.task) {
      try {
        killTaskGroup(active.task)
      } catch {
        /* The container must terminate if even killing fails. */
      }
    }
    server.close()
    console.error('media_cleanup_failed')
    process.exit(1)
  }

  const abort = (
    connection: Connection,
    code: 'timeout' | 'invalid_input' | 'processor_failed',
  ) => {
    if (!connection.controller.signal.aborted) connection.controller.abort(new MediaError(code))
    if (connection.task) {
      try {
        killTaskGroup(connection.task)
      } catch {
        fatal()
      }
    }
    // A hard connection deadline also closes a slow receiver. No extra grace period or queue.
    connection.socket.destroy()
  }

  const run = async (connection: Connection) => {
    let directory: TaskDirectory | undefined
    const outputs: Output[] = []
    let response: MediaResponse | undefined
    let failed: ReturnType<typeof failureCode> | undefined
    let cleanupFailed = false
    try {
      const header = await readHeader(connection.socket, connection.controller.signal)
      if (header === null) return
      let request: MediaRequest
      try {
        request = decodeMediaRequest(header)
        connection.identity = mediaIdentity(request)
      } catch {
        connection.identity = recoverIdentity(header)
        throw new MediaError('invalid_request')
      }
      connection.controller.signal.throwIfAborted()
      directory = await root.create()
      await receiveInput(connection, request, directory.path)
      await writeFile(join(directory.path, TASK_FILES.request), JSON.stringify(request), {
        flag: 'wx',
        mode: 0o600,
      })
      connection.controller.signal.throwIfAborted()
      connection.task = spawnTask(options.taskEntry, directory.path)
      const exit = await abortable(connection.task.exited, connection.controller.signal)
      if (exit.failedToStart || exit.code !== 0)
        // Only trusted process status, never decoder exceptions, input or request identity.
        console.warn(`media_task_exit:${JSON.stringify(exit)}`)
      await terminateTask(connection.task)
      if (exit.failedToStart || exit.code !== 0) throw new MediaError('processor_failed')
      connection.controller.signal.throwIfAborted()
      await root.assert(directory)
      response = decodeMediaResponse(
        await readSmallFile(join(directory.path, TASK_FILES.result), MEDIA_LIMITS.headerBytes),
      )
      validateResult(request, response)
      if (response.status === 'ok') {
        const names = new Set<string>([
          TASK_FILES.input,
          TASK_FILES.request,
          TASK_FILES.result,
          ...response.files.map((file) => outputName(file.variant)),
        ])
        const entries = await readdir(directory.path, { withFileTypes: true })
        if (
          entries.length !== names.size ||
          entries.some((file) => !file.isFile() || !names.has(file.name))
        )
          throw new MediaError('processor_failed')
        for (const file of response.files) {
          const output = {
            file,
            handle: await verifyFile(
              join(directory.path, outputName(file.variant)),
              file,
              'processor_failed',
              connection.controller.signal,
            ),
          }
          outputs.push(output)
          await outputMagic(output)
        }
        await sendOutputs(connection, response, outputs)
      }
    } catch (error) {
      cleanupFailed = error instanceof CleanupError
      failed = failureCode(error)
    } finally {
      try {
        if (connection.task) await terminateTask(connection.task)
      } catch {
        cleanupFailed = true
      }
      for (const output of outputs) {
        try {
          await closeFile(output.handle)
        } catch {
          cleanupFailed = true
        }
      }
      if (!cleanupFailed) {
        try {
          if (directory) await root.remove(directory)
          else {
            await root.assert()
            if ((await readdir(root.path)).length !== 0) cleanupFailed = true
          }
        } catch {
          cleanupFailed = true
        }
      }
      if (cleanupFailed) fatal()
    }
    if (connection.controller.signal.aborted || connection.socket.destroyed) return
    if (failed && connection.replyStarted) {
      connection.socket.destroy()
      return
    }
    if (failed && connection.identity) {
      connection.replyStarted = true
      await writeSocket(
        connection.socket,
        encodeMediaHeader({ ...connection.identity, status: 'failed', code: failed }),
        connection.controller.signal,
      )
    } else if (response?.status === 'failed') {
      connection.replyStarted = true
      await writeSocket(
        connection.socket,
        encodeMediaHeader(response),
        connection.controller.signal,
      )
    }
    // A complete response's EOF is released only after process-group and file cleanup succeeded.
    await endSocket(connection.socket, connection.controller.signal)
  }

  const server = createServer(
    { allowHalfOpen: true, highWaterMark: MEDIA_LIMITS.chunkBytes },
    (socket) => {
      if (stopping || active) {
        socket.on('error', () => socket.destroy())
        socket.destroy()
        return
      }
      const completion = Promise.withResolvers<void>()
      const connection: Connection = {
        socket,
        controller: new AbortController(),
        done: completion.promise,
        replyStarted: false,
      }
      active = connection
      const timer = setTimeout(() => abort(connection, 'timeout'), taskMs)
      socket.once('close', () => abort(connection, 'invalid_input'))
      socket.on('error', () => abort(connection, 'invalid_input'))
      void run(connection)
        .catch(() => {
          socket.destroy()
        })
        .finally(() => {
          clearTimeout(timer)
          socket.destroy()
          if (active === connection) active = undefined
          completion.resolve()
        })
    },
  )

  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error('media_listen_failed'))
    server.once('error', failed)
    server.listen({ path: options.socketPath, backlog: 1 }, () => {
      server.off('error', failed)
      resolve()
    })
  })
  await chmod(options.socketPath, 0o600)
  const socketInode = await lstat(options.socketPath)
  server.on('error', fatal)

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    stopping = true
    closePromise = (async () => {
      const current = active
      if (current) abort(current, 'processor_failed')
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (current) await current.done
      try {
        const stat = await lstat(options.socketPath)
        if (!stat.isSocket() || stat.dev !== socketInode.dev || stat.ino !== socketInode.ino)
          throw new CleanupError()
        await unlink(options.socketPath)
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) fatal()
      }
      try {
        await root.assert()
        if ((await readdir(root.path)).length !== 0) throw new CleanupError()
      } catch {
        fatal()
      }
      process.off('SIGTERM', signal)
      process.off('SIGINT', signal)
    })()
    return closePromise
  }
  const signal = () => {
    void close().then(() => process.exit(0), fatal)
  }
  process.on('SIGTERM', signal)
  process.on('SIGINT', signal)
  stopping = false
  return { close }
}
