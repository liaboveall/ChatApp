/**
 * The calls that create, join, change and leave conversations (docs/05 section 3.2 and 3.3). Each answer about a
 * conversation goes into the engine's cache through its version merge, so the sidebar and the open screen follow at once
 * without waiting for the hint. Errors are the caller's: a dialog puts them next to the field they belong to.
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
import { engine } from '@/app/sync.ts'
import { api } from '@/lib/api.ts'

/**
 * The answer goes into the cache, unless the account changed while the request was out: `ticket` is taken before the
 * request is made and checked when the answer comes (D-171).
 */
async function conversationAnswer(request: () => Promise<Conversation>): Promise<Conversation> {
  const ticket = engine.ticket()
  const conversation = await request()
  engine.ingestConversation(conversation, ticket)
  return conversation
}

// ───────── Creating and opening ─────────

/** `key` stays the same for the same request body, so a double click gives one conversation (docs/05 section 1). */
export const createConversation = (
  request: CreateConversationRequest,
  key: string,
): Promise<Conversation> =>
  conversationAnswer(() =>
    api('/api/conversations', {
      method: 'POST',
      json: request,
      schema: conversationSchema,
      idempotencyKey: key,
    }),
  )

export const openDm = (userId: string): Promise<Conversation> =>
  conversationAnswer(() =>
    api('/api/conversations/dm', { method: 'POST', json: { userId }, schema: conversationSchema }),
  )

export const joinConversation = (id: string): Promise<Conversation> =>
  conversationAnswer(() =>
    api(`/api/conversations/${id}/join`, { method: 'POST', json: {}, schema: conversationSchema }),
  )

/** Leaving is accepted by the server: the conversation leaves the cache at once (the tombstone follows through my log). */
export async function leaveConversation(id: string): Promise<void> {
  const ticket = engine.ticket(id)
  await api(`/api/conversations/${id}/leave`, {
    method: 'POST',
    json: {},
    schema: okResponseSchema,
  })
  engine.leftConversation(id, ticket)
}

// ───────── Changing one ─────────

export const patchConversation = (
  id: string,
  request: PatchConversationRequest,
): Promise<Conversation> =>
  conversationAnswer(() =>
    api(`/api/conversations/${id}`, { method: 'PATCH', json: request, schema: conversationSchema }),
  )

/** My own settings for one conversation (pin, mute, hide). */
export const patchMyState = (
  id: string,
  request: PatchConversationMeRequest,
): Promise<Conversation> =>
  conversationAnswer(() =>
    api(`/api/conversations/${id}/me`, {
      method: 'PATCH',
      json: request,
      schema: conversationSchema,
    }),
  )

export const archiveConversation = (id: string): Promise<Conversation> =>
  conversationAnswer(() =>
    api(`/api/conversations/${id}/archive`, {
      method: 'POST',
      json: {},
      schema: conversationSchema,
    }),
  )

export const restoreConversation = (
  id: string,
  request: RestoreConversationRequest,
): Promise<Conversation> =>
  conversationAnswer(() =>
    api(`/api/conversations/${id}/restore`, {
      method: 'POST',
      json: request,
      schema: conversationSchema,
    }),
  )

export const transferOwnership = (id: string, request: TransferRequest): Promise<Conversation> =>
  conversationAnswer(() =>
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

export async function addMembers(
  id: string,
  request: AddMembersRequest,
): Promise<AddMembersResponse> {
  const ticket = engine.ticket()
  const response = await api(`/api/conversations/${id}/members`, {
    method: 'POST',
    json: request,
    schema: addMembersResponseSchema,
  })
  engine.ingestUsers(response.added, ticket)
  return response
}

export const patchMember = (
  id: string,
  userId: string,
  request: PatchMemberRequest,
): Promise<Member> =>
  api(`/api/conversations/${id}/members/${userId}`, {
    method: 'PATCH',
    json: request,
    schema: memberSchema,
  })

export async function removeMember(id: string, userId: string): Promise<void> {
  await api(`/api/conversations/${id}/members/${userId}`, {
    method: 'DELETE',
    schema: okResponseSchema,
  })
}

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

export const banMember = (id: string, request: BanRequest): Promise<Ban> =>
  api(`/api/conversations/${id}/bans`, { method: 'POST', json: request, schema: banSchema })

export async function liftBan(id: string, userId: string): Promise<void> {
  await api(`/api/conversations/${id}/bans/${userId}`, {
    method: 'DELETE',
    schema: okResponseSchema,
  })
}

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
): Promise<CreatedConversationInvite> =>
  api(`/api/conversations/${id}/invites`, {
    method: 'POST',
    json: request,
    schema: createdConversationInviteSchema,
  })

export async function revokeInvite(id: string, inviteId: string): Promise<void> {
  await api(`/api/conversations/${id}/invites/${inviteId}`, {
    method: 'DELETE',
    schema: okResponseSchema,
  })
}

/** The code goes in the body, never in the URL (D-045). */
export const previewInvite = (code: string): Promise<ConversationInvitePreview> =>
  api('/api/conversation-invites/preview', {
    method: 'POST',
    json: { code },
    schema: conversationInvitePreviewSchema,
  })

export const acceptInvite = (code: string): Promise<Conversation> =>
  conversationAnswer(() =>
    api('/api/conversation-invites/accept', {
      method: 'POST',
      json: { code },
      schema: conversationSchema,
    }),
  )
