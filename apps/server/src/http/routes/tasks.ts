/** The person's reminders and scheduled messages (docs/05 section 3.6, M5a): list and cancel; nothing else is editable. */
import {
  reminderListSchema,
  reminderResponseSchema,
  scheduledMessageListSchema,
  scheduledMessageResponseSchema,
  taskListQuerySchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi'
import {
  cancelReminder,
  cancelScheduledMessage,
  listReminders,
  listScheduledMessages,
} from '../../domain/tasks.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, idParam, json } from './helpers.ts'

const errors = { ...accessErrors, 422: err('Invalid request') }

export function taskRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps } = services
  for (const path of [
    '/api/reminders',
    '/api/reminders/*',
    '/api/scheduled-messages',
    '/api/scheduled-messages/*',
  ])
    app.use(path, requireSession(services))
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/reminders',
      tags: ['tasks'],
      security: [{ cookieAuth: [] }],
      request: { query: taskListQuerySchema },
      responses: { 200: json(reminderListSchema, 'My reminders, newest first'), ...errors },
    }),
    async (c) => c.json(await listReminders(deps, principalOf(c), c.req.valid('query')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/reminders/{id}',
      tags: ['tasks'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: {
        200: json(reminderResponseSchema, 'Cancelled, or its end state if it already ended'),
        ...errors,
      },
    }),
    async (c) => {
      const principal = principalOf(c)
      await services.limiter.enforce([
        { policy: POLICIES.taskCancelUser, subject: principal.userId },
      ])
      return c.json(
        { reminder: await cancelReminder(deps, principal, c.req.valid('param').id) },
        200,
      )
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/scheduled-messages',
      tags: ['tasks'],
      security: [{ cookieAuth: [] }],
      request: { query: taskListQuerySchema },
      responses: {
        200: json(scheduledMessageListSchema, 'My scheduled messages, newest first'),
        ...errors,
      },
    }),
    async (c) =>
      c.json(await listScheduledMessages(deps, principalOf(c), c.req.valid('query')), 200),
  )
  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/scheduled-messages/{id}',
      tags: ['tasks'],
      security: [{ cookieAuth: [] }],
      request: { params: idParam },
      responses: {
        200: json(
          scheduledMessageResponseSchema,
          'Cancelled, or its end state if it already ended',
        ),
        ...errors,
      },
    }),
    async (c) => {
      const principal = principalOf(c)
      await services.limiter.enforce([
        { policy: POLICIES.taskCancelUser, subject: principal.userId },
      ])
      return c.json(
        {
          scheduledMessage: await cancelScheduledMessage(deps, principal, c.req.valid('param').id),
        },
        200,
      )
    },
  )
}
