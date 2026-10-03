/** Conversation routes (docs/05 section 3.3): listing, creating, opening, joining, leaving, archiving, my own settings. */
import {
  AppError,
  channelsPageSchema,
  channelsQuerySchema,
  conversationListQuerySchema,
  conversationListResponseSchema,
  conversationSchema,
  createConversationRequestSchema,
  IDEMPOTENCY_KEY_HEADER,
  okResponseSchema,
  openDmRequestSchema,
  patchConversationMeRequestSchema,
  patchConversationRequestSchema,
  readRequestSchema,
  restoreConversationRequestSchema,
  transferRequestSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  archiveConversation,
  createConversation,
  discoverChannels,
  getConversation,
  joinConversation,
  leaveConversation,
  listConversations,
  markConversationRead,
  openDirectMessage,
  restoreConversation,
  transferOwnership,
  updateConversation,
  updateMyConversationSettings,
} from '../../domain/conversations.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, guardedErrors, idParam, json } from './helpers.ts'

const body = <T extends Parameters<typeof json>[0]>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
})

const listRoute = createRoute({
  method: 'get',
  path: '/api/conversations',
  tags: ['conversations'],
  summary:
    'My conversations with unread counts and previews; ?archived=true lists the archived ones I own',
  security: [{ cookieAuth: [] }],
  request: { query: conversationListQuerySchema },
  responses: { 200: json(conversationListResponseSchema, 'Conversations'), ...guardedErrors },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/api/conversations',
  tags: ['conversations'],
  summary: 'Create a channel or a group (Idempotency-Key required)',
  security: [{ cookieAuth: [] }],
  request: { body: body(createConversationRequestSchema) },
  responses: {
    201: json(conversationSchema, 'Created'),
    200: json(conversationSchema, 'The same request was made before: the conversation it created'),
    409: err('A live channel has this name, or the key was used for another request'),
    410: err('The conversation this request created is gone'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const dmRoute = createRoute({
  method: 'post',
  path: '/api/conversations/dm',
  tags: ['conversations'],
  summary: 'Open (or create) the direct message with another member',
  security: [{ cookieAuth: [] }],
  request: { body: body(openDmRequestSchema) },
  responses: {
    201: json(conversationSchema, 'Created'),
    200: json(conversationSchema, 'Already existed'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const channelsRoute = createRoute({
  method: 'get',
  path: '/api/channels',
  tags: ['conversations'],
  summary:
    'Channel discovery: live channels by name, searchable; channels I am banned from are left out',
  security: [{ cookieAuth: [] }],
  request: { query: channelsQuerySchema },
  responses: {
    200: json(channelsPageSchema, 'A page of channels'),
    422: err('The cursor does not belong to this search'),
    ...guardedErrors,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}',
  tags: ['conversations'],
  summary: 'One conversation as the viewer sees it (`me` is null for non-members)',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(conversationSchema, 'The conversation'), ...accessErrors },
})

const patchRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}',
  tags: ['conversations'],
  summary: 'Name, description and settings; conditional on metadataVersion',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(patchConversationRequestSchema) },
  responses: {
    200: json(conversationSchema, 'Changed'),
    409: err('Stale metadataVersion, a live channel has the name, or the conversation is archived'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const archiveRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/archive',
  tags: ['conversations'],
  summary: 'Archive (owner or site administrator): read-only, gone from members’ lists',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(conversationSchema, 'Archived'), ...accessErrors },
})

const restoreRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/restore',
  tags: ['conversations'],
  summary: 'Restore an archived conversation, renaming a channel whose name was taken',
  security: [{ cookieAuth: [] }],
  request: {
    params: idParam,
    body: {
      required: false,
      content: { 'application/json': { schema: restoreConversationRequestSchema } },
    },
  },
  responses: {
    200: json(conversationSchema, 'Restored'),
    409: err('A live channel has the name; send another one'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const joinRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/join',
  tags: ['conversations'],
  summary: 'Join a channel',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: {
    200: json(conversationSchema, 'Joined (or already a member)'),
    409: err('Archived'),
    ...accessErrors,
  },
})

const leaveRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/leave',
  tags: ['conversations'],
  summary: 'Leave a channel or group; the owner must transfer ownership first',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: {
    200: json(okResponseSchema, 'Left'),
    409: err('The owner must hand over first'),
    ...accessErrors,
  },
})

const transferRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/transfer',
  tags: ['conversations'],
  summary: 'Hand ownership to another member (owner only)',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(transferRequestSchema) },
  responses: {
    200: json(conversationSchema, 'Transferred'),
    409: err('The member list changed'),
    422: err('The new owner is not a member'),
    ...accessErrors,
  },
})

const patchMeRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}/me',
  tags: ['conversations'],
  summary: 'My notification level, mute, pin and hide; conditional on viewerVersion',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(patchConversationMeRequestSchema) },
  responses: {
    200: json(conversationSchema, 'Changed'),
    409: err('Stale viewerVersion'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const readRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/read',
  tags: ['conversations'],
  summary: 'Move my read position forward (it never moves back)',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(readRequestSchema) },
  responses: {
    200: json(conversationSchema, 'The conversation with my new position'),
    ...accessErrors,
  },
})

export function conversationRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps, limiter } = services
  const guard = requireSession(services)
  for (const path of ['/api/conversations', '/api/conversations/*', '/api/channels'])
    app.use(path, guard)

  app.openapi(listRoute, async (c) => {
    const { archived } = c.req.valid('query')
    return c.json(
      await listConversations(deps, principalOf(c), { archived: archived ?? false }),
      200,
    )
  })

  app.openapi(createRouteDef, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.conversationCreateUser, subject: principal.userId }])
    const key = c.req.header(IDEMPOTENCY_KEY_HEADER)
    if (key === undefined) {
      throw new AppError('VALIDATION_FAILED', 'Idempotency-Key header is required', {
        details: { field: 'idempotencyKey' },
      })
    }
    const result = await createConversation(deps, principal, c.req.valid('json'), key)
    return c.json(result.conversation, result.created ? 201 : 200)
  })

  app.openapi(dmRoute, async (c) => {
    const result = await openDirectMessage(deps, principalOf(c), c.req.valid('json'))
    return c.json(result.conversation, result.created ? 201 : 200)
  })

  app.openapi(channelsRoute, async (c) =>
    c.json(await discoverChannels(deps, principalOf(c), c.req.valid('query')), 200),
  )

  app.openapi(getRoute, async (c) =>
    c.json(await getConversation(deps, principalOf(c), c.req.valid('param').id), 200),
  )

  app.openapi(patchRoute, async (c) =>
    c.json(
      await updateConversation(deps, principalOf(c), c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
  )

  app.openapi(archiveRoute, async (c) =>
    c.json(await archiveConversation(deps, principalOf(c), c.req.valid('param').id), 200),
  )

  app.openapi(restoreRoute, async (c) =>
    c.json(
      await restoreConversation(
        deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('json') ?? {},
      ),
      200,
    ),
  )

  app.openapi(joinRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.conversationJoinUser, subject: principal.userId }])
    return c.json(await joinConversation(deps, principal, c.req.valid('param').id), 200)
  })

  app.openapi(leaveRoute, async (c) => {
    await leaveConversation(deps, principalOf(c), c.req.valid('param').id)
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(transferRoute, async (c) =>
    c.json(
      await transferOwnership(deps, principalOf(c), c.req.valid('param').id, c.req.valid('json')),
      200,
    ),
  )

  app.openapi(patchMeRoute, async (c) =>
    c.json(
      await updateMyConversationSettings(
        deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
      200,
    ),
  )

  app.openapi(readRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.readUser, subject: principal.userId }])
    return c.json(
      await markConversationRead(deps, principal, c.req.valid('param').id, c.req.valid('json').seq),
      200,
    )
  })
}
