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

const disconnectBody = z.strictObject({
  /** Only this person's connections; omitted: every connection of this process. */
  userId: z.uuid().optional(),
  /** The close code the clients see; 1013 (try again later) by default, like a lost dependency. */
  code: z.number().int().min(1000).max(4999).optional(),
})

/** What a test can reach into: the clock when it is a manual one, and the gateway once it is attached. */
export type TestControls = {
  clock?: ManualClock
  realtime: () => { disconnect(options: { userId?: string; code?: number }): number } | undefined
}

export function testRoutes(app: OpenAPIHono<HttpEnv>, controls: TestControls): void {
  const { clock } = controls
  if (clock) {
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
        request: {
          body: { required: true, content: { 'application/json': { schema: clockBody } } },
        },
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

  // V-14: Playwright's offline switch does not reliably close a WebSocket that is already open, so end-to-end tests
  // drop connections from the server side with a code of their choice, exactly as a dying network would look to a client.
  app.openapi(
    createRoute({
      method: 'post',
      path: `${TEST_ROUTE_PREFIX}/realtime/disconnect`,
      tags: ['test'],
      summary: 'Test environment only: close live WebSocket connections',
      request: {
        body: { required: true, content: { 'application/json': { schema: disconnectBody } } },
      },
      responses: {
        200: {
          description: 'How many connections were closed',
          content: { 'application/json': { schema: z.object({ closed: z.number().int() }) } },
        },
      },
    }),
    (c) => {
      const realtime = controls.realtime()
      if (!realtime) throw new AppError('NOT_FOUND', 'No WebSocket gateway in this process')
      return c.json({ closed: realtime.disconnect(c.req.valid('json')) }, 200)
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
