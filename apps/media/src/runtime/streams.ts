import { constants } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { type Readable, Transform, type TransformCallback, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MEDIA_LIMITS } from '@chatapp/contracts/media'
import { MediaError } from '../policy.ts'
import { closeFile, writeFileChunk } from './files.ts'

class OutputLimit extends Transform {
  private bytes = 0

  constructor(private readonly limit: number) {
    super({ highWaterMark: MEDIA_LIMITS.chunkBytes })
  }

  override _transform(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (!(chunk instanceof Uint8Array)) {
      callback(new MediaError('processor_failed'))
      return
    }
    this.bytes += chunk.byteLength
    if (this.bytes > this.limit) {
      callback(new MediaError('output_limit'))
      return
    }
    callback(null, chunk)
  }
}

/** Own writes, but never the descriptor: Bun's destroyed fs.WriteStream may close an external fd. */
class FileWriter extends Writable {
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly handle: FileHandle) {
    super({ highWaterMark: MEDIA_LIMITS.chunkBytes })
  }

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (!(chunk instanceof Uint8Array)) {
      callback(new MediaError('processor_failed'))
      return
    }
    this.pending = writeFileChunk(this.handle, chunk)
    void this.pending.then(
      () => callback(),
      () => callback(new MediaError('processor_failed')),
    )
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // A source/limit failure can destroy the pipeline while the last write is still in flight.
    // Settle that write before pipeline resolves/rejects and the caller closes the handle.
    void this.pending.then(
      () => callback(error),
      () => callback(error ?? new MediaError('processor_failed')),
    )
  }
}

export async function writeBoundedFile(
  source: Readable,
  path: string,
  limit: number,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new MediaError('output_limit')
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await pipeline(source, new OutputLimit(limit), new FileWriter(handle))
  } finally {
    await closeFile(handle)
  }
}
