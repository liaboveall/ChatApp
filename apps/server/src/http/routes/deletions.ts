import { AppError, deletionOperationSchema } from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { getCookie } from 'hono/cookie'
import { getAccountDeletionByReceipt } from '../../domain/account-deletion.ts'
import { getDeletionOperation } from '../../domain/deletion-operations.ts'
import type { HttpEnv, Services } from '../context.ts'
import { authenticate } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, idParam, json } from './helpers.ts'

export const ACCOUNT_DELETION_COOKIE = 'chatapp.account-deletion'
// Give the two independent OpenAPI alternatives a common shape so Hono preserves the typed request parameters.
const statusSecurity: Record<string, string[]>[] = [
  { cookieAuth: [] },
  { accountDeletionReceipt: [] },
]

export function deletionRoutes(app: OpenAPIHono<HttpEnv>, services: Services) {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/deletion-operations/{id}',
      tags: ['deletions'],
      security: statusSecurity,
      request: { params: idParam },
      responses: {
        200: json(deletionOperationSchema, 'Own deletion status, without content'),
        ...accessErrors,
      },
    }),
    async (c) => {
      // No refresh or cookie deletion on status reads: late responses cannot change another login's session.
      const auth = await authenticate(services, c, { readOnly: true })
      const id = c.req.valid('param').id
      if (auth.principal) {
        await services.limiter.enforce([
          { policy: POLICIES.apiUser, subject: auth.principal.userId },
        ])
        return c.json(await getDeletionOperation(services.deps, auth.principal, id), 200)
      }
      await services.limiter.enforce([
        { policy: POLICIES.deletionStatusIp, subject: c.get('clientIp') },
      ])
      const receipt = getCookie(c, ACCOUNT_DELETION_COOKIE)
      if (!receipt) throw new AppError('UNAUTHENTICATED', 'Sign in required')
      return c.json(await getAccountDeletionByReceipt(services.deps, id, receipt), 200)
    },
  )
}
