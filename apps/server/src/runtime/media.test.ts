import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeMediaRequest,
  encodeMediaHeader,
  MEDIA_LIMITS,
  type MediaFailureCode,
  type MediaFile,
  type MediaRequest,
  type MediaResponse,
  type MediaSuccess,
  mediaIdentity,
} from '@chatapp/contracts/media'
import {
  createMediaClient,
  MediaClientError,
  type MediaClientErrorCode,
  type MediaSink,
} from './media.ts'

// These are adapter unit tests against real local Unix sockets, NOT V-18 container/decoder evidence.
const binary = Uint8Array.of(0, 255, 128, 0, 13, 10, 254, 1)
const MiB = 1024 * 1024

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function bounded<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Test deadline exceeded')), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

interface Peer {
  path: string
  connected: Promise<Socket>
  closed: Promise<void>
}

async function withPeer<T>(
  handler: (socket: Socket) => Promise<void> | void,
  run: (peer: Peer) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'chatapp-media-adapter-'))
  const path = join(directory, 'media.sock')
  const connected = deferred<Socket>()
  const closed = deferred<void>()
  const sockets = new Set<Socket>()
  const handlers: Promise<void>[] = []
  let cleaning = false
  let peerError: unknown
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    connected.resolve(socket)
    socket.on('error', () => {})
    socket.once('close', () => {
      sockets.delete(socket)
      closed.resolve()
    })
    handlers.push(
      Promise.resolve()
        .then(() => handler(socket))
        .catch((error: unknown) => {
          if (!cleaning) peerError = error
          socket.destroy()
        }),
    )
  })
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(path, resolve)
      }),
    )
    const result = await bounded(
      run({ path, connected: connected.promise, closed: closed.promise }),
      4_000,
    )
    if (peerError !== undefined) throw peerError
    return result
  } finally {
    cleaning = true
    for (const socket of sockets) socket.destroy()
    await bounded(new Promise<void>((resolve) => server.close(() => resolve())))
    await bounded(Promise.all(handlers))
    await rm(directory, { recursive: true, force: true })
  }
}

async function readJob(socket: Socket): Promise<{ request: MediaRequest; body: Uint8Array }> {
  const chunks: Uint8Array[] = []
  const wire = await new Promise<Uint8Array>((resolve, reject) => {
    const cleanup = () => {
      socket.off('data', data)
      socket.off('end', end)
      socket.off('close', close)
      socket.off('error', close)
    }
    const data = (chunk: unknown) => {
      if (chunk instanceof Uint8Array) chunks.push(chunk)
      else {
        cleanup()
        reject(new Error('Fake peer expected binary data'))
      }
    }
    const end = () => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const close = () => {
      cleanup()
      reject(new Error('Fake peer closed before request EOF'))
    }
    socket.on('data', data)
    socket.once('end', end)
    socket.once('close', close)
    socket.once('error', close)
    socket.resume()
  })
  const length = new DataView(wire.buffer, wire.byteOffset, wire.byteLength).getUint32(0)
  const request = decodeMediaRequest(wire.subarray(4, 4 + length))
  const body = wire.subarray(4 + length)
  expect(body.byteLength).toBe(request.inputBytes)
  expect(digest(body)).toBe(request.inputSha256)
  return { request, body }
}

function job(
  input = binary,
  operation: MediaRequest['operation'] = 'video',
  maxOutputBytes = MiB,
): MediaRequest {
  return {
    v: 1,
    jobId: '019a0000-0000-7000-8000-000000000001',
    generation: 7,
    nonce: '9'.repeat(64),
    operation,
    inputBytes: input.byteLength,
    inputSha256: digest(input),
    maxOutputBytes,
  }
}

function source(chunks: readonly Uint8Array[] = [binary]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index++]
        if (chunk) controller.enqueue(chunk)
        else controller.close()
      },
    },
    { highWaterMark: 0 },
  )
}

function success(
  request: MediaRequest,
  bodies: readonly Uint8Array[] = [binary],
  kind: MediaSuccess['kind'] = 'video',
): MediaSuccess {
  const variants: MediaFile['variant'][] =
    kind === 'image' ? ['preview', 'original', 'thumb'] : ['original']
  const files = variants.map((variant, index): MediaFile => {
    const body = bodies[index]
    if (!body) throw new Error('Missing fake body')
    const mainSide = request.operation === 'avatar' ? 256 : 640
    return {
      variant,
      mime:
        kind === 'image'
          ? 'image/webp'
          : kind === 'video'
            ? 'video/mp4'
            : 'application/octet-stream',
      bytes: body.byteLength,
      sha256: digest(body),
      width: kind === 'file' ? null : variant === 'original' ? mainSide : 64,
      height: kind === 'file' ? null : variant === 'original' ? mainSide : 64,
    }
  })
  const original = files.find((file) => file.variant === 'original')
  if (!original) throw new Error('Missing fake original')
  return {
    ...mediaIdentity(request),
    status: 'ok',
    kind,
    mime: original.mime,
    width: original.width,
    height: original.height,
    durationMs: kind === 'video' ? 1_000 : null,
    metadataCleared: kind !== 'file',
    thumbhash: kind === 'image' ? 'AA==' : null,
    files,
  }
}

function rawFrame(header: unknown): Uint8Array {
  return byteFrame(new TextEncoder().encode(JSON.stringify(header)))
}

function byteFrame(header: Uint8Array, length = header.byteLength): Uint8Array {
  const frame = new Uint8Array(4 + header.byteLength)
  new DataView(frame.buffer).setUint32(0, length)
  frame.set(header, 4)
  return frame
}

function reply(socket: Socket, response: MediaResponse, bodies: readonly Uint8Array[] = []): void {
  socket.end(Buffer.concat([encodeMediaHeader(response), ...bodies]))
}

async function writeFragmented(socket: Socket, bytes: Uint8Array): Promise<void> {
  const sizes = [1, 2, 7, 3, 31]
  let offset = 0
  let index = 0
  while (offset < bytes.byteLength) {
    const size = sizes[index++ % sizes.length] ?? 1
    await new Promise<void>((resolve, reject) => {
      socket.write(bytes.subarray(offset, offset + size), (error) => {
        if (error) reject(new Error('Fake peer write failed'))
        else resolve()
      })
    })
    offset += size
  }
}

const drain: MediaSink = async (_file, stream) => {
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock()
  }
}

async function expectFailure(
  pending: Promise<unknown>,
  code: MediaClientErrorCode,
): Promise<MediaClientError> {
  const result: unknown = await bounded(
    pending.then(
      () => undefined,
      (error: unknown) => error,
    ),
  )
  expect(result).toBeInstanceOf(MediaClientError)
  if (!(result instanceof MediaClientError)) throw new Error('Expected fixed media error')
  expect(result.code).toBe(code)
  expect(result.message).toBe(code)
  expect(result.cause).toBeUndefined()
  expect(Object.keys(result).sort()).toEqual(['code', 'name'])
  return result
}

function client(peer: Peer, timeoutMs = 2_000) {
  return createMediaClient(peer.path, { timeoutMs })
}

describe('MediaClient (unit adapter, real Unix fake peer)', () => {
  test('streams fragmented binary framing, exact request EOF and variants in wire array order', async () => {
    const request = job(binary, 'image', binary.byteLength)
    const bodies = [Uint8Array.of(255, 0, 254), binary, Uint8Array.of(128, 0)]
    const response = success(request, bodies, 'image')
    const input = source([binary.subarray(0, 1), binary.subarray(1, 5), binary.subarray(5)])
    const staged: { file: MediaFile; bytes: Uint8Array }[] = []
    await withPeer(
      async (socket) => {
        const received = await readJob(socket)
        expect(received.request).toEqual(request)
        expect(received.body).toEqual(binary)
        await writeFragmented(socket, Buffer.concat([encodeMediaHeader(response), ...bodies]))
        socket.end()
      },
      async (peer) => {
        const result = await client(peer).process(request, input, async (file, stream, signal) => {
          expect(signal.aborted).toBe(false)
          expect(Object.isFrozen(file)).toBe(true)
          const chunks: Uint8Array[] = []
          const reader = stream.getReader()
          try {
            for (;;) {
              const next = await reader.read()
              if (next.done) break
              chunks.push(next.value)
            }
          } finally {
            reader.releaseLock()
          }
          staged.push({ file, bytes: Buffer.concat(chunks) })
        })
        expect(result).toEqual(response)
        expect(Object.isFrozen(result)).toBe(true)
        expect(staged.map(({ file }) => file.variant)).toEqual(['preview', 'original', 'thumb'])
        expect(staged.map((entry) => entry.bytes)).toEqual(bodies)
        expect(input.locked).toBe(false)
        await bounded(peer.closed)
      },
    )
  })

  for (const [operation, kind] of [
    ['video', 'video'],
    ['video', 'file'],
    ['avatar', 'image'],
  ] as const) {
    test(`accepts ${operation}/${kind} (including download-only video fallback)`, async () => {
      const request = job(binary, operation)
      const bodies = kind === 'image' ? [binary, binary, binary] : [binary]
      await withPeer(
        async (socket) => {
          await readJob(socket)
          reply(socket, success(request, bodies, kind), bodies)
        },
        async (peer) => {
          const result = await client(peer).process(request, source(), drain)
          expect(result.kind).toBe(kind)
          if (operation === 'avatar') expect([result.width, result.height]).toEqual([256, 256])
          if (kind === 'file') expect(result.metadataCleared).toBe(false)
        },
      )
    })
  }

  test('accepts a header at the exact 8 KiB limit', async () => {
    const request = job()
    const response = success(request)
    const json = JSON.stringify(response)
    const header = new TextEncoder().encode(json.padEnd(MEDIA_LIMITS.headerBytes, ' '))
    await withPeer(
      async (socket) => {
        await readJob(socket)
        socket.end(Buffer.concat([byteFrame(header), binary]))
      },
      async (peer) => {
        expect((await client(peer).process(request, source(), drain)).status).toBe('ok')
      },
    )
  })

  for (const length of [0, MEDIA_LIMITS.headerBytes + 1, 0xffffffff]) {
    test(`rejects response prefix ${length} before waiting for or decoding its body`, async () => {
      await withPeer(
        (socket) => {
          socket.resume()
          socket.once('end', () => socket.destroy())
          socket.write(byteFrame(new Uint8Array(), length))
        },
        async (peer) => {
          await expectFailure(client(peer).process(job(), source(), drain), 'invalid_response')
          await bounded(peer.closed)
        },
      )
    })
  }

  for (const [name, header] of [
    ['malformed JSON', new TextEncoder().encode('{"raw":"input-marker"')],
    ['invalid UTF-8', Uint8Array.of(255)],
  ] as const) {
    test(`rejects ${name} without retaining raw decoder data`, async () => {
      await withPeer(
        async (socket) => {
          await readJob(socket)
          socket.end(byteFrame(header))
        },
        async (peer) => {
          const error = await expectFailure(
            client(peer).process(job(), source(), drain),
            'invalid_response',
          )
          expect(error.stack).not.toContain('input-marker')
        },
      )
    })
  }

  for (const name of [
    'missing status',
    'path',
    'url',
    'unknown variant',
    'duplicate variant',
    'missing original',
  ]) {
    test(`rejects strict response schema: ${name}`, async () => {
      const request = job(binary, 'image')
      const response = success(request, [binary, binary, binary], 'image')
      const original = response.files.find((file) => file.variant === 'original')
      if (!original) throw new Error('Missing test original')
      const header: unknown =
        name === 'missing status'
          ? mediaIdentity(request)
          : name === 'path'
            ? { ...response, path: '/host/private/input-marker' }
            : name === 'url'
              ? { ...response, url: 'http://private.invalid/input-marker' }
              : name === 'unknown variant'
                ? {
                    ...response,
                    files: response.files.map((file) => ({ ...file, variant: 'path' })),
                  }
                : name === 'duplicate variant'
                  ? { ...response, files: [original, original, original] }
                  : {
                      ...response,
                      files: response.files.filter((file) => file.variant !== 'original'),
                    }
      await withPeer(
        async (socket) => {
          await readJob(socket)
          socket.end(rawFrame(header))
        },
        async (peer) => {
          await expectFailure(client(peer).process(request, source(), drain), 'invalid_response')
        },
      )
    })
  }

  for (const [field, value, code] of [
    ['v', 2, 'invalid_response'],
    ['jobId', '019a0000-0000-7000-8000-000000000002', 'identity_mismatch'],
    ['generation', 8, 'identity_mismatch'],
    ['nonce', 'a'.repeat(64), 'identity_mismatch'],
  ] as const) {
    test(`rejects mismatched identity ${field} before invoking the sink`, async () => {
      const request = job()
      let called = false
      await withPeer(
        async (socket) => {
          await readJob(socket)
          socket.end(rawFrame({ ...success(request), [field]: value }))
        },
        async (peer) => {
          await expectFailure(
            client(peer).process(request, source(), async () => {
              called = true
            }),
            code,
          )
          expect(called).toBe(false)
        },
      )
    })
  }

  for (const [operation, kind] of [
    ['image', 'file'],
    ['image', 'video'],
    ['avatar', 'video'],
    ['video', 'image'],
  ] as const) {
    test(`rejects operation/kind mismatch ${operation}/${kind}`, async () => {
      const request = job(binary, operation)
      const bodies = kind === 'image' ? [binary, binary, binary] : [binary]
      await withPeer(
        async (socket) => {
          await readJob(socket)
          reply(socket, success(request, bodies, kind))
        },
        async (peer) => {
          await expectFailure(client(peer).process(request, source(), drain), 'invalid_response')
        },
      )
    })
  }

  test('rejects avatars not cropped to 256x256', async () => {
    const request = job(binary, 'avatar')
    const response = success(request, [binary, binary, binary], 'image')
    response.width = 128
    for (const file of response.files) if (file.variant === 'original') file.width = 128
    await withPeer(
      async (socket) => {
        await readJob(socket)
        reply(socket, response)
      },
      async (peer) => {
        await expectFailure(client(peer).process(request, source(), drain), 'invalid_response')
      },
    )
  })

  test('rejects the requested main-output cap before calling any sink', async () => {
    const request = job(binary, 'video', binary.byteLength - 1)
    let called = false
    await withPeer(
      async (socket) => {
        await readJob(socket)
        reply(socket, success(request))
      },
      async (peer) => {
        await expectFailure(
          client(peer).process(request, source(), async () => {
            called = true
          }),
          'output_limit',
        )
        expect(called).toBe(false)
      },
    )
  })

  for (const name of [
    'variant aggregate',
    'image main hard limit',
    'video main hard limit',
    'static pixels',
  ]) {
    test(`rejects output metadata over ${name}`, async () => {
      const request = job(binary, name === 'video main hard limit' ? 'video' : 'image')
      const response = success(
        request,
        [binary, binary, binary],
        request.operation === 'video' ? 'video' : 'image',
      )
      for (const file of response.files) {
        if (name === 'variant aggregate' && file.variant !== 'original')
          file.bytes = MEDIA_LIMITS.variantBytes
        if (name === 'image main hard limit' && file.variant === 'original')
          file.bytes = MEDIA_LIMITS.imageBytes + 1
        if (name === 'video main hard limit') file.bytes = MEDIA_LIMITS.inputBytes + 1
        if (name === 'static pixels' && file.variant === 'original') {
          file.width = 10_000
          file.height = 10_000
          response.width = file.width
          response.height = file.height
        }
      }
      await withPeer(
        async (socket) => {
          await readJob(socket)
          socket.end(rawFrame(response))
        },
        async (peer) => {
          await expectFailure(client(peer).process(request, source(), drain), 'invalid_response')
        },
      )
    })
  }

  for (const name of ['short body', 'wrong hash', 'trailing byte', 'second frame']) {
    test(`rejects actual output ${name}, even after writing staging`, async () => {
      const request = job()
      let stagedBytes = 0
      const sink: MediaSink = async (_file, stream) => {
        const reader = stream.getReader()
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            stagedBytes += next.value.byteLength
          }
        } finally {
          reader.releaseLock()
        }
      }
      const body =
        name === 'short body'
          ? binary.subarray(0, binary.byteLength - 1)
          : name === 'wrong hash'
            ? new Uint8Array(binary.byteLength).fill(42)
            : binary
      await withPeer(
        async (socket) => {
          await readJob(socket)
          const suffix =
            name === 'trailing byte'
              ? Uint8Array.of(42)
              : name === 'second frame'
                ? encodeMediaHeader(success(request))
                : new Uint8Array()
          socket.end(Buffer.concat([encodeMediaHeader(success(request)), body, suffix]))
        },
        async (peer) => {
          await expectFailure(client(peer).process(request, source(), sink), 'invalid_output')
          if (name === 'trailing byte' || name === 'second frame')
            expect(stagedBytes).toBe(binary.byteLength)
        },
      )
    })
  }

  test('independently verifies each variant hash, not just the original or aggregate', async () => {
    const request = job(binary, 'image')
    const bodies = [binary, binary, binary]
    const response = success(request, bodies, 'image')
    let files = 0
    await withPeer(
      async (socket) => {
        await readJob(socket)
        socket.end(
          Buffer.concat([
            encodeMediaHeader(response),
            binary,
            binary,
            new Uint8Array(binary.byteLength),
          ]),
        )
      },
      async (peer) => {
        await expectFailure(
          client(peer).process(request, source(), async (file, stream, signal) => {
            await drain(file, stream, signal)
            files++
          }),
          'invalid_output',
        )
        expect(files).toBe(2)
      },
    )
  })

  for (const wire of [Uint8Array.of(0, 0), byteFrame(new TextEncoder().encode('{'), 20)]) {
    test(`rejects short response header (${wire.byteLength} wire bytes)`, async () => {
      await withPeer(
        async (socket) => {
          await readJob(socket)
          socket.end(wire)
        },
        async (peer) => {
          await expectFailure(client(peer).process(job(), source(), drain), 'invalid_response')
        },
      )
    })
  }

  for (const name of ['short', 'long', 'hash', 'producer error', 'non-binary']) {
    test(`rejects input ${name}, releases its reader and closes the socket`, async () => {
      const request = job()
      let input: ReadableStream<Uint8Array>
      if (name === 'producer error') {
        input = new ReadableStream(
          {
            pull() {
              throw new Error('private-input-marker')
            },
          },
          { highWaterMark: 0 },
        )
      } else if (name === 'non-binary') {
        // Deliberately cross the runtime boundary with an invalid chunk; no production type escape.
        input = new ReadableStream(
          {
            pull(controller) {
              controller.enqueue('private-input-marker')
            },
          },
          { highWaterMark: 0 },
        ) as unknown as ReadableStream<Uint8Array>
      } else {
        input = source([
          name === 'short'
            ? binary.subarray(1)
            : name === 'long'
              ? Buffer.concat([binary, binary])
              : binary,
        ])
        if (name === 'hash') request.inputSha256 = 'a'.repeat(64)
      }
      await withPeer(
        (socket) => {
          socket.resume()
          socket.once('end', () => socket.destroy())
        },
        async (peer) => {
          const error = await expectFailure(
            client(peer).process(request, input, drain),
            'invalid_input',
          )
          expect(error.stack).not.toContain('private-input-marker')
          expect(input.locked).toBe(false)
          await bounded(peer.closed)
        },
      )
    })
  }

  test('a complete valid reply cannot bypass a pending input EOF or bad input hash', async () => {
    const request = { ...job(), inputSha256: 'a'.repeat(64) }
    const eof = deferred<void>()
    const staged = deferred<void>()
    let delivered = false
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (!delivered) {
            delivered = true
            controller.enqueue(binary)
          } else {
            return eof.promise.then(() => controller.close())
          }
        },
      },
      { highWaterMark: 0 },
    )
    await withPeer(
      (socket) => {
        socket.resume()
        reply(socket, success(request), [binary])
      },
      async (peer) => {
        const failed = expectFailure(
          client(peer).process(request, input, async (file, stream, signal) => {
            await drain(file, stream, signal)
            staged.resolve()
          }),
          'invalid_input',
        )
        try {
          await bounded(staged.promise)
        } finally {
          eof.resolve()
        }
        await failed
        expect(input.locked).toBe(false)
        await bounded(peer.closed)
      },
    )
  })

  for (const patch of [
    { path: '/host/private/input' },
    { url: 'http://private.invalid/input' },
    { operation: 'shell' },
    { nonce: 'short' },
    { inputBytes: MEDIA_LIMITS.inputBytes + 1 },
    { operation: 'image', inputBytes: MEDIA_LIMITS.imageBytes + 1 },
    { operation: 'avatar', maxOutputBytes: MEDIA_LIMITS.imageBytes + 1 },
  ]) {
    test(`rejects request schema before connecting: ${JSON.stringify(patch)}`, async () => {
      const input = source()
      // Invalid external input is intentionally cast only in this boundary test.
      const request = { ...job(), ...patch } as unknown as MediaRequest
      await withPeer(
        () => {
          throw new Error('Invalid request must not connect')
        },
        async (peer) => {
          await expectFailure(client(peer).process(request, input, drain), 'invalid_request')
          expect(input.locked).toBe(false)
        },
      )
    })
  }

  test('propagates real slow-peer input backpressure instead of reading the whole input', async () => {
    const chunk = new Uint8Array(MEDIA_LIMITS.chunkBytes).fill(23)
    const total = 8 * MiB
    const count = total / chunk.byteLength
    const hash = createHash('sha256')
    for (let i = 0; i < count; i++) hash.update(chunk)
    const request = { ...job(), inputBytes: total, inputSha256: hash.digest('hex') }
    let produced = 0
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced < count) {
            produced++
            controller.enqueue(chunk)
          } else controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    const resume = deferred<void>()
    await withPeer(
      async (socket) => {
        socket.pause()
        await resume.promise
        await readJob(socket)
        reply(socket, success(request), [binary])
      },
      async (peer) => {
        const pending = client(peer).process(request, input, drain)
        try {
          await bounded(peer.connected)
          await sleep(50)
          expect(produced).toBeGreaterThan(0)
          expect(produced).toBeLessThan(count / 2)
        } finally {
          resume.resolve()
        }
        expect((await pending).status).toBe('ok')
        expect(produced).toBe(count)
        expect(input.locked).toBe(false)
      },
    )
  })

  test('does not prebuffer a whole output while a staging consumer is slow', async () => {
    const body = new Uint8Array(8 * MiB).fill(17)
    const request = job(binary, 'video', body.byteLength)
    const response = success(request, [body])
    const consuming = deferred<void>()
    const resume = deferred<void>()
    let written = 0
    await withPeer(
      async (socket) => {
        await readJob(socket)
        socket.write(encodeMediaHeader(response))
        for (let offset = 0; offset < body.byteLength; offset += MEDIA_LIMITS.chunkBytes) {
          await new Promise<void>((resolve, reject) => {
            socket.write(body.subarray(offset, offset + MEDIA_LIMITS.chunkBytes), (error) => {
              if (error) reject(new Error('Fake peer write failed'))
              else resolve()
            })
          })
          written += MEDIA_LIMITS.chunkBytes
        }
        socket.end()
      },
      async (peer) => {
        const pending = client(peer).process(request, source(), async (_file, stream) => {
          const reader = stream.getReader()
          try {
            const first = await reader.read()
            expect(first.value?.byteLength).toBeGreaterThan(0)
            expect(first.value?.byteLength).toBeLessThanOrEqual(MEDIA_LIMITS.chunkBytes)
            consuming.resolve()
            await resume.promise
            while (!(await reader.read()).done) {}
          } finally {
            reader.releaseLock()
          }
        })
        try {
          await bounded(consuming.promise)
          await sleep(50)
          expect(written).toBeLessThan(body.byteLength / 2)
        } finally {
          resume.resolve()
        }
        expect((await pending).status).toBe('ok')
      },
    )
  })

  for (const mode of ['throws', 'unread', 'partial', 'cancel'] as const) {
    test(`rejects a sink that ${mode}, with bounded socket cleanup`, async () => {
      const body = new Uint8Array(MEDIA_LIMITS.chunkBytes * 2).fill(42)
      const request = job()
      const response = success(request, [body])
      const input = source()
      await withPeer(
        async (socket) => {
          await readJob(socket)
          reply(socket, response, [body])
        },
        async (peer) => {
          const error = await expectFailure(
            client(peer).process(request, input, async (_file, stream) => {
              if (mode === 'throws') throw new Error('private-sink-marker')
              if (mode === 'unread') return
              const reader = stream.getReader()
              try {
                await reader.read()
                if (mode === 'cancel') await reader.cancel('private-cancel-marker')
              } finally {
                reader.releaseLock()
              }
            }),
            'sink_failed',
          )
          expect(error.stack).not.toContain('private-sink-marker')
          expect(error.stack).not.toContain('private-cancel-marker')
          expect(input.locked).toBe(false)
          await bounded(peer.closed)
        },
      )
    })
  }

  for (const phase of [
    'header',
    'body',
    'EOF',
    'consumer',
    'input EOF',
    'empty producer',
  ] as const) {
    test(`whole-call deadline bounds a stalled ${phase}`, async () => {
      const request = job()
      let input = source()
      if (phase === 'input EOF') {
        let delivered = false
        input = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (!delivered) {
                delivered = true
                controller.enqueue(binary)
              } else return new Promise<void>(() => {})
            },
            cancel() {
              return new Promise<void>(() => {})
            },
          },
          { highWaterMark: 0 },
        )
      }
      if (phase === 'empty producer')
        input = new ReadableStream(
          {
            pull(controller) {
              controller.enqueue(new Uint8Array())
            },
          },
          { highWaterMark: 0 },
        )
      await withPeer(
        (socket) => {
          socket.resume()
          socket.once('end', () => {
            if (phase === 'input EOF' || phase === 'empty producer') socket.destroy()
          })
          if (phase !== 'header') socket.write(encodeMediaHeader(success(request)))
          if (
            phase === 'EOF' ||
            phase === 'consumer' ||
            phase === 'input EOF' ||
            phase === 'empty producer'
          )
            socket.write(binary)
          if (phase === 'consumer' || phase === 'input EOF' || phase === 'empty producer')
            socket.end()
        },
        async (peer) => {
          const sink: MediaSink =
            phase === 'consumer' ? async () => new Promise<void>(() => {}) : drain
          await expectFailure(client(peer, 80).process(request, input, sink), 'timeout')
          expect(input.locked).toBe(false)
        },
      )
    })
  }

  test('aborts before connecting, ignores raw AbortSignal.reason and releases input', async () => {
    const abort = new AbortController()
    abort.abort(new Error('private-abort-marker'))
    let cancelled = false
    const input = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    await withPeer(
      () => {
        throw new Error('Aborted request must not connect')
      },
      async (peer) => {
        const error = await expectFailure(
          client(peer).process(job(), input, drain, { signal: abort.signal }),
          'aborted',
        )
        expect(error.stack).not.toContain('private-abort-marker')
        expect(cancelled).toBe(true)
        expect(input.locked).toBe(false)
      },
    )
  })

  test('aborts an initiated Unix connection before its connect callback', async () => {
    const abort = new AbortController()
    let cancelled = false
    const input = new ReadableStream<Uint8Array>(
      {
        cancel() {
          cancelled = true
          return new Promise<void>(() => {})
        },
      },
      { highWaterMark: 0 },
    )
    await withPeer(
      (socket) => {
        socket.resume()
        socket.once('end', () => socket.destroy())
      },
      async (peer) => {
        const pending = client(peer).process(job(), input, drain, { signal: abort.signal })
        const failed = expectFailure(pending, 'aborted')
        abort.abort()
        await failed
        expect(cancelled).toBe(true)
        expect(input.locked).toBe(false)
      },
    )
  })

  for (const phase of ['input read', 'input write', 'response read', 'consumer'] as const) {
    test(`aborts during ${phase} without waiting for user cancellation hooks`, async () => {
      const abort = new AbortController()
      const active = deferred<void>()
      const request = job()
      let cancelled = false
      let produced = 0
      let input = source()
      if (phase === 'input read')
        input = new ReadableStream<Uint8Array>(
          {
            pull() {
              active.resolve()
              return new Promise<void>(() => {})
            },
            cancel() {
              cancelled = true
              return new Promise<void>(() => {})
            },
          },
          { highWaterMark: 0 },
        )
      if (phase === 'input write') {
        const chunk = new Uint8Array(MEDIA_LIMITS.chunkBytes).fill(12)
        const hash = createHash('sha256')
        for (let i = 0; i < 128; i++) hash.update(chunk)
        request.inputBytes = 128 * chunk.byteLength
        request.inputSha256 = hash.digest('hex')
        input = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              produced++
              controller.enqueue(chunk)
            },
            cancel() {
              cancelled = true
              return new Promise<void>(() => {})
            },
          },
          { highWaterMark: 0 },
        )
      }
      await withPeer(
        async (socket) => {
          if (phase === 'input write') {
            socket.pause()
            active.resolve()
            return
          }
          socket.resume()
          socket.once('end', () => {
            if (abort.signal.aborted) socket.destroy()
          })
          if (phase === 'response read') active.resolve()
          if (phase === 'consumer') {
            socket.write(encodeMediaHeader(success(request)))
          }
        },
        async (peer) => {
          let consumerSignal: AbortSignal | undefined
          const sink: MediaSink =
            phase === 'consumer'
              ? async (_file, stream, signal) => {
                  consumerSignal = signal
                  active.resolve()
                  const reader = stream.getReader()
                  try {
                    await reader.read()
                  } finally {
                    reader.releaseLock()
                  }
                }
              : drain
          const pending = client(peer).process(request, input, sink, { signal: abort.signal })
          const failed = expectFailure(pending, 'aborted')
          await bounded(active.promise)
          if (phase === 'input write') {
            await sleep(50)
            expect(produced).toBeLessThan(128)
          }
          abort.abort(new Error('private-abort-marker'))
          await failed
          expect(input.locked).toBe(false)
          if (phase === 'input read' || phase === 'input write') expect(cancelled).toBe(true)
          if (phase === 'consumer') expect(consumerSignal?.aborted).toBe(true)
          const socket = await peer.connected
          socket.resume()
          if (socket.readableEnded) socket.destroy()
          else socket.once('end', () => socket.destroy())
          await bounded(peer.closed)
        },
      )
    })
  }

  test('real Unix connect failure is a fixed code and releases input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'chatapp-media-missing-'))
    const input = source()
    try {
      const error = await expectFailure(
        createMediaClient(join(directory, 'missing.sock')).process(job(), input, drain),
        'connect_failed',
      )
      expect(error.stack).not.toContain(directory)
      expect(input.locked).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('an already locked input reader fails without retaining its raw TypeError', async () => {
    const input = source()
    const reader = input.getReader()
    try {
      await expectFailure(createMediaClient().process(job(), input, drain), 'invalid_input')
    } finally {
      reader.releaseLock()
    }
  })

  test('busy cancels a blocked upload write and closes without waiting for the peer to drain', async () => {
    const chunk = new Uint8Array(MEDIA_LIMITS.chunkBytes).fill(29)
    const count = 128
    const hash = createHash('sha256')
    for (let i = 0; i < count; i++) hash.update(chunk)
    const request = {
      ...job(),
      inputBytes: count * chunk.byteLength,
      inputSha256: hash.digest('hex'),
    }
    let produced = 0
    let cancelled = false
    const input = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          produced++
          controller.enqueue(chunk)
        },
        cancel() {
          cancelled = true
          return new Promise<void>(() => {})
        },
      },
      { highWaterMark: 0 },
    )
    await withPeer(
      (socket) => {
        socket.pause()
      },
      async (peer) => {
        const failed = expectFailure(client(peer).process(request, input, drain), 'busy')
        const socket = await bounded(peer.connected)
        await sleep(50)
        expect(produced).toBeGreaterThan(0)
        expect(produced).toBeLessThan(count)
        socket.write(
          encodeMediaHeader({ ...mediaIdentity(request), status: 'failed', code: 'busy' }),
        )
        await failed
        expect(cancelled).toBe(true)
        expect(produced).toBeLessThan(count)
        expect(input.locked).toBe(false)
        socket.once('end', () => socket.destroy())
        socket.resume()
        await bounded(peer.closed)
      },
    )
  })

  const codes: readonly MediaFailureCode[] = [
    'invalid_request',
    'invalid_input',
    'input_limit',
    'output_limit',
    'unsupported',
    'timeout',
    'processor_failed',
    'busy',
  ]
  for (const code of codes) {
    test(`remote ${code} is fixed and closes a busy connection without waiting for upload/peer EOF`, async () => {
      const request = job()
      let cancelled = false
      const input = new ReadableStream<Uint8Array>(
        {
          pull() {
            return new Promise<void>(() => {})
          },
          cancel() {
            cancelled = true
            return new Promise<void>(() => {})
          },
        },
        { highWaterMark: 0 },
      )
      await withPeer(
        (socket) => {
          socket.resume()
          socket.once('end', () => socket.destroy())
          // Deliberately do not end the response: the client must close rather than wait for EOF.
          socket.write(encodeMediaHeader({ ...mediaIdentity(request), status: 'failed', code }))
        },
        async (peer) => {
          await expectFailure(client(peer).process(request, input, drain), code)
          expect(cancelled).toBe(true)
          expect(input.locked).toBe(false)
          await bounded(peer.closed)
        },
      )
    })
  }

  test('unknown remote failure codes/messages cannot escape the strict schema', async () => {
    const request = job()
    await withPeer(
      (socket) => {
        socket.resume()
        socket.once('end', () => socket.destroy())
        socket.write(
          rawFrame({
            ...mediaIdentity(request),
            status: 'failed',
            code: 'private-decoder-marker',
            message: 'private-input-marker',
          }),
        )
      },
      async (peer) => {
        const error = await expectFailure(
          client(peer).process(request, source(), drain),
          'invalid_response',
        )
        expect(error.stack).not.toContain('private-decoder-marker')
        expect(error.stack).not.toContain('private-input-marker')
        await bounded(peer.closed)
      },
    )
  })

  test('failed responses must match identity too', async () => {
    const request = job()
    await withPeer(
      (socket) => {
        socket.resume()
        socket.once('end', () => socket.destroy())
        socket.write(
          encodeMediaHeader({
            ...mediaIdentity(request),
            nonce: 'a'.repeat(64),
            status: 'failed',
            code: 'busy',
          }),
        )
      },
      async (peer) => {
        await expectFailure(client(peer).process(request, source(), drain), 'identity_mismatch')
      },
    )
  })

  for (const path of [
    'http://localhost:1234/media',
    '127.0.0.1:1234',
    'relative.sock',
    '/tmp/invalid\0.sock',
  ]) {
    test(`rejects non-Unix/invalid trusted socket configuration ${JSON.stringify(path)}`, () => {
      expect(() => createMediaClient(path)).toThrow('invalid_request')
    })
  }
  for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, MEDIA_LIMITS.taskMs + 1]) {
    test(`cannot extend or invalidate the hard deadline: ${timeoutMs}`, () => {
      expect(() => createMediaClient(undefined, { timeoutMs })).toThrow('invalid_request')
    })
  }
})
