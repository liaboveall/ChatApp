import type { Socket } from 'node:net'
import { MEDIA_LIMITS } from '@chatapp/contracts/media'
import { MediaError } from '../policy.ts'

function waitReadable(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', ready)
      socket.off('end', ready)
      socket.off('close', closed)
      socket.off('error', closed)
      signal.removeEventListener('abort', aborted)
    }
    const ready = () => {
      cleanup()
      resolve()
    }
    const closed = () => {
      cleanup()
      reject(new MediaError('invalid_input'))
    }
    const aborted = () => {
      cleanup()
      reject(signal.reason)
    }
    socket.once('readable', ready)
    socket.once('end', ready)
    socket.once('close', closed)
    socket.once('error', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    else if (socket.readableEnded) ready()
    else if (socket.destroyed) closed()
  })
}

export async function readSocket(
  socket: Socket,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer | null> {
  for (;;) {
    signal.throwIfAborted()
    const count = Math.min(maximum, MEDIA_LIMITS.chunkBytes, socket.readableLength || maximum)
    const data: unknown = socket.read(count)
    if (Buffer.isBuffer(data)) {
      if (data.byteLength === 0 || data.byteLength > count) throw new MediaError('invalid_input')
      return data
    }
    if (data !== null) throw new MediaError('invalid_input')
    if (socket.readableEnded) return null
    if (socket.destroyed) throw new MediaError('invalid_input')
    await waitReadable(socket, signal)
  }
}

export async function readHeader(socket: Socket, signal: AbortSignal): Promise<Uint8Array | null> {
  const prefix = Buffer.alloc(4)
  let bytes = 0
  while (bytes < prefix.byteLength) {
    const chunk = await readSocket(socket, prefix.byteLength - bytes, signal)
    if (chunk === null) {
      if (bytes === 0) return null // Health checks connect and close without creating a task directory.
      throw new MediaError('invalid_request')
    }
    prefix.set(chunk, bytes)
    bytes += chunk.byteLength
  }
  const length = prefix.readUInt32BE(0)
  if (length < 1 || length > MEDIA_LIMITS.headerBytes) throw new MediaError('invalid_request')
  const header = Buffer.alloc(length)
  bytes = 0
  while (bytes < length) {
    const chunk = await readSocket(socket, length - bytes, signal)
    if (chunk === null) throw new MediaError('invalid_request')
    header.set(chunk, bytes)
    bytes += chunk.byteLength
  }
  return header
}

export function writeSocket(socket: Socket, data: Uint8Array, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('close', closed)
      socket.off('error', closed)
      signal.removeEventListener('abort', aborted)
    }
    const closed = () => {
      cleanup()
      reject(new MediaError('invalid_input'))
    }
    const aborted = () => {
      cleanup()
      reject(signal.reason)
    }
    socket.once('close', closed)
    socket.once('error', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {
      aborted()
      return
    }
    if (socket.destroyed) {
      closed()
      return
    }
    socket.write(data, (error) => {
      cleanup()
      if (error) reject(new MediaError('invalid_input'))
      else resolve()
    })
  })
}

export function endSocket(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('close', closed)
      socket.off('error', closed)
      signal.removeEventListener('abort', aborted)
    }
    const closed = () => {
      cleanup()
      reject(new MediaError('invalid_input'))
    }
    const aborted = () => {
      cleanup()
      reject(signal.reason)
    }
    socket.once('close', closed)
    socket.once('error', closed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {
      aborted()
      return
    }
    if (socket.destroyed) {
      closed()
      return
    }
    socket.end(() => {
      cleanup()
      resolve()
    })
  })
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    promise.then(
      (value) => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}
