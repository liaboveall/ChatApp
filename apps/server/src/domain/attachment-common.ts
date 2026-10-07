import { AppError, type Attachment } from '@chatapp/contracts'
import { type attachments, type DbOrTx, siteStorage } from '@chatapp/db'
import { eq } from 'drizzle-orm'
import type { Deps } from './deps.ts'

export type AttachmentRow = typeof attachments.$inferSelect
export const attachmentMissing = () => new AppError('NOT_FOUND', 'Attachment not found')
export function blobStore(deps: Deps) {
  if (!deps.blobs) throw new AppError('CAPACITY_UNAVAILABLE', 'Storage unavailable')
  return deps.blobs
}
export async function lockStorage(tx: DbOrTx) {
  await tx.insert(siteStorage).values({ id: 1 }).onConflictDoNothing()
  const [site] = await tx.select().from(siteStorage).where(eq(siteStorage.id, 1)).for('update')
  if (!site) throw new Error('storage ledger missing')
  return site
}
export function attachmentDto(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    version: row.version,
    generation: row.generation,
    kind: row.kind,
    mime: row.mime,
    name: row.originalName,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    metadataCleared: row.metadataCleared,
    thumbhash: row.thumbhash,
    status:
      row.status === 'ready'
        ? 'ready'
        : row.status === 'failed' || row.status === 'deleting'
          ? 'failed'
          : 'processing',
    urls: {
      original: `/api/attachments/${row.id}/original`,
      thumb: row.variants.thumb ? `/api/attachments/${row.id}/thumb` : null,
      preview: row.variants.preview ? `/api/attachments/${row.id}/preview` : null,
    },
  }
}
export function safeFilename(name: string): string {
  return (
    name
      .toWellFormed()
      .normalize('NFC')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters from untrusted display filenames
      .replace(/[\u0000-\u001f\u007f/\\"\u202a-\u202e\u2066-\u2069]/g, '_')
      .slice(0, 255)
      .toWellFormed() || 'file'
  )
}
/** Header classification only: no decoder, never trust the extension or HTTP Content-Type. */
export function classifyFile(bytes: Uint8Array): { kind: AttachmentRow['kind']; mime: string } {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))
  const is = (...prefix: number[]) => prefix.every((n, i) => bytes[i] === n)
  if (is(0xff, 0xd8, 0xff)) return { kind: 'image', mime: 'image/jpeg' }
  if (is(137, 80, 78, 71, 13, 10, 26, 10)) return { kind: 'image', mime: 'image/png' }
  if (ascii(0, 6) === 'GIF89a' || ascii(0, 6) === 'GIF87a')
    return { kind: 'image', mime: 'image/gif' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    return { kind: 'image', mime: 'image/webp' }
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', mime: 'image/avif' }
    if (brand === 'M4A ') return { kind: 'audio', mime: 'audio/mp4' }
    // HEIC/HEIF remains a download, rather than being misclassified as video.
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand))
      return { kind: 'file', mime: 'application/octet-stream' }
    return { kind: 'video', mime: 'video/mp4' }
  }
  if (is(0x1a, 0x45, 0xdf, 0xa3)) return { kind: 'video', mime: 'video/webm' }
  if (ascii(0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg' }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' }
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0))
    return { kind: 'audio', mime: 'audio/mpeg' }
  return { kind: 'file', mime: 'application/octet-stream' }
}
