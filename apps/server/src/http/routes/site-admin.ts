import {
  adminAuditLogsSchema,
  adminBanSchema,
  adminConversationsSchema,
  adminInvitesSchema,
  adminPageQuerySchema,
  adminReportsSchema,
  adminUsageSchema,
  adminUserSchema,
  adminUsersSchema,
  adminUserUpdateSchema,
  clientSiteLimitsSchema,
  expectedVersionSchema,
  okResponseSchema,
  privacyPolicySchema,
  reportContextSchema,
  reportReceiptSchema,
  reportRequestSchema,
  reportUpdateSchema,
  restoreConversationRequestSchema,
  siteSettingsSchema,
  siteSettingsUpdateSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import { assertIdempotencyKey } from '../../domain/idempotency.ts'
import { decideReport, submitReport, viewReportContext } from '../../domain/reports.ts'
import {
  adminArchive,
  adminBans,
  adminCatalog,
  adminRestore,
  adminRevokeInvite,
  adminSettings,
  adminUnban,
  adminUsage,
  adminUserChange,
  updateAdminSettings,
} from '../../domain/site-admin.ts'
import { readClientSiteLimits, readSitePolicy } from '../../domain/site-policy.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, idParam, json } from './helpers.ts'

const errors = {
  ...accessErrors,
  409: err('Version or state changed'),
  422: err('Invalid request'),
}
const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
})
const security = [{ cookieAuth: [] }]
export function siteAdminRoutes(app: OpenAPIHono<HttpEnv>, services: Services) {
  const { deps } = services
  app.use('/api/admin/*', requireSession(services))
  app.use('/api/admin/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method))
      await services.limiter.enforce([
        { policy: POLICIES.adminWriteUser, subject: principalOf(c).userId },
      ])
    await next()
  })
  app.use('/api/reports', requireSession(services))
  app.use('/api/site-limits', requireSession(services))
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/site-limits',
      tags: ['site'],
      security,
      responses: {
        200: json(clientSiteLimitsSchema, 'Current message and upload limits'),
        ...accessErrors,
      },
    }),
    async (c) => c.json(await readClientSiteLimits(deps, deps.db), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/privacy',
      tags: ['site'],
      responses: { 200: json(privacyPolicySchema, 'Current public retention policy') },
    }),
    async (c) =>
      c.json({ runContentDays: (await readSitePolicy(deps, deps.db)).policy.runContentDays }, 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/users',
      tags: ['admin'],
      security,
      request: { query: adminPageQuerySchema },
      responses: { 200: json(adminUsersSchema, 'User management page'), ...errors },
    }),
    async (c) =>
      c.json(
        adminUsersSchema.parse(
          await adminCatalog(deps, principalOf(c), 'users', c.req.valid('query')),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/admin/users/{id}',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(adminUserUpdateSchema) },
      responses: { 200: json(adminUserSchema, 'Updated current user'), ...errors },
    }),
    async (c) =>
      c.json(
        await adminUserChange(
          deps,
          principalOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
          c.req.header('Idempotency-Key') ?? '',
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/admin/users/{id}/ban',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(adminBanSchema) },
      responses: { 200: json(adminUserSchema, 'Banned user; active authority revoked'), ...errors },
    }),
    async (c) => {
      const input = c.req.valid('json')
      return c.json(
        await adminUserChange(
          deps,
          principalOf(c),
          c.req.valid('param').id,
          {
            expectedVersion: input.expectedVersion,
            ban: { reason: input.reason, until: input.until },
          },
          c.req.header('Idempotency-Key') ?? '',
        ),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/admin/users/{id}/unban',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(expectedVersionSchema) },
      responses: {
        200: json(adminUserSchema, 'Unbanned user; old devices remain revoked'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await adminUserChange(
          deps,
          principalOf(c),
          c.req.valid('param').id,
          { ...c.req.valid('json'), ban: false },
          c.req.header('Idempotency-Key') ?? '',
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/admin/users/{id}/verify-email',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(expectedVersionSchema) },
      responses: { 200: json(adminUserSchema, 'Verified confirmed account; audited'), ...errors },
    }),
    async (c) =>
      c.json(
        await adminUserChange(
          deps,
          principalOf(c),
          c.req.valid('param').id,
          { ...c.req.valid('json'), verify: true },
          c.req.header('Idempotency-Key') ?? '',
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/invites',
      tags: ['admin'],
      security,
      request: { query: adminPageQuerySchema },
      responses: { 200: json(adminInvitesSchema, 'Invite metadata; no codes'), ...errors },
    }),
    async (c) =>
      c.json(
        adminInvitesSchema.parse(
          await adminCatalog(deps, principalOf(c), 'invites', c.req.valid('query')),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/admin/invites/{id}/revoke',
      tags: ['admin'],
      security,
      request: { params: idParam },
      responses: { 200: json(okResponseSchema, 'Invite revoked'), ...errors },
    }),
    async (c) => {
      await adminRevokeInvite(
        deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.header('Idempotency-Key') ?? '',
      )
      return c.json({ status: 'ok' as const }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/conversations',
      tags: ['admin'],
      security,
      request: { query: adminPageQuerySchema },
      responses: { 200: json(adminConversationsSchema, 'Channel/group metadata only'), ...errors },
    }),
    async (c) =>
      c.json(
        adminConversationsSchema.parse(
          await adminCatalog(deps, principalOf(c), 'conversations', c.req.valid('query')),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/admin/conversations/{id}/archive',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(expectedVersionSchema) },
      responses: { 200: json(okResponseSchema, 'Archived'), ...errors },
    }),
    async (c) => {
      const key = c.req.header('Idempotency-Key') ?? ''
      assertIdempotencyKey(key)
      await adminArchive(
        deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('json').expectedVersion,
        key,
      )
      return c.json({ status: 'ok' as const }, 200)
    },
  )
  const restore = restoreConversationRequestSchema.extend({
    expectedVersion: z.number().int().positive(),
  })
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/admin/conversations/{id}/restore',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(restore) },
      responses: { 200: json(okResponseSchema, 'Restored after ownership validation'), ...errors },
    }),
    async (c) => {
      const key = c.req.header('Idempotency-Key') ?? ''
      assertIdempotencyKey(key)
      const { expectedVersion, ...input } = c.req.valid('json')
      await adminRestore(deps, principalOf(c), c.req.valid('param').id, input, expectedVersion, key)
      return c.json({ status: 'ok' as const }, 200)
    },
  )
  const bans = z
    .object({
      bans: z.array(
        z.object({ id: z.uuid(), name: z.string(), reason: z.string().nullable() }).strict(),
      ),
    })
    .strict()
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/conversations/{id}/bans',
      tags: ['admin'],
      security,
      request: { params: idParam },
      responses: { 200: json(bans, 'Conversation ban list'), ...errors },
    }),
    async (c) => c.json(await adminBans(deps, principalOf(c), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/admin/conversations/{id}/unban',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(z.object({ userId: z.uuid() }).strict()) },
      responses: { 200: json(okResponseSchema, 'Conversation ban lifted'), ...errors },
    }),
    async (c) => {
      assertIdempotencyKey(c.req.header('Idempotency-Key') ?? '')
      await adminUnban(deps, principalOf(c), c.req.valid('param').id, c.req.valid('json').userId)
      return c.json({ status: 'ok' as const }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/reports',
      tags: ['reports'],
      security,
      request: { body: body(reportRequestSchema) },
      responses: {
        200: json(reportReceiptSchema, 'Report accepted or original receipt'),
        ...errors,
      },
    }),
    async (c) => {
      await services.limiter.enforce([
        { policy: POLICIES.reportUser, subject: principalOf(c).userId },
      ])
      return c.json(
        await submitReport(
          deps,
          principalOf(c),
          c.req.valid('json'),
          c.req.header('Idempotency-Key') ?? '',
        ),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/reports',
      tags: ['admin'],
      security,
      request: { query: adminPageQuerySchema },
      responses: { 200: json(adminReportsSchema, 'Report list'), ...errors },
    }),
    async (c) =>
      c.json(
        adminReportsSchema.parse(
          await adminCatalog(deps, principalOf(c), 'reports', c.req.valid('query')),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/reports/{id}/context',
      tags: ['admin'],
      security,
      request: { params: idParam },
      responses: {
        200: json(reportContextSchema, 'Audited report context, at most five messages either side'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(await viewReportContext(deps, principalOf(c), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/admin/reports/{id}',
      tags: ['admin'],
      security,
      request: { params: idParam, body: body(reportUpdateSchema) },
      responses: { 200: json(okResponseSchema, 'Report decision recorded'), ...errors },
    }),
    async (c) => {
      await decideReport(
        deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('json'),
        c.req.header('Idempotency-Key') ?? '',
      )
      return c.json({ status: 'ok' as const }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/audit-logs',
      tags: ['admin'],
      security,
      request: { query: adminPageQuerySchema },
      responses: {
        200: json(adminAuditLogsSchema, 'Audit actions; no body, credential or device fields'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        adminAuditLogsSchema.parse(
          await adminCatalog(deps, principalOf(c), 'audit', c.req.valid('query')),
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/ai-usage',
      tags: ['admin'],
      security,
      responses: { 200: json(adminUsageSchema, 'AI accounting summary'), ...errors },
    }),
    async (c) => c.json(await adminUsage(deps, principalOf(c)), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/settings',
      tags: ['admin'],
      security,
      responses: {
        200: json(siteSettingsSchema, 'Current policy; no provider secrets'),
        ...errors,
      },
    }),
    async (c) => c.json(await adminSettings(deps, principalOf(c)), 200),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/admin/settings',
      tags: ['admin'],
      security,
      request: { body: body(siteSettingsUpdateSchema) },
      responses: { 200: json(siteSettingsSchema, 'Versioned policy saved'), ...errors },
    }),
    async (c) =>
      c.json(
        await updateAdminSettings(
          deps,
          principalOf(c),
          c.req.valid('json'),
          c.req.header('Idempotency-Key') ?? '',
        ),
        200,
      ),
  )
}
