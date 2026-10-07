import {
  AppError,
  attachmentPageSchema,
  attachmentQuerySchema,
  conversationSchema,
  mentionQuerySchema,
  meSchema,
  okResponseSchema,
  reserveUploadSchema,
  setAvatarSchema,
  uploadSchema,
  userSearchResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { blobStore } from '../../domain/attachment-common.ts'
import {
  downloadAttachment,
  listAttachments,
  mentionCandidates,
  setAvatar,
} from '../../domain/attachments.ts'
import { cancelUpload, getUpload, receiveUpload, reserveUpload } from '../../domain/uploads.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, idParam, json } from './helpers.ts'

const base = {
  tags: ['attachments'],
  security: [{ cookieAuth: [] }],
  responses: {
    ...accessErrors,
    409: err('State conflict'),
    422: err('Invalid input'),
    503: err('Storage unavailable'),
  },
}
const reservationRoute = createRoute({
  ...base,
  method: 'post',
  path: '/api/uploads/reservations',
  request: {
    body: { required: true, content: { 'application/json': { schema: reserveUploadSchema } } },
  },
  responses: { ...base.responses, 200: json(uploadSchema, 'Upload reservation') },
})
const statusRoute = createRoute({
  ...base,
  method: 'get',
  path: '/api/uploads/{id}',
  request: { params: idParam },
  responses: { ...base.responses, 200: json(uploadSchema, 'Upload state') },
})
const cancelRoute = createRoute({
  ...base,
  method: 'delete',
  path: '/api/uploads/{id}',
  request: { params: idParam },
  responses: { ...base.responses, 200: json(okResponseSchema, 'Cancelled') },
})
const contentRoute = createRoute({
  ...base,
  method: 'put',
  path: '/api/uploads/{id}/content',
  request: { params: idParam },
  responses: {
    ...base.responses,
    200: json(uploadSchema, 'Content received'),
    413: err('Too large'),
    408: err('Read timed out'),
  },
})
const listRoute = createRoute({
  ...base,
  method: 'get',
  path: '/api/conversations/{id}/attachments',
  request: { params: idParam, query: attachmentQuerySchema },
  responses: { ...base.responses, 200: json(attachmentPageSchema, 'Visible shared files') },
})
const mentionsRoute = createRoute({
  ...base,
  method: 'get',
  path: '/api/conversations/{id}/mentions',
  request: { params: idParam, query: mentionQuerySchema },
  responses: {
    ...base.responses,
    200: json(userSearchResponseSchema, 'Current mention candidates'),
  },
})
const downloadRoute = createRoute({
  ...base,
  method: 'get',
  path: '/api/attachments/{id}/{variant}',
  request: { params: idParam.extend({ variant: z.enum(['original', 'thumb', 'preview']) }) },
  responses: {
    ...base.responses,
    200: { description: 'Authorized bytes' },
    206: { description: 'Authorized byte range' },
    304: { description: 'Not modified after authorization' },
    416: { description: 'Unsatisfiable range' },
  },
})
const avatarRoute = createRoute({
  ...base,
  method: 'post',
  path: '/api/me/avatar',
  request: {
    body: { required: true, content: { 'application/json': { schema: setAvatarSchema } } },
  },
  responses: { ...base.responses, 200: json(meSchema, 'Profile') },
})
const conversationAvatarRoute = createRoute({
  ...base,
  method: 'post',
  path: '/api/conversations/{id}/avatar',
  request: {
    params: idParam,
    body: { required: true, content: { 'application/json': { schema: setAvatarSchema } } },
  },
  responses: { ...base.responses, 200: json(conversationSchema, 'Conversation') },
})

export function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || (!match[1] && !match[2])) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start ||
    (!match[1] && Number(match[2]) <= 0)
  )
    return null
  return { start, end }
}
export function attachmentRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const guard = requireSession(services)
  app.use('/api/uploads/*', guard)
  // Native image/player/download requests cannot participate in api()'s account cancellation.
  app.use('/api/attachments/*', requireSession(services, { cookieEffects: false }))
  // Conversation and me guards are installed by their respective route modules.
  const limited = async (principal: ReturnType<typeof principalOf>) =>
    services.limiter.enforce([{ policy: POLICIES.uploadUser, subject: principal.userId }])
  app.openapi(reservationRoute, async (c) => {
    const p = principalOf(c)
    await limited(p)
    return c.json(
      await reserveUpload(
        services.deps,
        p,
        c.req.valid('json'),
        c.req.header('Idempotency-Key') ?? '',
      ),
      200,
    )
  })
  app.openapi(statusRoute, async (c) =>
    c.json(await getUpload(services.deps, principalOf(c), c.req.valid('param').id), 200),
  )
  app.openapi(cancelRoute, async (c) => {
    await cancelUpload(services.deps, principalOf(c), c.req.valid('param').id)
    return c.json({ status: 'ok' as const }, 200)
  })
  app.openapi(contentRoute, async (c) => {
    const p = principalOf(c)
    await limited(p)
    if (!c.req.raw.body) throw new AppError('VALIDATION_FAILED', 'Empty upload')
    return c.json(
      await receiveUpload(
        services.deps,
        p,
        c.req.valid('param').id,
        c.req.raw.body,
        c.req.raw.signal,
      ),
      200,
    )
  })
  app.openapi(listRoute, async (c) =>
    c.json(
      await listAttachments(
        services.deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('query'),
      ),
      200,
    ),
  )
  app.openapi(avatarRoute, async (c) => {
    const result = await setAvatar(services.deps, principalOf(c), c.req.valid('json'))
    return c.json(meSchema.parse(result), 200)
  })
  app.openapi(conversationAvatarRoute, async (c) => {
    const result = await setAvatar(
      services.deps,
      principalOf(c),
      c.req.valid('json'),
      c.req.valid('param').id,
    )
    return c.json(conversationSchema.parse(result), 200)
  })
  app.openapi(mentionsRoute, async (c) =>
    c.json(
      await mentionCandidates(
        services.deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('query').query,
      ),
      200,
    ),
  )
  app.openapi(downloadRoute, async (c) => {
    const { id, variant } = c.req.valid('param')
    // Authorization precedes every Range and conditional response, including 304 and 416.
    const file = await downloadAttachment(services.deps, principalOf(c), id, variant)
    const headers = new Headers({
      'Content-Type': file.mime,
      'Cache-Control': 'private, no-store',
      ETag: file.etag,
      'Accept-Ranges': 'bytes',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
      'Content-Disposition': `${file.attachment.kind === 'file' ? 'attachment' : 'inline'}; filename="file"; filename*=UTF-8''${encodeURIComponent(file.attachment.originalName).replace(/'/g, '%27')}`,
    })
    if (c.req.header('If-None-Match') === file.etag)
      return new Response(null, { status: 304, headers })
    const raw = c.req.header('Range'),
      ifRange = c.req.header('If-Range')
    const range =
      raw && (!ifRange || ifRange === file.etag) ? parseRange(raw, file.size) : undefined
    if (range === null) {
      headers.set('Content-Range', `bytes */${file.size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range) {
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
      headers.set('Content-Length', String(range.end - range.start + 1))
    } else headers.set('Content-Length', String(file.size))
    return new Response(
      blobStore(services.deps).read(file.key, range?.start, range ? range.end + 1 : undefined),
      { status: range ? 206 : 200, headers },
    )
  })
}
