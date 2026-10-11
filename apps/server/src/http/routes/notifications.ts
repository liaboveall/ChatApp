/**
 * The in-site notification centre and browser push subscriptions (docs/05 section 3.7, M6): the list and marking read, the
 * application server key, and a browser installation's subscription (add, list, remove, test).
 */
import {
  AppError,
  markNotificationsReadResponseSchema,
  markNotificationsReadSchema,
  notificationPageSchema,
  notificationsQuerySchema,
  pushSubscribeRequestSchema,
  pushSubscriptionListSchema,
  pushSubscriptionResponseSchema,
  pushSubscriptionsQuerySchema,
  pushTestResponseSchema,
  vapidKeyResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { listNotifications, markNotificationsRead } from '../../domain/notifications.ts'
import {
  listPushSubscriptions,
  queueTestPush,
  subscribePush,
  unsubscribePush,
} from '../../domain/push.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, guardedErrors, idParam, json } from './helpers.ts'

const body = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
})

const removedSchema = z.object({ id: z.uuid() })
const testRequestSchema = z.strictObject({ installationId: z.uuid() })

export function notificationRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps, limiter } = services
  for (const path of ['/api/notifications', '/api/notifications/*'])
    app.use(path, requireSession(services))
  // A worker can finish this request after every page was closed or signed out. Its answer must never refresh or delete a
  // cookie of a later login. Normal page identity requests own rolling refresh and stale-cookie cleanup.
  app.use('/api/push/*', requireSession(services, { cookieEffects: false }))

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/notifications',
      tags: ['notifications'],
      summary: 'My notifications, newest first, as I may see their sources now',
      security: [{ cookieAuth: [] }],
      request: { query: notificationsQuerySchema },
      responses: {
        200: json(notificationPageSchema, 'A page of notifications and the number still unread'),
        422: err('Invalid cursor or limit'),
        ...guardedErrors,
      },
    }),
    async (c) => c.json(await listNotifications(deps, principalOf(c), c.req.valid('query')), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/notifications/read',
      tags: ['notifications'],
      summary: 'Mark some, or all, of my notifications read; repeating it changes nothing',
      security: [{ cookieAuth: [] }],
      request: { body: body(markNotificationsReadSchema) },
      responses: {
        200: json(markNotificationsReadResponseSchema, 'What changed and the unread count now'),
        422: err('Validation failed'),
        ...guardedErrors,
      },
    }),
    async (c) => {
      const principal = principalOf(c)
      await limiter.enforce([{ policy: POLICIES.notificationsReadUser, subject: principal.userId }])
      return c.json(await markNotificationsRead(deps, principal, c.req.valid('json')), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/push/vapid-key',
      tags: ['push'],
      summary: 'The application server key a browser subscribes with (public)',
      security: [{ cookieAuth: [] }],
      responses: {
        200: json(vapidKeyResponseSchema, 'The key'),
        503: err('Browser push is not set up on this server'),
        ...guardedErrors,
      },
    }),
    (c) => {
      if (!deps.push) {
        throw new AppError('CAPACITY_UNAVAILABLE', 'Browser push is not set up on this server')
      }
      return c.json({ publicKey: deps.push.vapidPublicKey }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/push/subscriptions',
      tags: ['push'],
      summary: 'My subscribed browsers; the one of the given installation is marked current',
      security: [{ cookieAuth: [] }],
      request: { query: pushSubscriptionsQuerySchema },
      responses: { 200: json(pushSubscriptionListSchema, 'My subscriptions'), ...guardedErrors },
    }),
    async (c) =>
      c.json(
        {
          subscriptions: await listPushSubscriptions(
            deps,
            principalOf(c),
            c.req.valid('query').installationId ?? null,
          ),
        },
        200,
      ),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/push/subscriptions',
      tags: ['push'],
      summary:
        'Subscribe this browser installation; bound to this sign-in, and removed with it (201 new, 200 repeat)',
      security: [{ cookieAuth: [] }],
      request: { body: body(pushSubscribeRequestSchema) },
      responses: {
        201: json(pushSubscriptionResponseSchema, 'Subscribed'),
        200: json(pushSubscriptionResponseSchema, 'Already subscribed; the keys were refreshed'),
        409: err('The endpoint belongs to another account'),
        422: err('The endpoint or its keys are not accepted'),
        503: err('Browser push is not set up on this server'),
        ...accessErrors,
      },
    }),
    async (c) => {
      const principal = principalOf(c)
      await limiter.enforce([{ policy: POLICIES.pushSubscribeUser, subject: principal.userId }])
      const result = await subscribePush(
        deps,
        principal,
        c.req.valid('json'),
        c.req.header('user-agent') ?? null,
      )
      return c.json({ subscription: result.subscription }, result.created ? 201 : 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/push/subscriptions/{id}',
      tags: ['push'],
      summary: 'Remove one of my subscriptions',
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: { 200: json(removedSchema, 'Removed'), ...accessErrors },
    }),
    async (c) => {
      const { id } = c.req.valid('param')
      await unsubscribePush(deps, principalOf(c), id)
      return c.json({ id }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/push/test',
      tags: ['push'],
      summary: 'Send a test push to this browser installation',
      security: [{ cookieAuth: [] }],
      request: { body: body(testRequestSchema) },
      responses: {
        200: json(
          pushTestResponseSchema,
          'Queued, or false when this installation is not subscribed',
        ),
        503: err('Browser push is not set up on this server'),
        ...accessErrors,
      },
    }),
    async (c) => {
      const principal = principalOf(c)
      await limiter.enforce([{ policy: POLICIES.pushTestUser, subject: principal.userId }])
      const result = await queueTestPush(deps, principal, c.req.valid('json').installationId)
      services.wake()
      return c.json(result, 200)
    },
  )
}
