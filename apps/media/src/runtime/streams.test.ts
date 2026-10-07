import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { MediaError } from '../policy.ts'
import { writeBoundedFile } from './streams.ts'

async function withFile(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'chatapp-bounded-output-'))
  try {
    await run(join(directory, 'output'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('writes binary chunks exactly at the limit and closes the owned descriptor', async () => {
  await withFile(async (path) => {
    const chunks = [Buffer.from([0, 255]), Buffer.alloc(128 * 1024, 0xa5)]
    const expected = Buffer.concat(chunks)
    await writeBoundedFile(Readable.from(chunks), path, expected.length)
    expect(await readFile(path)).toEqual(expected)
  })
})

test('pipeline destruction preserves output_limit, including after a prior file write', async () => {
  for (const chunks of [[Buffer.alloc(32)], [Buffer.alloc(8), Buffer.alloc(32)]]) {
    await withFile(async (path) => {
      let failure: unknown
      try {
        await writeBoundedFile(Readable.from(chunks), path, 16)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(MediaError)
      expect((failure as MediaError).code).toBe('output_limit')
      expect((await readFile(path)).length).toBeLessThanOrEqual(16)
    })
  }
})

test('upstream failure is preserved after pending writes settle', async () => {
  await withFile(async (path) => {
    const failure = new MediaError('invalid_input')
    const source = Readable.from(
      (async function* () {
        yield Buffer.alloc(128 * 1024, 0xa5)
        throw failure
      })(),
    )
    await expect(writeBoundedFile(source, path, 256 * 1024)).rejects.toBe(failure)
  })
})

test('never overwrites an existing file or follows an output symlink', async () => {
  await withFile(async (path) => {
    await writeFile(path, 'sentinel')
    await expect(writeBoundedFile(Readable.from([Buffer.from('new')]), path, 16)).rejects.toThrow()
    const link = `${path}-link`
    await symlink(path, link)
    await expect(writeBoundedFile(Readable.from([Buffer.from('new')]), link, 16)).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('sentinel')
  })
})
