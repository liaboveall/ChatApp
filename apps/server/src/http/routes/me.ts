import {
  AppError,
  deviceSchema,
  devicesResponseSchema,
  errorBodySchema,
  meSchema,
  okResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { cookieNames } from '../../auth/better-auth.ts'
import { sessionCookieDeletions } from '../../auth/cookies.ts'
import { getMe } from '../../domain/me.ts'
import {
  listDevices,
  revokeAllDevices,
  revokeDevice,
  revokeOtherDevices,
} from '../../domain/sessions.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'

const errors = {
  401: {
    description: 'Not signed in',
    content: { 'application/json': { schema: errorBodySchema } },
  },
}

const getMeRoute = createRoute({
  method: 'get',
  path: '/api/me',
  tags: ['me'],
  summary: 'The signed-in user',
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: 'Me', content: { 'application/json': { schema: meSchema } } },
    ...errors,
  },
})

const listDevicesRoute = createRoute({
  method: 'get',
  path: '/api/me/devices',
  tags: ['me'],
  summary: 'Devices (logins) with a live session',
  security: [{ cookieAuth: [] }],
  responses: {
    200: {
      description: 'Devices',
      content: { 'application/json': { schema: devicesResponseSchema } },
    },
    ...errors,
  },
})

const revokeDeviceRoute = createRoute({
  method: 'delete',
  path: '/api/me/devices/{id}',
  tags: ['me'],
  summary: 'Revoke one device: ends its sessions and cancels the work it started',
  security: [{ cookieAuth: [] }],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: 'Revoked', content: { 'application/json': { schema: okResponseSchema } } },
    404: {
      description: 'No such device',
      content: { 'application/json': { schema: errorBodySchema } },
    },
    ...errors,
  },
})

const revokeOthersRoute = createRoute({
  method: 'post',
  path: '/api/me/devices/revoke-others',
  tags: ['me'],
  summary: 'Sign out every other device',
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: 'Done', content: { 'application/json': { schema: okResponseSchema } } },
    ...errors,
  },
})

const revokeAllRoute = createRoute({
  method: 'post',
  path: '/api/me/devices/revoke-all',
  tags: ['me'],
  summary: 'Security sign-out everywhere, including this device',
  security: [{ cookieAuth: [] }],
  responses: {
    200: { description: 'Done', content: { 'application/json': { schema: okResponseSchema } } },
    ...errors,
  },
})

export function meRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const guard = requireSession(services)
  const names = cookieNames(services.config.origin)
  const secure = services.config.origin.startsWith('https://')
  for (const path of ['/api/me', '/api/me/*']) app.use(path, guard)

  app.openapi(getMeRoute, async (c) => {
    const me = await getMe(services.deps, principalOf(c))
    if (!me) throw new AppError('NOT_FOUND', 'User not found')
    return c.json(me, 200)
  })

  app.openapi(listDevicesRoute, async (c) => {
    const devices = await listDevices(services.deps, principalOf(c))
    return c.json(
      {
        devices: devices.map((device) =>
          deviceSchema.parse({
            id: device.originId,
            current: device.current,
            createdAt: device.createdAt.toISOString(),
            lastActiveAt: device.lastActiveAt.toISOString(),
            ipAddress: device.ipAddress,
            userAgent: device.userAgent,
          }),
        ),
      },
      200,
    )
  })

  app.openapi(revokeDeviceRoute, async (c) => {
    const principal = principalOf(c)
    const { id } = c.req.valid('param')
    await revokeDevice(services.deps, principal, id)
    // Revoking the device you are on also ends this browser's session: drop its cookie.
    if (id === principal.originId)
      c.get('pendingCookies').push(...sessionCookieDeletions(names, secure))
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(revokeOthersRoute, async (c) => {
    await revokeOtherDevices(services.deps, principalOf(c))
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(revokeAllRoute, async (c) => {
    await revokeAllDevices(services.deps, principalOf(c))
    c.get('pendingCookies').push(...sessionCookieDeletions(names, secure))
    return c.json({ status: 'ok' as const }, 200)
  })
}
