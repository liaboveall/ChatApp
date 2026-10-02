import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import { cookieNames } from '../auth/better-auth.ts'
import { ManualClock } from '../lib/clock.ts'
import type { HttpEnv, Services } from './context.ts'
import { accessLog } from './middleware/access-log.ts'
import { type BodyBudget, bodyBudget } from './middleware/body-budget.ts'
import { originGuard } from './middleware/origin-guard.ts'
import { pathGuard } from './middleware/path-guard.ts'
import { requestContext } from './middleware/request-context.ts'
import { securityHeaders } from './middleware/security-headers.ts'
import { wakeOnWrite } from './middleware/wake-on-write.ts'
import { createErrorHandler, errorResponse } from './responses.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'
import { inviteRoutes } from './routes/invites.ts'
import { meRoutes } from './routes/me.ts'
import { testRoutes } from './routes/test.ts'

const DOCS_CSP =
  "default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; " +
  "img-src data: https:; font-src https://cdn.jsdelivr.net data:; connect-src 'self'; frame-ancestors 'none'"

export type AppOptions = {
  /** Tests shrink the read deadlines; production uses the defaults from contracts (D-078). */
  bodyBudget?: BodyBudget
}

export function createApp(services: Services, options: AppOptions = {}): OpenAPIHono<HttpEnv> {
  const app = new OpenAPIHono<HttpEnv>({
    strict: true,
    defaultHook: (result, c) => {
      if (!result.success) {
        // Field paths and issue codes only: messages and values from the request never reach the response.
        const issues = result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
        }))
        return errorResponse(c as never, 'VALIDATION_FAILED', 'Request validation failed', {
          details: { issues },
        })
      }
    },
  })

  app.use('*', requestContext(services))
  app.use('*', securityHeaders())
  app.use('*', accessLog(services))
  app.use('*', wakeOnWrite(services))
  app.onError(createErrorHandler(services.log))
  app.notFound((c) => errorResponse(c, 'NOT_FOUND', 'Not found'))

  app.use('/api/*', pathGuard())
  app.use('/api/*', originGuard(services.config.origin))
  app.use('/api/*', bodyBudget(options.bodyBudget))

  healthRoutes(app, services)
  authRoutes(app, services)
  inviteRoutes(app, services)
  meRoutes(app, services)

  const clock = services.deps.clock
  if (services.config.env === 'test' && clock instanceof ManualClock) testRoutes(app, clock)

  app.openAPIRegistry.registerComponent('securitySchemes', 'cookieAuth', {
    type: 'apiKey',
    in: 'cookie',
    name: cookieNames(services.config.origin).sessionToken,
  })
  if (services.config.env !== 'production') {
    app.doc31('/api/openapi.json', {
      openapi: '3.1.0',
      info: { title: `${services.config.product.name} API`, version: '1.0.0' },
    })
    const docs = Scalar<HttpEnv>({ url: '/api/openapi.json' })
    app.get('/api/docs', async (c, next) => {
      // The docs handler returns its page; add the (relaxed, docs-only) CSP to that response.
      const page = await docs(c, next)
      if (!page) return
      const headers = new Headers(page.headers)
      headers.set('Content-Security-Policy', DOCS_CSP)
      return new Response(page.body, { status: page.status, statusText: page.statusText, headers })
    })
  }
  return app
}
