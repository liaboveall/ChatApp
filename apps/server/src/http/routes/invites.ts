import {
  createdInviteSchema,
  createInviteRequestSchema,
  errorBodySchema,
  inviteCheckRequestSchema,
  inviteCheckResponseSchema,
  inviteRegistrationSchema,
  inviteSchema,
  okResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { checkInvite, createInvite, listInvites, revokeInvite } from '../../domain/invites.ts'
import { revokeRegistration } from '../../domain/registration.ts'
import { rateLimitIpKey } from '../../lib/ip.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
})
const err = (description: string) => json(errorBodySchema, description)

const checkRoute = createRoute({
  method: 'post',
  path: '/api/invites/check',
  tags: ['invites'],
  summary: 'Is this invitation code usable? The code travels in the body, never in the URL.',
  request: {
    body: { required: true, content: { 'application/json': { schema: inviteCheckRequestSchema } } },
  },
  responses: {
    200: json(inviteCheckResponseSchema, 'Usable'),
    400: err('Invalid, expired, used up or revoked'),
    429: err('Rate limited'),
  },
})

const listRoute = createRoute({
  method: 'get',
  path: '/api/invites',
  tags: ['invites'],
  summary: 'My invitation codes and my registrations that are still unverified',
  security: [{ cookieAuth: [] }],
  responses: {
    200: json(
      z.object({
        invites: z.array(inviteSchema),
        registrations: z.array(inviteRegistrationSchema),
      }),
      'Mine',
    ),
    401: err('Not signed in'),
  },
})

const createRouteDef = createRoute({
  method: 'post',
  path: '/api/invites',
  tags: ['invites'],
  summary: 'Create an invitation code; the plaintext is returned once',
  security: [{ cookieAuth: [] }],
  request: {
    body: {
      required: false,
      content: { 'application/json': { schema: createInviteRequestSchema } },
    },
  },
  responses: {
    201: json(createdInviteSchema, 'Created'),
    401: err('Not signed in'),
    403: err('Not allowed (for example unlimited codes)'),
  },
})

const revokeRoute = createRoute({
  method: 'delete',
  path: '/api/invites/{id}',
  tags: ['invites'],
  summary: 'Revoke an invitation code',
  security: [{ cookieAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: json(okResponseSchema, 'Revoked'),
    401: err('Not signed in'),
    404: err('Not found'),
  },
})

const revokeRegistrationRoute = createRoute({
  method: 'delete',
  path: '/api/invites/registrations/{useId}',
  tags: ['invites'],
  summary:
    'Withdraw a registration whose email was never verified: deletes the account and frees the slot',
  security: [{ cookieAuth: [] }],
  request: { params: z.object({ useId: z.uuid() }) },
  responses: {
    200: json(okResponseSchema, 'Withdrawn'),
    401: err('Not signed in'),
    404: err('Not found'),
    409: err('Already active'),
  },
})

export function inviteRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  // The public code check is registered first so the session guards below (which also match its path) never see it.
  app.openapi(checkRoute, async (c) => {
    await services.limiter.enforce([
      { policy: POLICIES.inviteCheckIp, subject: rateLimitIpKey(c.get('clientIp')) },
    ])
    await checkInvite(services.deps, c.req.valid('json').code)
    return c.json({ valid: true as const }, 200)
  })

  const guard = requireSession(services)
  app.use('/api/invites', guard)
  app.use('/api/invites/:id', guard)
  app.use('/api/invites/registrations/:useId', guard)

  app.openapi(listRoute, async (c) => c.json(await listInvites(services.deps, principalOf(c)), 200))

  app.openapi(createRouteDef, async (c) => {
    // The body is optional: an empty POST creates a default invitation (7 days, one use).
    const input = c.req.valid('json') ?? {}
    return c.json(await createInvite(services.deps, principalOf(c), input), 201)
  })

  app.openapi(revokeRoute, async (c) => {
    await revokeInvite(services.deps, principalOf(c), c.req.valid('param').id)
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(revokeRegistrationRoute, async (c) => {
    await revokeRegistration(services.deps, principalOf(c), c.req.valid('param').useId)
    return c.json({ status: 'ok' as const }, 200)
  })
}
