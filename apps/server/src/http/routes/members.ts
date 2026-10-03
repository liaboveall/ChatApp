/** Members, bans and group invitation links of a conversation (docs/05 section 3.3). */
import {
  addMembersRequestSchema,
  addMembersResponseSchema,
  banRequestSchema,
  banSchema,
  bansResponseSchema,
  conversationInviteCodeRequestSchema,
  conversationInvitePreviewSchema,
  conversationInvitesResponseSchema,
  conversationSchema,
  createConversationInviteRequestSchema,
  createdConversationInviteSchema,
  memberSchema,
  membersPageSchema,
  membersQuerySchema,
  okResponseSchema,
  patchMemberRequestSchema,
} from '@chatapp/contracts'
import { createRoute, type OpenAPIHono, z } from '@hono/zod-openapi'
import {
  acceptConversationInvite,
  createConversationInvite,
  listConversationInvites,
  previewConversationInvite,
  revokeConversationInvite,
} from '../../domain/conversation-invites.ts'
import {
  addConversationMembers,
  banConversationMember,
  listBans,
  listMembers,
  removeConversationMember,
  unbanConversationMember,
  updateConversationMember,
} from '../../domain/members.ts'
import type { HttpEnv, Services } from '../context.ts'
import { principalOf, requireSession } from '../middleware/session.ts'
import { POLICIES } from '../policies.ts'
import { accessErrors, err, idParam, json } from './helpers.ts'

const body = <T extends z.ZodType>(schema: T) => ({
  required: true as const,
  content: { 'application/json': { schema } },
})
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() })
const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() })

const listMembersRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/members',
  tags: ['members'],
  summary:
    'Members: owner, administrators, then in order of joining; pages share one membership version',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, query: membersQuerySchema },
  responses: {
    200: json(membersPageSchema, 'A page of members'),
    409: err('The member list changed while paging (VERSION_CONFLICT)'),
    422: err('The cursor does not belong to this list'),
    ...accessErrors,
  },
})

const addMembersRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/members',
  tags: ['members'],
  summary: 'Add people; banned people are skipped and the answer says why',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(addMembersRequestSchema) },
  responses: {
    200: json(addMembersResponseSchema, 'Who was added and who was skipped'),
    409: err('The member list changed, or the conversation is archived'),
    ...accessErrors,
  },
})

const patchMemberRoute = createRoute({
  method: 'patch',
  path: '/api/conversations/{id}/members/{userId}',
  tags: ['members'],
  summary: 'Appoint or dismiss an administrator (owner), silence or unsilence a member',
  security: [{ cookieAuth: [] }],
  request: { params: memberParams, body: body(patchMemberRequestSchema) },
  responses: {
    200: json(memberSchema, 'The member after the change'),
    409: err('The member list changed, or the conversation is archived'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const removeMemberRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}/members/{userId}',
  tags: ['members'],
  summary: 'Remove a member without banning',
  security: [{ cookieAuth: [] }],
  request: { params: memberParams },
  responses: { 200: json(okResponseSchema, 'Removed'), 409: err('Archived'), ...accessErrors },
})

const listBansRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/bans',
  tags: ['members'],
  summary: 'The ban list (administrators)',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(bansResponseSchema, 'Bans'), ...accessErrors },
})

const banRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/bans',
  tags: ['members'],
  summary: 'Remove and ban, or ban somebody who is not (or no longer) a member',
  security: [{ cookieAuth: [] }],
  request: { params: idParam, body: body(banRequestSchema) },
  responses: {
    200: json(banSchema, 'Banned'),
    409: err('The member list changed, or the conversation is archived'),
    422: err('Validation failed'),
    ...accessErrors,
  },
})

const unbanRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}/bans/{userId}',
  tags: ['members'],
  summary: 'Lift a ban',
  security: [{ cookieAuth: [] }],
  request: { params: memberParams },
  responses: { 200: json(okResponseSchema, 'Lifted (or there was none)'), ...accessErrors },
})

const createInviteRoute = createRoute({
  method: 'post',
  path: '/api/conversations/{id}/invites',
  tags: ['invitations'],
  summary: 'Create a group invitation link; the plaintext code is returned once',
  security: [{ cookieAuth: [] }],
  request: {
    params: idParam,
    body: {
      required: false,
      content: { 'application/json': { schema: createConversationInviteRequestSchema } },
    },
  },
  responses: {
    201: json(createdConversationInviteSchema, 'Created'),
    409: err('Archived'),
    ...accessErrors,
  },
})

const listInvitesRoute = createRoute({
  method: 'get',
  path: '/api/conversations/{id}/invites',
  tags: ['invitations'],
  summary: 'Invitation links: all of them for administrators, my own for members',
  security: [{ cookieAuth: [] }],
  request: { params: idParam },
  responses: { 200: json(conversationInvitesResponseSchema, 'Links'), ...accessErrors },
})

const revokeInviteRoute = createRoute({
  method: 'delete',
  path: '/api/conversations/{id}/invites/{inviteId}',
  tags: ['invitations'],
  summary: 'Revoke a link (its creator or an administrator)',
  security: [{ cookieAuth: [] }],
  request: { params: inviteParams },
  responses: { 200: json(okResponseSchema, 'Revoked'), ...accessErrors },
})

const previewRoute = createRoute({
  method: 'post',
  path: '/api/conversation-invites/preview',
  tags: ['invitations'],
  summary: 'What an invitation link leads to; the code travels in the body, never in the URL',
  security: [{ cookieAuth: [] }],
  request: { body: body(conversationInviteCodeRequestSchema) },
  responses: {
    200: json(conversationInvitePreviewSchema, 'Preview'),
    400: err('Invalid, expired, used up or revoked'),
    ...accessErrors,
  },
})

const acceptRoute = createRoute({
  method: 'post',
  path: '/api/conversation-invites/accept',
  tags: ['invitations'],
  summary: 'Join the group an invitation link belongs to',
  security: [{ cookieAuth: [] }],
  request: { body: body(conversationInviteCodeRequestSchema) },
  responses: {
    200: json(conversationSchema, 'Joined (or already a member)'),
    400: err('Invalid, expired, used up or revoked'),
    ...accessErrors,
  },
})

export function memberRoutes(app: OpenAPIHono<HttpEnv>, services: Services): void {
  const { deps, limiter } = services
  const guard = requireSession(services)
  // `/api/conversations/*` is already guarded by conversationRoutes; the invitation endpoints live elsewhere.
  app.use('/api/conversation-invites/*', guard)

  app.openapi(listMembersRoute, async (c) =>
    c.json(
      await listMembers(deps, principalOf(c), c.req.valid('param').id, c.req.valid('query')),
      200,
    ),
  )

  app.openapi(addMembersRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.membersAddUser, subject: principal.userId }])
    return c.json(
      await addConversationMembers(deps, principal, c.req.valid('param').id, c.req.valid('json')),
      200,
    )
  })

  app.openapi(patchMemberRoute, async (c) => {
    const { id, userId } = c.req.valid('param')
    return c.json(
      await updateConversationMember(deps, principalOf(c), id, userId, c.req.valid('json')),
      200,
    )
  })

  app.openapi(removeMemberRoute, async (c) => {
    const { id, userId } = c.req.valid('param')
    await removeConversationMember(deps, principalOf(c), id, userId)
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(listBansRoute, async (c) =>
    c.json(await listBans(deps, principalOf(c), c.req.valid('param').id), 200),
  )

  app.openapi(banRoute, async (c) =>
    c.json(
      await banConversationMember(
        deps,
        principalOf(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      ),
      200,
    ),
  )

  app.openapi(unbanRoute, async (c) => {
    const { id, userId } = c.req.valid('param')
    await unbanConversationMember(deps, principalOf(c), id, userId)
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(createInviteRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.conversationInviteUser, subject: principal.userId }])
    const input = c.req.valid('json') ?? {}
    return c.json(
      await createConversationInvite(deps, principal, c.req.valid('param').id, input),
      201,
    )
  })

  app.openapi(listInvitesRoute, async (c) => {
    const invites = await listConversationInvites(deps, principalOf(c), c.req.valid('param').id)
    return c.json({ invites }, 200)
  })

  app.openapi(revokeInviteRoute, async (c) => {
    const { id, inviteId } = c.req.valid('param')
    await revokeConversationInvite(deps, principalOf(c), id, inviteId)
    return c.json({ status: 'ok' as const }, 200)
  })

  app.openapi(previewRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.conversationInviteUser, subject: principal.userId }])
    return c.json(await previewConversationInvite(deps, principal, c.req.valid('json').code), 200)
  })

  app.openapi(acceptRoute, async (c) => {
    const principal = principalOf(c)
    await limiter.enforce([{ policy: POLICIES.conversationInviteUser, subject: principal.userId }])
    return c.json(await acceptConversationInvite(deps, principal, c.req.valid('json').code), 200)
  })
}
