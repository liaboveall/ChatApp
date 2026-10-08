/** Runs via docker exec in THIS run's worker. It transports bytes; it never imports a decoder. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import {
  decodeMediaResponse,
  encodeMediaHeader,
  MEDIA_LIMITS,
  type MediaOperation,
  type MediaRequest,
} from '@chatapp/contracts/media'
import { createMediaClient, MediaClientError } from '../../src/runtime/media.ts'

export type ClientInput = {
  mode?: 'process' | 'raw' | 'cancel' | 'busy' | 'blocked-sink' | 'paused-output' | 'stalled-input'
  input: string
  operation?: MediaOperation
  maxOutputBytes?: number
  timeoutMs?: number
  cancelAfterMs?: number
  request?: Record<string, unknown>
  frameLength?: number
  tail?: string
  secondJob?: boolean
  fragmented?: boolean
}

function requestFor(bytes: Uint8Array, input: ClientInput): MediaRequest {
  return {
    v: 1,
    jobId: randomUUID(),
    generation: 1,
    nonce: randomBytes(32).toString('hex'),
    operation: input.operation ?? 'image',
    inputBytes: bytes.byteLength,
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    maxOutputBytes: input.maxOutputBytes ?? 10 * 1024 * 1024,
    ...input.request,
  } as MediaRequest
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.byteLength) {
          controller.close()
          return
        }
        const chunk = bytes.subarray(offset, offset + MEDIA_LIMITS.chunkBytes)
        offset += chunk.byteLength
        controller.enqueue(chunk)
      },
    },
    { highWaterMark: 0 },
  )
}

async function processJob(input: ClientInput): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(input.input, 'base64')
  const request = requestFor(bytes, input)
  const controller = new AbortController()
  const client = createMediaClient(undefined, { timeoutMs: input.timeoutMs ?? 8000 })
  const started = performance.now()
  const before = process.memoryUsage().rss
  let maxChunkBytes = 0
  let sinkAborted = false
  const files: Array<{ variant: string; data: string }> = []
  let timer: ReturnType<typeof setTimeout> | undefined
  if (input.mode === 'cancel')
    timer = setTimeout(() => controller.abort(), input.cancelAfterMs ?? 1000)
  try {
    const result = await client.process(
      request,
      stream(bytes),
      async (file, output, signal) => {
        if (input.mode === 'blocked-sink') {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                sinkAborted = true
                resolve()
              },
              { once: true },
            )
          })
          return
        }
        const reader = output.getReader()
        const chunks: Uint8Array[] = []
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          maxChunkBytes = Math.max(maxChunkBytes, chunk.value.byteLength)
          chunks.push(chunk.value)
        }
        reader.releaseLock()
        files.push({ variant: file.variant, data: Buffer.concat(chunks).toString('base64') })
      },
      { signal: controller.signal },
    )
    return { result, files, maxChunkBytes, elapsedMs: performance.now() - started }
  } catch (error) {
    if (!(error instanceof MediaClientError)) throw new Error('unexpected_client_error')
    return {
      code: error.code,
      errorMessageFixed: error.message === error.code && error.cause === undefined,
      elapsedMs: performance.now() - started,
      rssDelta: process.memoryUsage().rss - before,
      sinkAborted,
      maxChunkBytes,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Consume only the declared header; keep the output body unread for the backpressure probe. */
function readRawBytes(socket: Socket, count: number): Promise<Buffer> {
  const bytes = Buffer.alloc(count)
  let offset = 0
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', readable)
      socket.off('end', closed)
      socket.off('close', closed)
      socket.off('error', closed)
    }
    const closed = () => {
      cleanup()
      reject(new Error('raw_header_incomplete'))
    }
    const readable = () => {
      while (offset < count) {
        const chunk: unknown = socket.read(count - offset)
        if (chunk === null) {
          if (socket.destroyed || socket.readableEnded) closed()
          return
        }
        if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > count - offset) {
          cleanup()
          reject(new Error('raw_header_invalid'))
          return
        }
        chunk.copy(bytes, offset)
        offset += chunk.length
      }
      cleanup()
      resolve(bytes)
    }
    socket.on('readable', readable)
    socket.once('end', closed)
    socket.once('close', closed)
    socket.once('error', closed)
    readable()
  })
}

async function rawJob(input: ClientInput): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(input.input, 'base64')
  const request = requestFor(bytes, input)
  const json = Buffer.from(JSON.stringify(request))
  const prefix = Buffer.alloc(4)
  prefix.writeUInt32BE(input.frameLength ?? json.length)
  const socketOptions = {
    allowHalfOpen: true,
    readableHighWaterMark: MEDIA_LIMITS.chunkBytes,
    writableHighWaterMark: MEDIA_LIMITS.chunkBytes,
  }
  const socket = new Socket(socketOptions)
  socket.on('error', () => {})
  const started = performance.now()
  let maxBufferedBytes = 0
  let responseHeaderBytes = 0
  let transportTimedOut = false
  let data = Buffer.alloc(0)
  let timer: ReturnType<typeof setTimeout> | undefined
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', () => reject(new Error('raw_connect_failed')))
    socket.connect('/run/chatapp-media/media.sock')
  })
  const completed = new Promise<void>((resolve) => {
    socket.once('close', resolve)
    socket.once('end', resolve)
    if (input.mode !== 'paused-output')
      socket.on('data', (chunk: Buffer) => {
        if (data.length + chunk.length <= MEDIA_LIMITS.headerBytes + 4)
          data = Buffer.concat([data, chunk])
      })
    timer = setTimeout(() => {
      transportTimedOut = true
      socket.destroy()
      resolve()
    }, input.timeoutMs ?? 8000)
  })
  try {
    if (input.mode === 'paused-output') {
      socket.pause()
      socket.end(Buffer.concat([prefix, json, bytes]))
      const responsePrefix = await readRawBytes(socket, 4)
      const length = responsePrefix.readUInt32BE(0)
      if (length < 1 || length > MEDIA_LIMITS.headerBytes) throw new Error('raw_header_invalid')
      data = Buffer.concat([responsePrefix, await readRawBytes(socket, length)])
      const response = decodeMediaResponse(data.subarray(4))
      if (
        response.status !== 'ok' ||
        response.jobId !== request.jobId ||
        response.generation !== request.generation ||
        response.nonce !== request.nonce ||
        response.files.find((file) => file.variant === 'original')?.bytes !== 4 * 1024 * 1024
      )
        throw new Error('raw_probe_response_invalid')
      responseHeaderBytes = data.length
      // Only body bytes remain. Protocol metadata is separately validated and bounded to 8 KiB + 4.
      maxBufferedBytes = socket.readableLength
      const sample = setInterval(() => {
        maxBufferedBytes = Math.max(maxBufferedBytes, socket.readableLength)
      }, 20)
      await Bun.sleep(8000)
      clearInterval(sample)
      socket.destroy()
    } else if (input.mode === 'stalled-input') {
      socket.write(Buffer.concat([prefix, json, bytes.subarray(0, Math.max(1, bytes.length - 1))]))
    } else {
      const second = input.secondJob
        ? Buffer.concat([
            encodeMediaHeader(
              requestFor(bytes, { input: input.input, operation: input.operation }),
            ),
            bytes,
          ])
        : Buffer.alloc(0)
      const frame = Buffer.concat([
        prefix,
        json,
        bytes,
        Buffer.from(input.tail ?? '', 'base64'),
        second,
      ])
      if (input.fragmented) {
        for (const byte of frame) {
          if (socket.destroyed) break
          await new Promise<void>((resolve) => socket.write(Buffer.from([byte]), () => resolve()))
        }
        socket.end()
      } else socket.end(frame)
    }
    await completed
    let reply: unknown = null
    if (data.length >= 4) {
      const length = data.readUInt32BE(0)
      if (length <= MEDIA_LIMITS.headerBytes && data.length >= length + 4)
        reply = decodeMediaResponse(data.subarray(4, length + 4))
    }
    return {
      reply,
      responseBytes: data.length,
      elapsedMs: performance.now() - started,
      maxBufferedBytes,
      responseHeaderBytes,
      transportTimedOut,
    }
  } finally {
    clearTimeout(timer)
    socket.destroy()
  }
}

async function busy(input: ClientInput): Promise<Record<string, unknown>> {
  const client = createMediaClient(undefined, { timeoutMs: 8000 })
  const bytes = Buffer.from(input.input, 'base64')
  const controller = new AbortController()
  const drain = async (_file: unknown, output: ReadableStream<Uint8Array>) => {
    const reader = output.getReader()
    while (!(await reader.read()).done) {}
  }
  const first = client
    .process(requestFor(bytes, input), stream(bytes), drain, { signal: controller.signal })
    .then(
      () => 'unexpected_success',
      (error: unknown) => (error instanceof MediaClientError ? error.code : 'unexpected_error'),
    )
  await Bun.sleep(500)
  const next = Buffer.from('M3_PROBE:noop')
  const started = performance.now()
  let second = 'unexpected_success'
  try {
    await client.process(requestFor(next, input), stream(next), drain)
  } catch (error) {
    second = error instanceof MediaClientError ? error.code : 'unexpected_error'
  }
  controller.abort()
  return { first: await first, second, secondElapsedMs: performance.now() - started }
}

export async function runContainerClient(): Promise<void> {
  const input = JSON.parse(await Bun.stdin.text()) as ClientInput
  if (typeof input.input !== 'string' || input.input.length > 140 * 1024 * 1024)
    throw new Error('invalid_test_input')
  const result =
    input.mode === 'busy'
      ? await busy(input)
      : ['raw', 'paused-output', 'stalled-input'].includes(input.mode ?? '')
        ? await rawJob(input)
        : await processJob(input)
  console.info(JSON.stringify(result))
}
