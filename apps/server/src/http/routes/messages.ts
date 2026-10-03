/** Message routes (docs/05 section 3.4): reading, sending, editing, recalling, hiding, moderator delete, and the sync feeds. */
import {
  changesQuerySchema,
  conversationChangesResponseSchema,
  editMessageRequestSchema,
  messageEnvelopeSchema,
  messagesQuerySchema,
  messagesResponseSchema,
  okResponseSchema,
  sendMessageRequestSchema,
  syncHeadsResponseSchema,
  userChangesResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, type z } from '@hono/zod-openapi'
import {
  deleteMessageAsModerator,
  editMessage,
  getMessage,
  hideMessage,
  listMessages,
  recallMessage,
  sendMessage,
} from '../../domain/messages.ts'
import { getConversationChanges, getSyncHeads, getUserChanges } from '../../domain/sync.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, guardedErrors, idParam, json } from './helpers.ts'

const body = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
})

const listRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/messages',
  tags: ['messages'],
  summary:
    'Messages, ascending; the newest page, or around/before/after a sequence number; only what the reader may see',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, query: messagesQuerySchema },
  responses: { 200: json(messagesResponseSchema, 'A page of messages'), ...accessErrors },
})

const sendRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/messages',
  tags: ['messages'],
  summary: 'Send a message; the same clientId returns the same message (201 new, 200 repeat)',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(sendMessageRequestSchema) },
  responses: {
    201: json(messageEnvelopeSchema, 'Sent'),
    200: json(
      messageEnvelopeSchema,
      'The same clientId and request were sent before: that message',
    ),
    409: err('The clientId was used for another message, or the conversation is archived'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const changesRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/changes',
  tags: ['sync'],
  summary:
    'The change log of a conversation with a fixed upper bound; after on the first page, cursor on the rest',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, query: changesQuerySchema },
  responses: {
    200: json(
      conversationChangesResponseSchema,
      'A page of changes, or a reset with a baseline snapshot',
    ),
    422: err('after and cursor together, or neither'),
    ...accessErrors,
  },
})

const getRoute = createRoute({
  method: 'get',
  path: '/api/messages/{id}',
  tags: ['messages'],
  summary: 'One message as the reader may see it',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(messageEnvelopeSchema, 'The message'), ...accessErrors },
})

const editRoute = createRoute({
  method: 'patch',
  path: '/api/messages/{id}',
  tags: ['messages'],
  summary: 'Edit within 24 hours (author only); conditional on changeSeq',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(editMessageRequestSchema) },
  responses: {
    200: json(messageEnvelopeSchema, 'Edited'),
    409: err('The message changed, was withdrawn, or the conversation is archived'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const recallRoute = createRoute({
  method: 'post',
  path: '/api/messages/{id}/recall',
  tags: ['messages'],
  summary: 'Recall within two minutes (author only); repeating it returns the same end state',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(messageEnvelopeSchema, 'Recalled'), ...accessErrors },
})

const hideRoute = createRoute({
  method: 'post',
  path: '/api/messages/{id}/hide',
  tags: ['messages'],
  summary: 'Delete for me: a view preference, the message stays for everybody else',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(okResponseSchema, 'Hidden'), ...accessErrors },
})

const deleteRoute = createRoute({
  method: 'delete',
  path: '/api/messages/{id}',
  tags: ['messages'],
  summary: 'Delete for everybody (owner, administrator or site administrator); audited',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(okResponseSchema, 'Deleted'), ...accessErrors },
})

const headsRoute = createRoute({
  method: 'get',
  path: '/api/sync/heads',
  tags: ['sync'],
  summary: 'Versions of my conversations and of my own log, no content; polled for reconciliation',
  security: [{ cookieAuth: [] }],
  responses: { 200: json(syncHeadsResponseSchema, 'Heads'), ...guardedErrors },
})

const meChangesRoute = createRoute({
  method: 'get',
  path: '/api/me/changes',
  tags: ['sync'],
  summary: 'My own change log: conversations, preferences, read position, hidden messages, profile',
  security: [{ cookieAuth: [] }],
  request: { query: changesQuerySchema },
  responses: {
    200: json(userChangesResponseSchema, 'A page of changes, or a reset with a baseline snapshot'),
    422: err('after and cursor together, or neither'),
    ...guardedErrors,
  },
})

export function messageRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps, limiter } = services
  const guard = requireSession(services)
  for (const path of ['/api/messages/*', '/api/sync/*']) app.use(path, guard)
  // `/api/conversations/*` and `/api/me/*` are guarded by their own modules, registered before this one.

  app.openapi(listRoute, async (c) =>
    c.json(
      await listMessages(deps, principalOf(c), c.req.valid('param').id, c.req.valid('query')),
      200,
    ),
  )

  app.openapi(sendRoute, async (c) => {
    const principal = principalOf(c)
    const { id } = c.req.valid('param')
    // Per person and conversation, then per person overall (docs/01 section 7); the person's own limit, never the IP's.
    await limiter.enforce([
      { policy: POLICIES.messageConversationUser, subject: `${principal.userId}:${id}` },
      { policy: POLICIES.messageUser, subject: principal.userId },
    ])
    const result = await sendMessage(deps, principal, id, c.req.valid('json'))
    return c.json(result.envelope, result.created ? 201 : 200)
  })

  app.openapi(changesRoute, async (c) =>
    c.json(
      await getConversationChanges(
        deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('query'),
      ),
      200,
    ),
  )

  app.openapi(getRoute, async (c) =>
    c.json(await getMessage(deps, principalOf(c), c.req.valid('param').id), 200),
  )

  app.openapi(editRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.messageEditUser, subject: principal.userId }])
    return c.json(
      await editMessage(deps, principal, c.req.valid('param').id, c.req.valid('json')),
      200,
    )
  })

  app.openapi(recallRoute, async (c) =>
    c.json(await recallMessage(deps, principalOf(c), c.req.valid('param').id), 200),
  )

  app.openapi(hideRoute, async (c) => {
    await hideMessage(deps, principalOf(c), c.req.valid('param').id)
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(deleteRoute, async (c) => {
    await deleteMessageAsModerator(deps, principalOf(c), c.req.valid('param').id)
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(headsRoute, async (c) => c.json(await getSyncHeads(deps, principalOf(c)), 200))

  app.openapi(meChangesRoute, async (c) =>
    c.json(await getUserChanges(deps, principalOf(c), c.req.valid('query')), 200),
  )
}
