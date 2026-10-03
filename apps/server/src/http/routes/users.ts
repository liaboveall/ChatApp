/** The member directory (docs/05 section 3.2): search for direct messages and adding people, and public profiles. */
import {
  userProfileSchema,
  userSearchQuerySchema,
  userSearchResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { getUserProfile, searchUsers } from '../../domain/users.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, guardedErrors, idParam, json } from './helpers.ts'

const searchRoute = createRoute({
  method: 'get',
  path: '/api/users',
  tags: ['users'],
  summary: 'Find members by username or display name',
  security: [{ cookieAuth: [] }],
  request: { query: userSearchQuerySchema },
  responses: {
    200: json(userSearchResponseSchema, 'Matching members, best match first'),
    ...guardedErrors,
  },
})

const profileRoute = createRoute({
  method: 'get',
  path: '/api/users/{id}',
  tags: ['users'],
  summary: 'A member’s public profile',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(userProfileSchema, 'The profile'), ...accessErrors },
})

export function userRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps, limiter } = services
  const guard = requireSession(services)
  for (const path of ['/api/users', '/api/users/*']) app.use(path, guard)

  app.openapi(searchRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.userSearchUser, subject: principal.userId }])
    return c.json({ users: await searchUsers(deps, principal, c.req.valid('query').query) }, 200)
  })

  app.openapi(profileRoute, async (c) =>
    c.json(await getUserProfile(deps, c.req.valid('param').id), 200),
  )
}
