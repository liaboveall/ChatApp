/**
 * Test-only endpoints (docs/08 section 4, SEC-29). They are registered ONLY when APP_ENV=test, and the production
 * start-up self-check (`assertNoTestRoutes`) refuses to boot if any `/api/test/*` route exists.
 */

import { AppError } from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import type { ManualClock } from '../../lib/clock.ts'
import type { HttpEnv } from '../context.ts'

export const TEST_ROUTE_PREFIX = '/api/test'

const clockBody = z.strictObject({
  advanceMs: z
    .number()
    .int()
    .min(0)
    .max(366 * 86_400_000)
    .optional(),
  set: z.iso.datetime().optional(),
})
const clockState = z.object({ now: z.iso.datetime() })

export function testRoutes(app: OpenAPIHono<HttpEnv>, clock: ManualClock): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: `${TEST_ROUTE_PREFIX}/clock`,
      tags: ['test'],
      summary: 'Test environment only: the controllable server clock',
      responses: {
        200: { description: 'Now', content: { 'application/json': { schema: clockState } } },
      },
    }),
    (c) => c.json({ now: clock.now().toISOString() }, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: `${TEST_ROUTE_PREFIX}/clock`,
      tags: ['test'],
      summary: 'Test environment only: move the server clock',
      request: { body: { required: true, content: { 'application/json': { schema: clockBody } } } },
      responses: {
        200: { description: 'Now', content: { 'application/json': { schema: clockState } } },
      },
    }),
    (c) => {
      const { advanceMs, set } = c.req.valid('json')
      if (set !== undefined) clock.set(new Date(set))
      if (advanceMs !== undefined) clock.advance(advanceMs)
      return c.json({ now: clock.now().toISOString() }, 200)
    },
  )
}

/** Start-up self-check: no test route may exist outside APP_ENV=test. */
export function assertNoTestRoutes(app: { routes: ReadonlyArray<{ path: string }> }): void {
  const found = app.routes.filter((route) => route.path.startsWith(TEST_ROUTE_PREFIX))
  if (found.length > 0) {
    throw new AppError(
      'INTERNAL',
      `test-only routes are registered outside APP_ENV=test (${found.length})`,
    )
  }
}
