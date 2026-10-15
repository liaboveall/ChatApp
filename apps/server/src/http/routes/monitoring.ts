import {
  AppError,
  monitoringConfigSchema,
  monitoringEventSchema,
  okResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { rateLimitIpKey } from '../../lib/ip.ts'
import type { HttpEnv, Services } from '../context.ts'
import { POLICIES } from '../policies.ts'
import { err, json } from './helpers.ts'
export function monitoringRoutes(app: OpenAPIHono<HttpEnv>, services: Services) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/monitoring/config',
      tags: ['site'],
      responses: { 200: json(monitoringConfigSchema, 'Public monitoring availability') },
    }),
    async (c) => c.json({ enabled: services.monitoring?.enabled ?? false }, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/monitoring',
      tags: ['site'],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: monitoringEventSchema } },
        },
      },
      responses: {
        200: json(okResponseSchema, 'Sanitized event forwarded'),
        422: err('Only allowlisted diagnostic fields accepted'),
        429: err('Monitoring rate exceeded'),
        503: err('Monitoring unavailable'),
      },
    }),
    async (c) => {
      await services.limiter.enforce([
        { policy: POLICIES.monitoringIp, subject: rateLimitIpKey(c.get('clientIp')) },
      ])
      // Do not authenticate, refresh or expire a session: errors on the login page must be reportable too.
      try {
        await services.monitoring?.send(c.req.valid('json'))
      } catch {
        throw new AppError('CAPACITY_UNAVAILABLE', 'Monitoring temporarily unavailable')
      }
      return c.json({ status: 'ok' as const }, 200)
    },
  )
}
