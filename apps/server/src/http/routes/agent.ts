import {
  agentRunDetailSchema,
  agentRunRequestSchema,
  agentRunResponseSchema,
  agentUsageSchema,
  messageSearchQuerySchema,
  messageSearchResponseSchema,
  okResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { getAgentUsage } from '../../domain/agent-budget.ts'
import {
  cancelAgentRun,
  createAgentRun,
  deleteAgentConversation,
  getAgentRun,
  regenerateAgentRun,
} from '../../domain/agent-runs.ts'
import { searchMessages } from '../../domain/search.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
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
