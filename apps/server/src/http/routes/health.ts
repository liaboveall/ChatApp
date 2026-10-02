import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { HttpEnv, Services } from '../context.ts'

const status = z.object({ status: z.enum(['ok', 'unavailable']) })

const healthz = createRoute({
  method: 'get',
  path: '/api/healthz',
  tags: ['health'],
  summary: 'Liveness: the process is up',
  responses: { 200: { description: 'Alive', content: { 'application/json': { schema: status } } } },
})

const readyz = createRoute({
  method: 'get',
  path: '/api/readyz',
  tags: ['health'],
  summary: 'Readiness: Postgres, Valkey and object storage all answer',
  responses: {
    200: { description: 'Ready', content: { 'application/json': { schema: status } } },
    503: { description: 'Not ready', content: { 'application/json': { schema: status } } },
  },
})

/** Health answers only 200/503 and a fixed word: no versions, hosts or reasons for anonymous callers (docs/03 section 9). */
export function healthRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  app.openapi(healthz, (c) => c.json({ status: 'ok' as const }, 200))
  app.openapi(readyz, async (c) => {
    const ready = await services.isReady().catch(() => false)
    return ready
      ? c.json({ status: 'ok' as const }, 200)
      : c.json({ status: 'unavailable' as const }, 503)
  })
}
