/** Rate-limit policies (SEC-11, SEC-16). Anonymous endpoints are limited per IP group and, where an account is named, per account digest. */
import { LIMITS } from '@chatapp/contracts'
import type { LimitPolicy } from '../lib/rate-limit.ts'

const minutes = (n: number) => n * 60_000
const hours = (n: number) => n * 3_600_000

export const POLICIES = {
  loginIp: { name: 'login.ip', limit: 20, windowMs: minutes(10) },
  loginAccount: { name: 'login.account', limit: 8, windowMs: minutes(10) },
  registerIp: { name: 'register.ip', limit: 10, windowMs: minutes(60) },
  inviteCheckIp: { name: 'invite-check.ip', limit: 30, windowMs: minutes(10) },
  verificationRequestIp: { name: 'verify-request.ip', limit: 10, windowMs: minutes(60) },
  verificationRequestAccount: { name: 'verify-request.account', limit: 3, windowMs: minutes(60) },
  verificationConsumeIp: { name: 'verify-consume.ip', limit: 30, windowMs: minutes(60) },
  resetRequestIp: { name: 'reset-request.ip', limit: 10, windowMs: minutes(60) },
  resetRequestAccount: { name: 'reset-request.account', limit: 3, windowMs: minutes(60) },
  resetConsumeIp: { name: 'reset-consume.ip', limit: 30, windowMs: minutes(60) },
  changePasswordUser: { name: 'change-password.user', limit: 10, windowMs: minutes(60) },
  wsConnectIp: { name: 'ws-connect.ip', limit: 120, windowMs: minutes(10) },
  passkeyIp: { name: 'passkey.ip', limit: 60, windowMs: minutes(10) },
  apiUser: { name: 'api.user', limit: 600, windowMs: minutes(1) },

  // Conversations and messages (docs/01 section 7), counted per person.
  /** 10 messages per 10 seconds in one conversation. */
  messageConversationUser: {
    name: 'message.conversation',
    limit: LIMITS.messageRateConversationLimit,
    windowMs: LIMITS.messageRateConversationWindowMs,
  },
  /** 60 messages per minute across all conversations. */
  messageUser: {
    name: 'message.user',
    limit: LIMITS.messageRateUserLimit,
    windowMs: LIMITS.messageRateUserWindowMs,
  },
  messageEditUser: { name: 'message-edit.user', limit: 30, windowMs: minutes(1) },
  conversationCreateUser: { name: 'conversation-create.user', limit: 20, windowMs: hours(1) },
  conversationJoinUser: { name: 'conversation-join.user', limit: 30, windowMs: minutes(10) },
  membersAddUser: { name: 'members-add.user', limit: 30, windowMs: minutes(10) },
  /** Creating, previewing and accepting group invitation links. */
  conversationInviteUser: { name: 'conversation-invite.user', limit: 30, windowMs: minutes(10) },
  userSearchUser: { name: 'user-search.user', limit: 60, windowMs: minutes(1) },
  /** Read positions move often (every scroll to the bottom), so this is the loosest of them. */
  readUser: { name: 'read.user', limit: 300, windowMs: minutes(1) },
  uploadUser: { name: 'upload.user', limit: 20, windowMs: minutes(1) },
  profileUpdateUser: { name: 'profile-update.user', limit: 20, windowMs: minutes(10) },
} as const satisfies Record<string, LimitPolicy>
