import { describe, expect, test } from 'bun:test'
import {
  decodeMediaRequest,
  decodeMediaResponse,
  encodeMediaHeader,
  MEDIA_LIMITS,
  type MediaSuccess,
  mediaFileSchema,
  mediaRequestSchema,
  mediaResponseSchema,
} from './media.ts'

const identity = {
  v: 1 as const,
  jobId: '019fbfff-3c4f-7c15-a2e3-f80fa8b19fba',
  generation: 1,
  nonce: 'a'.repeat(64),
}
const request = {
  ...identity,
  operation: 'image' as const,
  inputBytes: 32,
  inputSha256: 'b'.repeat(64),
  maxOutputBytes: MEDIA_LIMITS.imageBytes,
}
const file = {
  variant: 'original' as const,
  mime: 'image/webp' as const,
  bytes: 100,
  sha256: 'c'.repeat(64),
  width: 64,
  height: 32,
}
const result: MediaSuccess = {
  ...identity,
  status: 'ok',
  kind: 'image',
  mime: file.mime,
  width: file.width,
  height: file.height,
  durationMs: null,
  metadataCleared: true,
  thumbhash: 'YWJj',
  files: [file, { ...file, variant: 'thumb' }, { ...file, variant: 'preview' }],
}

describe('private media envelope', () => {
  test('a minimal job and its bounded image result round trip', () => {
    expect(mediaRequestSchema.parse(request)).toEqual(request)
    expect(mediaResponseSchema.parse(result)).toEqual(result)
    for (const value of [request, result]) {
      const encoded = encodeMediaHeader(value)
      const header = new DataView(encoded.buffer).getUint32(0)
      expect(header).toBe(encoded.byteLength - 4)
      expect(header).toBeLessThanOrEqual(MEDIA_LIMITS.headerBytes)
      const decoded =
        'operation' in value
          ? decodeMediaRequest(encoded.subarray(4))
          : decodeMediaResponse(encoded.subarray(4))
      expect(decoded).toEqual(value)
    }
  })

  for (const field of ['command', 'shell', 'url', 'path', 'filename', 'userId', 'key', 'options']) {
    test(`rejects unexpected ${field}, even alongside a valid job`, () => {
      expect(mediaRequestSchema.safeParse({ ...request, [field]: 'sentinel' }).success).toBe(false)
    })
  }

  for (const change of [
    { operation: 'probe' },
    { operation: 'audio' },
    { v: 2 },
    { generation: 0 },
    { generation: Number.MAX_SAFE_INTEGER + 1 },
    { jobId: 'not-a-uuid' },
    { nonce: 'a'.repeat(63) },
    { nonce: 'A'.repeat(64) },
    { inputSha256: '../input' },
    { inputBytes: 0 },
    { inputBytes: 1.5 },
    { inputBytes: MEDIA_LIMITS.imageBytes + 1 },
    { maxOutputBytes: MEDIA_LIMITS.imageBytes + 1 },
    { maxOutputBytes: 0 },
  ]) {
    test(`rejects invalid request ${JSON.stringify(change)}`, () => {
      expect(mediaRequestSchema.safeParse({ ...request, ...change }).success).toBe(false)
    })
  }

  test('video can use the 100 MiB limit, but never exceed it', () => {
    const video = {
      ...request,
      operation: 'video',
      inputBytes: MEDIA_LIMITS.inputBytes,
      maxOutputBytes: MEDIA_LIMITS.inputBytes,
    }
    expect(mediaRequestSchema.safeParse(video).success).toBe(true)
    expect(
      mediaRequestSchema.safeParse({ ...video, inputBytes: MEDIA_LIMITS.inputBytes + 1 }).success,
    ).toBe(false)
  })

  test('failure has a fixed code, not a raw exception, path or decoder message', () => {
    const failure = { ...identity, status: 'failed', code: 'processor_failed' }
    expect(mediaResponseSchema.safeParse(failure).success).toBe(true)
    expect(mediaResponseSchema.safeParse({ ...failure, message: 'private' }).success).toBe(false)
    expect(mediaResponseSchema.safeParse({ ...failure, code: 'secret' }).success).toBe(false)
  })

  test('only allowed, unique variants; no storage keys or arbitrary MIME', () => {
    for (const change of [
      { variant: '../file' },
      { mime: 'text/html' },
      { path: '/tmp/file' },
      { storageKey: 'secret' },
      { bytes: 0 },
      { sha256: 'hash' },
      { width: null },
    ]) {
      expect(mediaFileSchema.safeParse({ ...file, ...change }).success).toBe(false)
    }
    expect(mediaResponseSchema.safeParse({ ...result, files: [file, file, file] }).success).toBe(
      false,
    )
  })

  test('metadata and the original must agree; image results must be sanitized', () => {
    for (const change of [
      { mime: 'video/mp4' },
      { metadataCleared: false },
      { width: 65 },
      { durationMs: 10 },
      { thumbhash: null },
      { files: [file] },
    ]) {
      expect(mediaResponseSchema.safeParse({ ...result, ...change }).success).toBe(false)
    }
  })

  test('limits include the aggregate variant bytes and the main image bytes', () => {
    expect(
      mediaResponseSchema.safeParse({
        ...result,
        files: [
          file,
          { ...file, variant: 'thumb', bytes: MEDIA_LIMITS.variantBytes },
          { ...file, variant: 'preview', bytes: 1 },
        ],
      }).success,
    ).toBe(false)
    expect(
      mediaResponseSchema.safeParse({
        ...result,
        files: [
          { ...file, bytes: MEDIA_LIMITS.imageBytes + 1 },
          { ...file, variant: 'thumb' },
          { ...file, variant: 'preview' },
        ],
      }).success,
    ).toBe(false)
  })

  test('uncleaned video fallback is a single, explicitly download-only file', () => {
    const fallback = {
      ...identity,
      status: 'ok',
      kind: 'file',
      mime: 'application/octet-stream',
      width: null,
      height: null,
      durationMs: null,
      metadataCleared: false,
      thumbhash: null,
      files: [{ ...file, mime: 'application/octet-stream', width: null, height: null }],
    }
    expect(mediaResponseSchema.safeParse(fallback).success).toBe(true)
    expect(mediaResponseSchema.safeParse({ ...fallback, metadataCleared: true }).success).toBe(
      false,
    )
    expect(mediaResponseSchema.safeParse({ ...fallback, mime: 'video/mp4' }).success).toBe(false)
  })

  test('invalid UTF-8, malformed JSON, empty and overlong headers are rejected before schema parsing', () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0xff]),
      new TextEncoder().encode('{'),
      new Uint8Array(MEDIA_LIMITS.headerBytes + 1),
    ]) {
      expect(() => decodeMediaRequest(bytes)).toThrow()
      expect(() => decodeMediaResponse(bytes)).toThrow()
    }
  })
})
