/**
 * The calls that create, join, change and leave conversations (docs/05 section 3.2 and 3.3). Each answer about a
 * conversation goes into the engine's cache through its version merge, so the sidebar and the open screen follow at once
 * without waiting for the hint. Errors are the caller's: a dialog puts them next to the field they belong to.
 *
 * Every write goes through `forScreen` (D-174): what comes back is for the person who asked and the membership the request
 * was about, and when they are not here any more the answer is null (and a failure is swallowed): the screen then does
 * nothing, no jump, no message. A write with nothing to return answers `true`.
 */
import {
  type AddMembersRequest,
  type AddMembersResponse,
  addMembersResponseSchema,
  type Ban,
  type BanRequest,
  type BansResponse,
  banSchema,
  bansResponseSchema,
  type ChannelsPage,
  type Conversation,
  type ConversationInvite,
  type ConversationInvitePreview,
  type ConversationListResponse,
  type CreateConversationInviteRequest,
  type CreateConversationRequest,
  type CreatedConversationInvite,
  channelsPageSchema,
  conversationInvitePreviewSchema,
  conversationInvitesResponseSchema,
  conversationListResponseSchema,
  conversationSchema,
  createdConversationInviteSchema,
  type Member,
  type MembersPage,
  memberSchema,
  membersPageSchema,
  okResponseSchema,
  type PatchConversationMeRequest,
  type PatchConversationRequest,
  type PatchMemberRequest,
  type RestoreConversationRequest,
  type TransferRequest,
  type UserProfile,
  type UserSummary,
  userProfileSchema,
  userSearchResponseSchema,
} from '@chatapp/contracts'
import { engine, forScreen } from '@/app/sync.ts'
import { api } from '@/lib/api.ts'

/** The answer goes into the cache, and to the screen, only while the request is still for the screen (D-171, D-174). */
const conversationWrite = (
  conversationId: string | null,
  request: () => Promise<Conversation>,
): Promise<Conversation | null> =>
  forScreen(conversationId, request, (conversation, ticket) =>
    engine.ingestConversation(conversation, ticket),
  )

// ───────── Creating and opening ─────────

/** `key` stays the same for the same request body, so a double click gives one conversation (docs/05 section 1). */
export const createConversation = (
  request: CreateConversationRequest,
  key: string,
): Promise<Conversation | null> =>
  conversationWrite(null, () =>
    api('/api/conversations', {
      method: 'POST',
      json: request,
      schema: conversationSchema,
      idempotencyKey: key,
    }),
  )

export const openDm = (userId: string): Promise<Conversation | null> =>
  conversationWrite(null, () =>
    api('/api/conversations/dm', { method: 'POST', json: { userId }, schema: conversationSchema }),
  )

export const joinConversation = (id: string): Promise<Conversation | null> =>
  conversationWrite(null, () =>
    api(`/api/conversations/${id}/join`, { method: 'POST', json: {}, schema: conversationSchema }),
  )

/**
 * Leaving is accepted by the server: the conversation leaves the cache at once (the tombstone follows through my log). The
 * question whether the answer is still for the screen is asked before the cache forgets the membership it is about.
 */
export const leaveConversation = (id: string): Promise<true | null> =>
  forScreen(
    id,
    async () => {
      await api(`/api/conversations/${id}/leave`, {
        method: 'POST',
        json: {},
        schema: okResponseSchema,
      })
      return true as const
    },
    (_answer, ticket) => engine.leftConversation(id, ticket),
  )

// ───────── Changing one ─────────

export const patchConversation = (
  id: string,
  request: PatchConversationRequest,
): Promise<Conversation | null> =>
  conversationWrite(id, () =>
    api(`/api/conversations/${id}`, { method: 'PATCH', json: request, schema: conversationSchema }),
  )

/** My own settings for one conversation (pin, mute, hide). */
export const patchMyState = (
  id: string,
  request: PatchConversationMeRequest,
): Promise<Conversation | null> =>
  conversationWrite(id, () =>
    api(`/api/conversations/${id}/me`, {
      method: 'PATCH',
      json: request,
      schema: conversationSchema,
    }),
  )

export const archiveConversation = (id: string): Promise<Conversation | null> =>
  conversationWrite(id, () =>
    api(`/api/conversations/${id}/archive`, {
      method: 'POST',
      json: {},
      schema: conversationSchema,
    }),
  )

/** An archived conversation is not in my list, so the request is about the account, not about a membership I hold. */
export const restoreConversation = (
  id: string,
  request: RestoreConversationRequest,
): Promise<Conversation | null> =>
  conversationWrite(null, () =>
    api(`/api/conversations/${id}/restore`, {
      method: 'POST',
      json: request,
      schema: conversationSchema,
    }),
  )

export const transferOwnership = (
  id: string,
  request: TransferRequest,
): Promise<Conversation | null> =>
  conversationWrite(id, () =>
    api(`/api/conversations/${id}/transfer`, {
      method: 'POST',
      json: request,
      schema: conversationSchema,
    }),
  )

// ───────── Lists ─────────

export async function listChannels(query: {
  query?: string
  cursor?: string
}): Promise<ChannelsPage> {
  const params = new URLSearchParams({ limit: '20' })
  if (query.query) params.set('query', query.query)
  if (query.cursor) params.set('cursor', query.cursor)
  const ticket = engine.ticket()
  const page = await api(`/api/channels?${params}`, { schema: channelsPageSchema })
  for (const conversation of page.items) engine.ingestConversation(conversation, ticket)
  return page
}

export async function listArchived(): Promise<Conversation[]> {
  const response: ConversationListResponse = await api('/api/conversations?archived=true', {
    schema: conversationListResponseSchema,
  })
  return response.conversations
}

export async function searchUsers(query: string, signal?: AbortSignal): Promise<UserSummary[]> {
  const ticket = engine.ticket()
  const response = await api(`/api/users?${new URLSearchParams({ query })}`, {
    schema: userSearchResponseSchema,
    signal,
  })
  engine.ingestUsers(response.users, ticket)
  return response.users
}

export async function getProfile(userId: string): Promise<UserProfile> {
  const ticket = engine.ticket()
  const profile = await api(`/api/users/${userId}`, { schema: userProfileSchema })
  engine.ingestUsers([profile], ticket)
  return profile
}

// ───────── Members, bans and links ─────────

export async function listMembers(id: string, cursor?: string): Promise<MembersPage> {
  const params = new URLSearchParams({ limit: '50' })
  if (cursor) params.set('cursor', cursor)
  const ticket = engine.ticket()
  const page = await api(`/api/conversations/${id}/members?${params}`, {
    schema: membersPageSchema,
  })
  engine.ingestUsers(
    page.members.map((member) => member.user),
    ticket,
  )
  return page
}

export const addMembers = (
  id: string,
  request: AddMembersRequest,
): Promise<AddMembersResponse | null> =>
  forScreen(
    id,
    () =>
      api(`/api/conversations/${id}/members`, {
        method: 'POST',
        json: request,
        schema: addMembersResponseSchema,
      }),
    (response, ticket) => engine.ingestUsers(response.added, ticket),
  )

export const patchMember = (
  id: string,
  userId: string,
  request: PatchMemberRequest,
): Promise<Member | null> =>
  forScreen(id, () =>
    api(`/api/conversations/${id}/members/${userId}`, {
      method: 'PATCH',
      json: request,
      schema: memberSchema,
    }),
  )

export const removeMember = (id: string, userId: string): Promise<true | null> =>
  forScreen(id, async () => {
    await api(`/api/conversations/${id}/members/${userId}`, {
      method: 'DELETE',
      schema: okResponseSchema,
    })
    return true as const
  })

export async function listBans(id: string): Promise<Ban[]> {
  const ticket = engine.ticket()
  const response: BansResponse = await api(`/api/conversations/${id}/bans`, {
    schema: bansResponseSchema,
  })
  engine.ingestUsers(
    response.bans.map((ban) => ban.user),
    ticket,
  )
  return response.bans
}

export const banMember = (id: string, request: BanRequest): Promise<Ban | null> =>
  forScreen(id, () =>
    api(`/api/conversations/${id}/bans`, { method: 'POST', json: request, schema: banSchema }),
  )

export const liftBan = (id: string, userId: string): Promise<true | null> =>
  forScreen(id, async () => {
    await api(`/api/conversations/${id}/bans/${userId}`, {
      method: 'DELETE',
      schema: okResponseSchema,
    })
    return true as const
  })

export async function listInvites(id: string): Promise<ConversationInvite[]> {
  const response = await api(`/api/conversations/${id}/invites`, {
    schema: conversationInvitesResponseSchema,
  })
  return response.invites
}

/** The plaintext link code is in this answer and nowhere else (D-128): show it now. */
export const createInvite = (
  id: string,
  request: CreateConversationInviteRequest,
): Promise<CreatedConversationInvite | null> =>
  forScreen(id, () =>
    api(`/api/conversations/${id}/invites`, {
      method: 'POST',
      json: request,
      schema: createdConversationInviteSchema,
    }),
  )

export const revokeInvite = (id: string, inviteId: string): Promise<true | null> =>
  forScreen(id, async () => {
    await api(`/api/conversations/${id}/invites/${inviteId}`, {
      method: 'DELETE',
      schema: okResponseSchema,
    })
    return true as const
  })

/** The code goes in the body, never in the URL (D-045). */
export const previewInvite = (code: string): Promise<ConversationInvitePreview> =>
  api('/api/conversation-invites/preview', {
    method: 'POST',
    json: { code },
    schema: conversationInvitePreviewSchema,
  })

export const acceptInvite = (code: string): Promise<Conversation | null> =>
  conversationWrite(null, () =>
    api('/api/conversation-invites/accept', {
      method: 'POST',
      json: { code },
      schema: conversationSchema,
    }),
  )
