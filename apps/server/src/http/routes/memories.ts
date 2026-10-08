import {
  addMemorySchema,
  editMemoryPrivacySchema,
  memoryListSchema,
  memoryResponseSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import { addMemory, deleteMemory, listMemories, setMemoryPrivacy } from '../../domain/memories.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, idParam, json } from './helpers.ts'

export function memoryRoutes(app: OpenAPIHono<HttpEnv>, services: Services) {
  app.use('/api/me/memories', requireSession(services))
  app.use('/api/me/memories/*', requireSession(services))
  const limitWrite = async (c: import('hono').Context<HttpEnv>, next: import('hono').Next) => {
    if (c.req.method !== 'GET')
      await services.limiter.enforce([
        { policy: POLICIES.memoryWriteUser, subject: principalOf(c).userId },
      ])
    await next()
  }
  app.use('/api/me/memories', limitWrite)
  app.use('/api/me/memories/*', limitWrite)
  const errors = {
    ...accessErrors,
    409: err('Memory changed'),
    422: err('Invalid memory'),
    429: err('Memory limit reached'),
  }
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/me/memories',
      tags: ['memories'],
      security: [{ cookieAuth: [] }],
      responses: { 200: json(memoryListSchema, 'My saved memories'), ...errors },
    }),
    async (c) => c.json({ memories: await listMemories(services.deps, principalOf(c)) }, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/me/memories',
      tags: ['memories'],
      security: [{ cookieAuth: [] }],
      request: { body: json(addMemorySchema, 'Memory and explicit privacy choice') },
      responses: { 201: json(memoryResponseSchema, 'Saved memory'), ...errors },
    }),
    async (c) =>
      c.json({ memory: await addMemory(services.deps, principalOf(c), c.req.valid('json')) }, 201),
  )
  app.openapi(
    createRoute({
      method: 'patch',
      path: '/api/me/memories/{id}',
      tags: ['memories'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam, body: json(editMemoryPrivacySchema, 'Explicit site consent') },
      responses: { 200: json(memoryResponseSchema, 'Updated consent'), ...errors },
    }),
    async (c) =>
      c.json(
        {
          memory: await setMemoryPrivacy(
            services.deps,
            principalOf(c),
            c.req.valid('param').id,
            c.req.valid('json'),
          ),
        },
        200,
      ),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/me/memories/{id}',
      tags: ['memories'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: { 200: json(memoryResponseSchema, 'Deleted memory'), ...errors },
    }),
    async (c) =>
      c.json(
        { memory: await deleteMemory(services.deps, principalOf(c), c.req.valid('param').id) },
        200,
      ),
  )
}
