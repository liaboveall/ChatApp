import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bindProductionRelease,
  exportRecoveryMaterials,
  prepareProduction,
  prepareRecovery,
  readRawEnvironment,
  renderProductionEdge,
} from './production.ts'

const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('private production preparation', () => {
  test('release binding requires every offline dependency and recovery rejects a changed source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatapp-binding-'))
    directories.push(root)
    const directory = join(root, 'configuration'),
      file = join(root, 'release.json')
    await prepareProduction(directory, 'https://chat.example.invalid')
    const release = {
      format: 1,
      APPLICATION_SHA: 'a'.repeat(40),
      APPLICATION_SOURCE_HASH: 'b'.repeat(64),
      dirty: true,
      baselineShaOnly: true,
      architecture: 'x64',
      images: {
        server: `sha256:${'a'.repeat(64)}`,
        media: `sha256:${'c'.repeat(64)}`,
        ops: `sha256:${'d'.repeat(64)}`,
      },
      artifacts: [],
      sourceFiles: [],
    }
    await writeFile(file, JSON.stringify(release), { mode: 0o600 })
    await expect(bindProductionRelease(directory, file)).rejects.toThrow('complete native runtime')
    Object.assign(release.images, {
      postgres: `sha256:${'e'.repeat(64)}`,
      valkey: `sha256:${'f'.repeat(64)}`,
      garage: `sha256:${'0'.repeat(64)}`,
    })
    await writeFile(file, JSON.stringify(release))
    await bindProductionRelease(directory, file)
    const created = readRawEnvironment(await readFile(join(directory, 'compose.env'), 'utf8'))
    expect(created.CHATAPP_DATA_SOURCE_HASH).toBe('b'.repeat(64))
    const upgraded = { ...release, APPLICATION_SOURCE_HASH: 'c'.repeat(64) }
    await writeFile(file, JSON.stringify(upgraded))
    await bindProductionRelease(directory, file)
    const updated = readRawEnvironment(await readFile(join(directory, 'compose.env'), 'utf8'))
    expect(updated.APPLICATION_SOURCE_HASH).toBe('c'.repeat(64))
    expect(updated.CHATAPP_DATA_SOURCE_HASH).toBe(created.CHATAPP_DATA_SOURCE_HASH)
    await writeFile(file, JSON.stringify(release))
    await bindProductionRelease(directory, file)
    const material = join(root, 'materials'),
      restored = join(root, 'restored')
    await exportRecoveryMaterials(directory, material)
    await prepareRecovery(restored, material, 'https://new.example.invalid')
    await expect(bindProductionRelease(restored, file, true)).resolves.toMatchObject({
      status: 'native_release_bound',
    })
    release.APPLICATION_SOURCE_HASH = 'c'.repeat(64)
    await writeFile(file, JSON.stringify(release))
    const before = await readFile(join(restored, 'compose.env'), 'utf8')
    await expect(bindProductionRelease(restored, file, true)).rejects.toThrow('original source')
    expect(await readFile(join(restored, 'compose.env'), 'utf8')).toBe(before)
  })
  test('recovery uses original decryptors and offsite namespace while every local connection and writer remains new', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatapp-recovery-'))
    directories.push(root)
    const source = join(root, 'source'),
      destination = join(root, 'destination')
    await prepareProduction(source, 'https://old.example.invalid')
    const composePath = join(source, 'compose.env')
    const composed = readRawEnvironment(await readFile(composePath, 'utf8'))
    Object.assign(composed, {
      APPLICATION_SOURCE_HASH: 'a'.repeat(64),
      SERVER_IMAGE: `sha256:${'b'.repeat(64)}`,
      MEDIA_IMAGE: `sha256:${'c'.repeat(64)}`,
      OPS_IMAGE: `sha256:${'d'.repeat(64)}`,
    })
    await writeFile(
      composePath,
      Object.entries(composed)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
    )
    const old = readRawEnvironment(await readFile(join(source, 'app.env'), 'utf8'))
    const oldText = await readFile(join(source, 'app.env'), 'utf8')
    await prepareRecovery(destination, source, 'https://new.example.invalid')
    const restored = readRawEnvironment(await readFile(join(destination, 'app.env'), 'utf8'))
    const identities = readRawEnvironment(await readFile(join(destination, 'compose.env'), 'utf8'))
    expect(restored.DATABASE_URL).not.toBe(old.DATABASE_URL)
    expect(restored.VALKEY_URL).not.toBe(old.VALKEY_URL)
    expect(restored.RESTORE_EPOCH).not.toBe(old.RESTORE_EPOCH)
    expect(restored.DELETION_JOURNAL_WRITER_EPOCH).not.toBe(old.DELETION_JOURNAL_WRITER_EPOCH)
    expect(restored.RESTORE_PREVIOUS_WRITER_EPOCH).toBe(old.DELETION_JOURNAL_WRITER_EPOCH)
    expect(restored.BETTER_AUTH_SECRET).toBe(old.BETTER_AUTH_SECRET)
    expect(restored.AI_KEY_ENCRYPTION_KEY).toBe(old.AI_KEY_ENCRYPTION_KEY)
    expect(restored.DELETION_JOURNAL_PREFIX).toBe(old.DELETION_JOURNAL_PREFIX)
    expect(identities.CHATAPP_OWNER).not.toBe(composed.CHATAPP_OWNER)
    expect(identities.APPLICATION_SOURCE_HASH).toBe(composed.APPLICATION_SOURCE_HASH)
    expect(restored.SOCLAAS_API_KEY).toBe('')
    expect(restored.S3_ACCESS_KEY_ID).toBe('')
    expect(await readFile(join(destination, 'runtime/restic-password'), 'utf8')).toBe(
      await readFile(join(source, 'runtime/restic-password'), 'utf8'),
    )
    expect(await readFile(join(destination, 'runtime/access.conf'), 'utf8')).toBe('deny all;\n')
    await expect(prepareRecovery(source, source, 'https://new.example.invalid')).rejects.toThrow()
    await expect(
      prepareRecovery(destination, source, 'https://new.example.invalid'),
    ).rejects.toThrow()
    expect(await readFile(join(source, 'app.env'), 'utf8')).toBe(oldText)
  })
  test('a repeated setup cannot silently rotate credentials, journal identity or the recovery epoch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatapp-production-'))
    directories.push(root)
    const directory = join(root, 'configuration')
    await prepareProduction(directory, 'https://chat.example.invalid')
    const original = await readFile(join(directory, 'app.env'), 'utf8')
    const keyring = await readFile(join(directory, 'runtime/journal-keyring.json'), 'utf8')
    await expect(prepareProduction(directory, 'https://other.example.invalid')).rejects.toThrow()
    expect(await readFile(join(directory, 'app.env'), 'utf8')).toBe(original)
    expect(await readFile(join(directory, 'runtime/journal-keyring.json'), 'utf8')).toBe(keyring)
    const app = readRawEnvironment(original)
    const owner = readRawEnvironment(await readFile(join(directory, 'owner.env'), 'utf8'))
    expect(Object.hasOwn(app, 'DATABASE_OWNER_URL')).toBe(false)
    expect(Object.hasOwn(app, 'BACKUP_S3_SECRET_ACCESS_KEY')).toBe(false)
    expect(new URL(app.DATABASE_URL ?? '').username).not.toBe(
      new URL(owner.DATABASE_OWNER_URL ?? '').username,
    )
    expect(
      new Set([app.BETTER_AUTH_SECRET, app.AUTH_TOKEN_ENCRYPTION_KEY, app.AI_KEY_ENCRYPTION_KEY])
        .size,
    ).toBe(3)
  })

  test('raw external credentials retain dollars, quotes and hashes; ambiguous duplicate fields are rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatapp-production-'))
    directories.push(root)
    const path = join(root, 'raw.env')
    await writeFile(path, 'SMTP_PASS=$not_expanded"#literal\n')
    expect(readRawEnvironment(await readFile(path, 'utf8')).SMTP_PASS).toBe(
      '$not_expanded"#literal',
    )
    expect(() => readRawEnvironment('SMTP_PASS=a\nSMTP_PASS=b\n')).toThrow()
  })
  test('a new gateway defaults to closed, broad or injected allowlists are refused and recovery materials cannot overwrite source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatapp-production-'))
    directories.push(root)
    const directory = join(root, 'configuration')
    await prepareProduction(directory, 'https://chat.example.invalid')
    expect(await readFile(join(directory, 'runtime/access.conf'), 'utf8')).toBe('deny all;\n')
    await expect(renderProductionEdge(directory, ['0.0.0.0/0'])).rejects.toThrow()
    await expect(renderProductionEdge(directory, ['127.0.0.1;allow all'])).rejects.toThrow()
    expect(await readFile(join(directory, 'runtime/access.conf'), 'utf8')).toBe('deny all;\n')
    await renderProductionEdge(directory, ['127.0.0.1/32', '::1/128'])
    expect(await readFile(join(directory, 'runtime/access.conf'), 'utf8')).toContain('deny all;')
    await expect(exportRecoveryMaterials(directory, join(directory, 'inside'))).rejects.toThrow()
    const bundle = join(root, 'recovery')
    await exportRecoveryMaterials(directory, bundle)
    expect(await readFile(join(bundle, 'runtime/journal-keyring.json'), 'utf8')).toBe(
      await readFile(join(directory, 'runtime/journal-keyring.json'), 'utf8'),
    )
    await expect(exportRecoveryMaterials(directory, bundle)).rejects.toThrow()
  })
})
