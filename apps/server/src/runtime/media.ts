/** Worker-side, streaming Unix IPC only; decoding stays in the credential-free media container. */
import { createHash } from 'node:crypto'
import { Socket } from 'node:net'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import {
  decodeMediaResponse,
  encodeMediaHeader,
  MEDIA_LIMITS,
  type MediaFailureCode,
  type MediaFile,
  type MediaRequest,
  type MediaResponse,
  type MediaSuccess,
  mediaRequestSchema,
} from '@chatapp/contracts/media'

export const MEDIA_SOCKET_PATH = '/run/chatapp-media/media.sock'

export type MediaClientErrorCode =
  | MediaFailureCode
  | 'aborted'
  | 'connect_failed'
  | 'transport_failed'
  | 'invalid_response'
  | 'identity_mismatch'
  | 'invalid_output'
  | 'sink_failed'

/** No decoder, transport, input or consumer exception is retained, even as an Error.cause. */
export class MediaClientError extends Error {
  readonly code: MediaClientErrorCode

  constructor(code: MediaClientErrorCode) {
    super(code)
    this.name = 'MediaClientError'
    this.code = code
  }
}

/** All bytes are uncommitted staging until process() resolves. Use signal to cancel storage writes. */
export type MediaSink = (
  file: MediaFile,
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) => Promise<void>

export interface MediaClient {
  /**
   * Consume every file completely; returning early or cancelling its stream fails the entire task.
   * Identity/nonce verification is NOT database generation fencing: publishing still requires a
   * domain transaction to recheck the current generation and authorization, and failed staging
   * objects must be reclaimed by the caller.
   */
  process(
    request: MediaRequest,
    input: ReadableStream<Uint8Array>,
    sink: MediaSink,
    options?: { signal?: AbortSignal },
  ): Promise<MediaSuccess>
}

export interface MediaClientOptions {
  /** May tighten, but never extend, the whole-call 60 s deadline (including consumers and EOF). */
  timeoutMs?: number
}

class Task {
  readonly #controller = new AbortController()
  readonly #deadline: number
  readonly #timer: ReturnType<typeof setTimeout>
  readonly #external: AbortSignal | undefined
  #failure: MediaClientError | undefined
  readonly #abort = () => this.fail('aborted')

  constructor(timeoutMs: number, external: AbortSignal | undefined) {
    this.#deadline = performance.now() + timeoutMs
    this.#timer = setTimeout(() => this.fail('timeout'), timeoutMs)
    this.#external = external
    if (external?.aborted) this.fail('aborted')
    else external?.addEventListener('abort', this.#abort, { once: true })
  }

  get signal(): AbortSignal {
    return this.#controller.signal
  }

  get error(): MediaClientError {
    return this.#failure ?? new MediaClientError('aborted')
  }

  fail(code: MediaClientErrorCode): MediaClientError {
    if (!this.#failure) {
      this.#failure = new MediaClientError(code)
      this.#controller.abort(this.#failure)
    }
    return this.#failure
  }

  check(): void {
    if (this.#failure) throw this.#failure
    // Also bound a producer that continually supplies immediately resolved/empty chunks.
    if (performance.now() >= this.#deadline) throw this.fail('timeout')
  }

  wait<T>(pending: Promise<T>, failureCode: MediaClientErrorCode): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const fail = (error: MediaClientError) => {
        if (settled) return
        settled = true
        this.signal.removeEventListener('abort', aborted)
        reject(error)
      }
      const aborted = () => fail(this.error)
      this.signal.addEventListener('abort', aborted, { once: true })
      // Keep rejection handlers attached even after cancellation; arbitrary user promises may
      // settle much later, or never settle. Neither may hold up transport cleanup.
      pending.then(
        (value) => {
          if (settled) return
          try {
            this.check()
          } catch {
            fail(this.error)
            return
          }
          settled = true
          this.signal.removeEventListener('abort', aborted)
          resolve(value)
        },
        () => fail(this.fail(failureCode)),
      )
      try {
        this.check()
      } catch {
        fail(this.error)
      }
    })
  }

  dispose(): void {
    clearTimeout(this.#timer)
    this.#external?.removeEventListener('abort', this.#abort)
  }
}

async function connect(socket: Socket, path: string, task: Task): Promise<void> {
  let connected = false
  const onError = () => task.fail(connected ? 'transport_failed' : 'connect_failed')
  // Retained through destroy/close so late EPIPE/connect errors never become unhandled errors.
  socket.on('error', onError)
  let onConnect = () => {}
  let onClose = () => {}
  const pending = new Promise<void>((resolve, reject) => {
    onConnect = () => {
      connected = true
      resolve()
    }
    onClose = () => reject(new MediaClientError('connect_failed'))
    socket.once('connect', onConnect)
    socket.once('close', onClose)
    socket.connect({ path })
  })
  try {
    await task.wait(pending, 'connect_failed')
  } finally {
    socket.off('connect', onConnect)
    socket.off('close', onClose)
  }
}

async function socketEvent(
  socket: Socket,
  events: readonly ('readable' | 'end' | 'close')[],
  task: Task,
): Promise<void> {
  let wake = () => {}
  const pending = new Promise<void>((resolve) => {
    wake = resolve
    for (const event of events) socket.once(event, wake)
  })
  try {
    await task.wait(pending, 'transport_failed')
  } finally {
    for (const event of events) socket.off(event, wake)
  }
}

/** Paused-mode reads retain bounded socket buffering, never accumulate a whole output. */
async function read(socket: Socket, bytes: number, task: Task): Promise<Uint8Array | null> {
  for (;;) {
    task.check()
    // Consume available bytes rather than demanding a full chunk. Otherwise a partial final
    // chunk (or a high-water-mark buffer shared with the header) can stall before emitting EOF.
    const chunk: unknown = socket.read(Math.min(bytes, Math.max(1, socket.readableLength)))
    if (chunk instanceof Uint8Array && chunk.byteLength > 0 && chunk.byteLength <= bytes)
      return chunk
    if (chunk !== null) throw task.fail('invalid_response')
    if (socket.readableEnded) return null
    if (socket.destroyed) throw task.fail('transport_failed')
    await socketEvent(socket, ['readable', 'end', 'close'], task)
  }
}

async function readHeader(socket: Socket, task: Task): Promise<Uint8Array> {
  const exact = async (bytes: number) => {
    const result = new Uint8Array(bytes)
    let offset = 0
    while (offset < bytes) {
      const chunk = await read(socket, bytes - offset, task)
      if (!chunk) throw task.fail('invalid_response')
      result.set(chunk, offset)
      offset += chunk.byteLength
    }
    return result
  }
  const prefix = await exact(4)
  const bytes = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0)
  // Check the wire prefix BEFORE allocating a header, UTF-8 decoding, JSON parsing or zod.
  if (bytes === 0 || bytes > MEDIA_LIMITS.headerBytes) throw task.fail('invalid_response')
  return exact(bytes)
}

async function write(socket: Socket, bytes: Uint8Array, task: Task): Promise<void> {
  task.check()
  let onClose = () => {}
  const pending = new Promise<void>((resolve, reject) => {
    onClose = () => reject(new MediaClientError('transport_failed'))
    socket.once('close', onClose)
    socket.write(bytes, (error) => {
      if (error) reject(new MediaClientError('transport_failed'))
      else resolve()
    })
  })
  try {
    // Only one <=64 KiB write is outstanding. Awaiting its callback bounds writable buffering
    // and propagates a slow peer's backpressure all the way to input.read().
    await task.wait(pending, 'transport_failed')
  } finally {
    socket.off('close', onClose)
  }
}

async function finishInput(socket: Socket, task: Task): Promise<void> {
  task.check()
  let onClose = () => {}
  const pending = new Promise<void>((resolve, reject) => {
    onClose = () => reject(new MediaClientError('transport_failed'))
    socket.once('close', onClose)
    socket.end(resolve)
  })
  try {
    await task.wait(pending, 'transport_failed')
  } finally {
    socket.off('close', onClose)
  }
}

async function send(
  socket: Socket,
  request: MediaRequest,
  header: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  task: Task,
): Promise<void> {
  await write(socket, header, task)
  const digest = createHash('sha256')
  let bytes = 0
  for (;;) {
    const next = await task.wait(reader.read(), 'invalid_input')
    if (next.done) break
    if (!(next.value instanceof Uint8Array)) throw task.fail('invalid_input')
    if (next.value.byteLength > request.inputBytes - bytes) throw task.fail('invalid_input')
    bytes += next.value.byteLength
    for (let offset = 0; offset < next.value.byteLength; offset += MEDIA_LIMITS.chunkBytes) {
      // Own the queued bytes: a producer may reuse or mutate its buffer while a write is pending.
      const chunk = new Uint8Array(next.value.subarray(offset, offset + MEDIA_LIMITS.chunkBytes))
      digest.update(chunk)
      await write(socket, chunk, task)
    }
  }
  if (bytes !== request.inputBytes || digest.digest('hex') !== request.inputSha256)
    throw task.fail('invalid_input')
  await finishInput(socket, task)
}

function validateOutput(request: MediaRequest, response: MediaSuccess, task: Task): void {
  if (
    (request.operation === 'video' && response.kind === 'image') ||
    (request.operation !== 'video' && response.kind !== 'image') ||
    (request.operation === 'avatar' && (response.width !== 256 || response.height !== 256))
  )
    throw task.fail('invalid_response')

  let originalBytes = 0
  let variantBytes = 0
  for (const file of response.files) {
    if (file.variant === 'original') originalBytes += file.bytes
    else variantBytes += file.bytes
    if (
      file.mime === 'image/webp' &&
      file.width !== null &&
      file.height !== null &&
      file.width * file.height > MEDIA_LIMITS.staticPixels
    )
      throw task.fail('invalid_response')
    Object.freeze(file)
  }
  if (
    originalBytes > request.maxOutputBytes ||
    variantBytes > MEDIA_LIMITS.variantBytes ||
    originalBytes + variantBytes > request.maxOutputBytes + MEDIA_LIMITS.variantBytes
  )
    throw task.fail('output_limit')
  Object.freeze(response.files)
  Object.freeze(response)
}

async function consume(
  socket: Socket,
  file: MediaFile,
  sink: MediaSink,
  task: Task,
): Promise<void> {
  const digest = createHash('sha256')
  let remaining = file.bytes
  let verified = false
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const aborted = () => controller?.error(task.error)
  const stream = new ReadableStream<Uint8Array>(
    {
      start(current) {
        controller = current
        task.signal.addEventListener('abort', aborted, { once: true })
        if (task.signal.aborted) aborted()
      },
      async pull(current) {
        try {
          const chunk = await read(socket, Math.min(remaining, MEDIA_LIMITS.chunkBytes), task)
          task.check()
          if (!chunk) throw task.fail('invalid_output')
          remaining -= chunk.byteLength
          digest.update(chunk)
          if (remaining === 0 && digest.digest('hex') !== file.sha256)
            throw task.fail('invalid_output')
          current.enqueue(chunk)
          if (remaining === 0) {
            verified = true
            current.close()
          }
        } catch {
          current.error(task.fail('invalid_output'))
        }
      },
      cancel() {
        task.fail('sink_failed')
      },
    },
    // No speculative pull: an unread stream must not count as a successfully consumed file.
    { highWaterMark: 0 },
  )
  try {
    await task.wait(
      Promise.resolve().then(() => sink(file, stream, task.signal)),
      'sink_failed',
    )
    if (!verified) throw task.fail('sink_failed')
  } finally {
    task.signal.removeEventListener('abort', aborted)
    if (!verified) controller?.error(task.error)
  }
}

async function receive(
  socket: Socket,
  request: MediaRequest,
  sink: MediaSink,
  task: Task,
): Promise<MediaSuccess> {
  const header = await readHeader(socket, task)
  let response: MediaResponse
  try {
    response = decodeMediaResponse(header)
  } catch {
    throw task.fail('invalid_response')
  }
  if (
    response.v !== request.v ||
    response.jobId !== request.jobId ||
    response.generation !== request.generation ||
    response.nonce !== request.nonce
  )
    throw task.fail('identity_mismatch')
  // A busy/failed peer need not read our upload or close its half of the connection. An authenticated
  // failure is terminal immediately; no output is accepted, and finally cancels upload and socket.
  if (response.status === 'failed') throw task.fail(response.code)
  validateOutput(request, response, task)
  for (const file of response.files) await consume(socket, file, sink, task)
  if ((await read(socket, 1, task)) !== null) throw task.fail('invalid_output')
  return response
}

/**
 * socketPath is trusted composition/test configuration, never a request field. The default is the
 * fixed private worker/media socket; this adapter has no TCP, HTTP, URL or filesystem-input mode.
 */
export function createMediaClient(
  socketPath = MEDIA_SOCKET_PATH,
  { timeoutMs = MEDIA_LIMITS.taskMs }: MediaClientOptions = {},
): MediaClient {
  if (
    typeof socketPath !== 'string' ||
    !socketPath.startsWith('/') ||
    socketPath.includes('\0') ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MEDIA_LIMITS.taskMs
  )
    throw new MediaClientError('invalid_request')

  return {
    async process(request, input, sink, options) {
      const task = new Task(timeoutMs, options?.signal)
      let socket: Socket | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        try {
          reader = input.getReader()
        } catch {
          throw task.fail('invalid_input')
        }
        task.check()
        let job: MediaRequest
        let header: Uint8Array
        try {
          job = mediaRequestSchema.parse(request)
          header = encodeMediaHeader(job)
        } catch {
          throw task.fail('invalid_request')
        }
        const socketOptions = {
          allowHalfOpen: true,
          readableHighWaterMark: MEDIA_LIMITS.chunkBytes,
          writableHighWaterMark: MEDIA_LIMITS.chunkBytes,
        }
        socket = new Socket(socketOptions)
        await connect(socket, socketPath, task)
        const [, response] = await Promise.all([
          send(socket, job, header, reader, task),
          receive(socket, job, sink, task),
        ])
        task.check()
        return response
      } catch (error) {
        throw task.fail(error instanceof MediaClientError ? error.code : 'transport_failed')
      } finally {
        task.dispose()
        socket?.destroy()
        if (reader) {
          // cancel() can run an arbitrary asynchronous producer hook. Request cancellation, but do
          // not await that hook: a never-settling hook cannot extend the deadline or retain the lock.
          try {
            void reader.cancel().catch(() => {})
          } catch {}
          try {
            reader.releaseLock()
          } catch {}
        }
      }
    },
  }
}
