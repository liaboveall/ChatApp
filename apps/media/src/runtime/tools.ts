import { type ChildProcess, spawn } from 'node:child_process'
import {
  MEDIA_PROBE_LIMITS,
  type MediaProbe,
  mediaProbeSchema,
} from '@chatapp/contracts/media-probe'
import { MediaError } from '../policy.ts'
import { mediaEnvironment } from './environment.ts'
import { writeBoundedFile } from './streams.ts'

function toolExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('error', () => resolve(null))
    child.once('close', (code) => resolve(code))
  })
}

/** No shell, ambient environment, stderr forwarding or unbounded ffprobe output. */
export async function probe(args: string[], directory: string): Promise<MediaProbe> {
  const child = spawn('/usr/bin/ffprobe', args, {
    cwd: directory,
    env: mediaEnvironment(directory),
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exit = toolExit(child)
  try {
    if (!child.stdout) throw new MediaError('processor_failed')
    const chunks: Uint8Array[] = []
    let bytes = 0
    const source: AsyncIterable<unknown> = child.stdout
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) throw new MediaError('invalid_input')
      bytes += chunk.byteLength
      if (bytes > MEDIA_PROBE_LIMITS.jsonBytes) throw new MediaError('invalid_input')
      chunks.push(chunk)
    }
    if ((await exit) !== 0 || bytes === 0) throw new MediaError('invalid_input')
    try {
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)),
      )
      return mediaProbeSchema.parse(value)
    } catch {
      throw new MediaError('invalid_input')
    }
  } finally {
    child.kill('SIGKILL')
    await exit
  }
}

export async function remux(
  args: string[],
  directory: string,
  output: string,
  limit: number,
): Promise<void> {
  const child = spawn('/usr/bin/ffmpeg', args, {
    cwd: directory,
    env: mediaEnvironment(directory),
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const exit = toolExit(child)
  try {
    if (!child.stdout) throw new MediaError('processor_failed')
    await writeBoundedFile(child.stdout, output, limit)
    if ((await exit) !== 0) throw new MediaError('processor_failed')
  } finally {
    child.kill('SIGKILL')
    await exit
  }
}
