/**
 * Conversation DTOs and requests (docs/05 sections 2 and 3.3). Dates are finite ISO 8601 UTC strings; "mute forever" is a
 * mode of its own, never an infinite date (D-088). Every conditional write names the version it was based on (D-082).
 */
import { z } from 'zod'
import {
  conversationKindSchema,
  memberRoleSchema,
  messageKindSchema,
  notifyLevelSchema,
} from './enums.ts'
import { conversationDescriptionSchema, conversationNameSchema } from './identity.ts'
import { LIMITS } from './limits.ts'
import { userSummarySchema } from './users.ts'

const isoDate = z.iso.datetime()
const version = z.number().int().min(0)

export const WHO_CAN_INVITE = ['all_members', 'admins_only'] as const
export const whoCanInviteSchema = z.enum(WHO_CAN_INVITE)
export type WhoCanInvite = z.infer<typeof whoCanInviteSchema>

export const conversationSettingsSchema = z.object({
  whoCanInvite: whoCanInviteSchema.optional(),
  agentEnabled: z.boolean().optional(),
})
export type ConversationSettings = z.infer<typeof conversationSettingsSchema>

export const conversationSettingsPatchSchema = z.strictObject({
  whoCanInvite: whoCanInviteSchema.optional(),
  agentEnabled: z.boolean().optional(),
})

export const muteSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('off') }),
  z.strictObject({ mode: z.literal('forever') }),
  z.strictObject({ mode: z.literal('until'), until: isoDate }),
])
export type Mute = z.infer<typeof muteSchema>

/** The signed-in user's relation to one conversation; `version` is the viewer version (docs/05 section 2). */
export const conversationMeSchema = z.object({
  version,
  role: memberRoleSchema,
  membershipId: z.uuid(),
  /** When this membership began; rewritten on re-joining (the client words the join boundary with it, D-155). */
  joinedAt: isoDate,
  visibleFromSeq: version,
  lastReadSeq: version,
  unread: version,
  notifyLevel: notifyLevelSchema,
  mute: muteSchema,
  silencedUntil: isoDate.nullable(),
  pinnedAt: isoDate.nullable(),
  hiddenAt: isoDate.nullable(),
})
export type ConversationMe = z.infer<typeof conversationMeSchema>

export const previewStateSchema = z.enum(['ok', 'recalled', 'deleted'])
export type PreviewState = z.infer<typeof previewStateSchema>

/**
 * The latest message this viewer may see. `text` is a plain-text Markdown preview, never Markdown to parse again;
 * it is empty once recalled or deleted (the client words it by `state`).
 */
export const lastMessagePreviewSchema = z.object({
  senderId: z.uuid().nullable(),
  text: z.string().nullable(),
  attachmentKind: z.enum(['image', 'video', 'audio', 'file']).nullable().optional(),
  kind: messageKindSchema,
  state: previewStateSchema,
})
export type LastMessagePreview = z.infer<typeof lastMessagePreviewSchema>

export const conversationSchema = z.object({
  id: z.uuid(),
  kind: conversationKindSchema,
  name: z.string().nullable(),
  description: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  metadataVersion: version,
  membershipVersion: version,
  /** 0 for people who are not members (channel discovery, site administrators). */
  viewerVersion: version,
  memberCount: version,
  lastSeq: version,
  lastChangeSeq: version,
  lastMessageAt: isoDate.nullable(),
  lastMessagePreview: lastMessagePreviewSchema.nullable(),
  dmPeer: userSummarySchema.nullable(),
  settings: conversationSettingsSchema,
  panelForConversationId: z.uuid().nullable(),
  archivedAt: isoDate.nullable(),
  previewVersion: z.object({ lastChangeSeq: version, viewerVersion: version }),
  /** null when the viewer is not a member. */
  me: conversationMeSchema.nullable(),
})
export type Conversation = z.infer<typeof conversationSchema>

/** The list is not paginated (a person has at most 200 conversations); `userChangeSeq` is the sync baseline of the snapshot. */
export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSchema),
  userChangeSeq: version,
})
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>

export const conversationListQuerySchema = z.object({
  /** `true`: archived conversations I own (to restore them) instead of the live ones. */
  archived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
})

// ───────── Create, open, change ─────────

/** `agent` conversations arrive with M4. */
export const createConversationRequestSchema = z.strictObject({
  kind: z.enum(['channel', 'group', 'agent']),
  name: conversationNameSchema,
  description: conversationDescriptionSchema.nullable().optional(),
  memberIds: z.array(z.uuid()).max(LIMITS.addMembersMax).optional(),
})
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>

export const openDmRequestSchema = z.strictObject({ userId: z.uuid() })
export type OpenDmRequest = z.infer<typeof openDmRequestSchema>

export const patchConversationRequestSchema = z
  .strictObject({
    expectedMetadataVersion: z.number().int().min(1),
    name: conversationNameSchema.optional(),
    /** An empty description clears it. */
    description: conversationDescriptionSchema.nullable().optional(),
    settings: conversationSettingsPatchSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined || body.description !== undefined || body.settings !== undefined,
    { message: 'Nothing to change' },
  )
export type PatchConversationRequest = z.infer<typeof patchConversationRequestSchema>

/** My own settings for one conversation (docs/05 section 3.3). `hidden` only applies to direct messages. */
export const patchConversationMeRequestSchema = z
  .strictObject({
    expectedViewerVersion: version,
    notifyLevel: notifyLevelSchema.optional(),
    mute: muteSchema.optional(),
    pinned: z.boolean().optional(),
    hidden: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.notifyLevel !== undefined ||
      body.mute !== undefined ||
      body.pinned !== undefined ||
      body.hidden !== undefined,
    { message: 'Nothing to change' },
  )
export type PatchConversationMeRequest = z.infer<typeof patchConversationMeRequestSchema>

/** Moves my read position forward; it never moves back and never passes the last message. */
export const readRequestSchema = z.strictObject({ seq: version })
export type ReadRequest = z.infer<typeof readRequestSchema>

export const restoreConversationRequestSchema = z.strictObject({
  /** Required when another live channel has taken the name while this one was archived. */
  name: conversationNameSchema.optional(),
  /** Required when the archived conversation has no owner; the person becomes the owner. */
  ownerUserId: z.uuid().optional(),
})
export type RestoreConversationRequest = z.infer<typeof restoreConversationRequestSchema>

export const transferRequestSchema = z.strictObject({
  userId: z.uuid(),
  expectedMembershipVersion: version.optional(),
})
export type TransferRequest = z.infer<typeof transferRequestSchema>

// ───────── Channel discovery ─────────

export const channelsQuerySchema = z.object({
  query: z.string().trim().min(1).max(LIMITS.userSearchQueryMaxLength).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.channelsPageMax).optional(),
})
export type ChannelsQuery = z.infer<typeof channelsQuerySchema>

export const channelsPageSchema = z.object({
  items: z.array(conversationSchema),
  nextCursor: z.string().nullable(),
})
export type ChannelsPage = z.infer<typeof channelsPageSchema>

// ───────── Members and bans ─────────

export const memberSchema = z.object({
  user: userSummarySchema,
  /** The conversation's membership version when the page was read; every page of one listing shares it. */
  membershipVersion: version,
  role: memberRoleSchema,
  membershipId: z.uuid(),
  joinedAt: isoDate,
  silencedUntil: isoDate.nullable(),
})
export type Member = z.infer<typeof memberSchema>

export const membersQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.membersPageMax).optional(),
})

export const membersPageSchema = z.object({
  members: z.array(memberSchema),
  membershipVersion: version,
  nextCursor: z.string().nullable(),
})
export type MembersPage = z.infer<typeof membersPageSchema>

export const addMembersRequestSchema = z.strictObject({
  userIds: z.array(z.uuid()).min(1).max(LIMITS.addMembersMax),
  expectedMembershipVersion: version.optional(),
})
export type AddMembersRequest = z.infer<typeof addMembersRequestSchema>

export const addMembersResponseSchema = z.object({
  added: z.array(userSummarySchema),
  skipped: z.array(
    z.object({
      userId: z.uuid(),
      reason: z.enum(['banned', 'already_member', 'unavailable', 'limit_reached']),
    }),
  ),
  membershipVersion: version,
})
export type AddMembersResponse = z.infer<typeof addMembersResponseSchema>

export const patchMemberRequestSchema = z
  .strictObject({
    /** `owner` is never set here: ownership moves only through the transfer endpoint. */
    role: z.enum(['admin', 'member']).optional(),
    /** A finite time in the future starts a silence; `null` lifts it. */
    silencedUntil: isoDate.nullable().optional(),
    expectedMembershipVersion: version.optional(),
  })
  .refine((body) => body.role !== undefined || body.silencedUntil !== undefined, {
    message: 'Nothing to change',
  })
export type PatchMemberRequest = z.infer<typeof patchMemberRequestSchema>

export const banRequestSchema = z.strictObject({
  userId: z.uuid(),
  reason: z.string().trim().min(1).max(200).optional(),
  expectedMembershipVersion: version.optional(),
})
export type BanRequest = z.infer<typeof banRequestSchema>

export const banSchema = z.object({
  user: userSummarySchema,
  bannedBy: z.uuid().nullable(),
  reason: z.string().nullable(),
  createdAt: isoDate,
})
export type Ban = z.infer<typeof banSchema>

export const bansResponseSchema = z.object({ bans: z.array(banSchema) })
export type BansResponse = z.infer<typeof bansResponseSchema>

// ───────── Group invitation links (docs/01 section 4.2) ─────────

export const createConversationInviteRequestSchema = z.strictObject({
  /** Omitted or `null`: unlimited uses. */
  maxUses: z.number().int().min(1).max(LIMITS.conversationInviteMaxUses).nullable().optional(),
  expiresInDays: z.number().int().min(1).max(LIMITS.conversationInviteMaxTtlDays).optional(),
})
export type CreateConversationInviteRequest = z.infer<typeof createConversationInviteRequestSchema>

export const conversationInviteSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  createdBy: z.uuid(),
  maxUses: z.number().int().nullable(),
  useCount: version,
  expiresAt: isoDate,
  revokedAt: isoDate.nullable(),
  createdAt: isoDate,
})
export type ConversationInvite = z.infer<typeof conversationInviteSchema>

/** The plaintext code is returned exactly once, at creation; the link is `/join#<code>`. */
export const createdConversationInviteSchema = conversationInviteSchema.extend({
  code: z.string(),
})
export type CreatedConversationInvite = z.infer<typeof createdConversationInviteSchema>

export const conversationInvitesResponseSchema = z.object({
  invites: z.array(conversationInviteSchema),
})

/** The code travels in the body, never in the URL (D-045). */
export const conversationInviteCodeRequestSchema = z.strictObject({
  code: z.string().min(1).max(64),
})
export type ConversationInviteCodeRequest = z.infer<typeof conversationInviteCodeRequestSchema>

export const conversationInvitePreviewSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  memberCount: version,
  alreadyMember: z.boolean(),
})
export type ConversationInvitePreview = z.infer<typeof conversationInvitePreviewSchema>
