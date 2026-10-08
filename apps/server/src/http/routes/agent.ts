import {
  adminAgentRunDetailSchema,
  adminAgentRunListSchema,
  adminAgentRunQuerySchema,
  agentApprovalDecisionSchema,
  agentApprovalListQuerySchema,
  agentApprovalListSchema,
  agentApprovalResponseSchema,
  agentContextResponseSchema,
  agentKeySourceRequestSchema,
  agentRunDetailSchema,
  agentRunRequestSchema,
  agentRunResponseSchema,
  agentUsageSchema,
  messageSearchQuerySchema,
  messageSearchResponseSchema,
  okResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { adminRunDetail, listAdminRuns } from '../../domain/agent-admin.ts'
import { decideApproval, listApprovals } from '../../domain/agent-approvals.ts'
import { getAgentUsage } from '../../domain/agent-budget.ts'
import {
  cancelAgentRun,
  createAgentRun,
  deleteAgentConversation,
  getAgentContext,
  getAgentRun,
  regenerateAgentRun,
  switchAgentKeySource,
} from '../../domain/agent-runs.ts'
import { searchMessages } from '../../domain/search.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, idParam, json } from './helpers.ts'

const errors = {
  ...accessErrors,
  409: err('State or context changed'),
  422: err('Invalid request'),
  503: err('Model budget or service unavailable'),
}
export function agentRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps } = services
  app.use('/api/agent/*', requireSession(services))
  app.use('/api/search/messages', requireSession(services))
  app.use('/api/admin/agent-runs', requireSession(services))
  app.use('/api/admin/agent-runs/*', requireSession(services))
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/agent/conversations/{id}/context',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: {
        200: json(agentContextResponseSchema, 'Current private assistant segment'),
        ...errors,
      },
    }),
    async (c) => c.json(await getAgentContext(deps, principalOf(c), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/agent-runs',
      tags: ['admin'],
      security: [{ cookieAuth: [] }],
      request: { query: adminAgentRunQuerySchema },
      responses: { 200: json(adminAgentRunListSchema, 'Run metadata, newest first'), ...errors },
    }),
    async (c) => c.json(await listAdminRuns(deps, principalOf(c), c.req.valid('query')), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/admin/agent-runs/{id}',
      tags: ['admin'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: {
        200: json(
          adminAgentRunDetailSchema,
          'Content only for site-key runs in retention; audited',
        ),
        ...errors,
      },
    }),
    async (c) => c.json(await adminRunDetail(deps, principalOf(c), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/agent/runs',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: agentRunRequestSchema } },
        },
      },
      responses: {
        200: json(agentRunResponseSchema, 'Queued run, or idempotent replay'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        {
          run: await createAgentRun(
            deps,
            principalOf(c),
            c.req.valid('json'),
            c.req.header('Idempotency-Key') ?? '',
          ),
        },
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/agent/runs/{id}',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: { 200: json(agentRunDetailSchema, 'Owner-only run and tool steps'), ...errors },
    }),
    async (c) => c.json(await getAgentRun(deps, principalOf(c), c.req.valid('param').id), 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/agent/runs/{id}/cancel',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: { 200: json(agentRunResponseSchema, 'Durably cancelled'), ...errors },
    }),
    async (c) =>
      c.json({ run: await cancelAgentRun(deps, principalOf(c), c.req.valid('param').id) }, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/agent/runs/{id}/regenerate',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: {
        200: json(agentRunResponseSchema, 'New run bound to the original reply'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        {
          run: await regenerateAgentRun(
            deps,
            principalOf(c),
            c.req.valid('param').id,
            c.req.header('Idempotency-Key') ?? '',
          ),
        },
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/agent/conversations/{id}/key-source',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: {
        params: idParam,
        body: {
          required: true,
          content: { 'application/json': { schema: agentKeySourceRequestSchema } },
        },
      },
      responses: {
        200: json(agentContextResponseSchema, 'A blank segment with the chosen key source'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        await switchAgentKeySource(
          deps,
          principalOf(c),
          c.req.valid('param').id,
          c.req.valid('json').keySource,
        ),
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/agent/approvals',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: { query: agentApprovalListQuerySchema },
      responses: {
        200: json(agentApprovalListSchema, 'My approval requests in this state, newest first'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(
        { approvals: await listApprovals(deps, principalOf(c), c.req.valid('query').status) },
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/agent/approvals/{id}',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: {
        params: idParam,
        body: {
          required: true,
          content: { 'application/json': { schema: agentApprovalDecisionSchema } },
        },
      },
      responses: {
        200: json(agentApprovalResponseSchema, 'Decided; the run resumes when nothing is open'),
        ...errors,
      },
    }),
    async (c) => {
      const principal = principalOf(c)
      await services.limiter.enforce([
        { policy: POLICIES.approvalDecideUser, subject: principal.userId },
      ])
      return c.json(
        await decideApproval(deps, principal, c.req.valid('param').id, c.req.valid('json')),
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/agent/usage',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      responses: {
        200: json(agentUsageSchema, 'Own usage and shared remaining budget'),
        ...errors,
      },
    }),
    async (c) => c.json(await getAgentUsage(deps, principalOf(c)), 200),
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/search/messages',
      tags: ['search'],
      security: [{ cookieAuth: [] }],
      request: { query: messageSearchQuerySchema },
      responses: { 200: json(messageSearchResponseSchema, 'Authorized keyword hits'), ...errors },
    }),
    async (c) => c.json(await searchMessages(deps, principalOf(c), c.req.valid('query')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/conversations/{id}',
      tags: ['agent'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: {
        200: json(okResponseSchema, 'Assistant conversation and content removed'),
        ...errors,
      },
    }),
    async (c) => {
      await deleteAgentConversation(deps, principalOf(c), c.req.valid('param').id)
      return c.json({ status: 'ok' as const }, 200)
    },
  )
}
