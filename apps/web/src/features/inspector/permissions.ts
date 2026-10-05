/**
 * What the Inspector offers (docs/01 section 5, D-132). It mirrors `decide()` in `domain/authorize.ts`, which is what the
 * server enforces: the interface only hides what would be refused, and a refusal that still happens (somebody's role
 * changed a moment ago) is worded from the server's reason. Pure: facts in, a set of booleans out.
 */
import type { ConversationKind, MemberRole } from '@chatapp/contracts'

export type ConversationFacts = {
  kind: ConversationKind
  archived: boolean
  whoCanInvite: 'all_members' | 'admins_only'
}

export type Actor = {
  /** My role in the conversation; null when I am not a member (a site administrator looking at a group). */
  role: MemberRole | null
  siteRole: 'user' | 'admin'
}

const RANK: Record<MemberRole, number> = { member: 1, admin: 2, owner: 4 }
const SITE_ADMIN_RANK = 3

const managed = (c: ConversationFacts): boolean => c.kind === 'channel' || c.kind === 'group'
const adminOrOwner = (actor: Actor): boolean => actor.role === 'admin' || actor.role === 'owner'

export type ConversationPermissions = {
  /** Change the name, the description and who may invite. */
  update: boolean
  addMembers: boolean
  createInvite: boolean
  /** The list of links (administrators see all, members their own). */
  seeInvites: boolean
  revokeAnyInvite: boolean
  seeBans: boolean
  unban: boolean
  transfer: boolean
  archive: boolean
  /** Leaving applies to channels and groups only; a direct message can only be hidden. */
  leave: boolean
  /** Whether I am in the conversation at all. */
  member: boolean
}

export function conversationPermissions(
  c: ConversationFacts,
  actor: Actor,
): ConversationPermissions {
  const isManaged = managed(c)
  const live = !c.archived
  const member = actor.role !== null
  const staff = adminOrOwner(actor) || actor.siteRole === 'admin'
  const mayInvite = member && live && (adminOrOwner(actor) || c.whoCanInvite === 'all_members')
  return {
    update: isManaged && live && staff,
    addMembers: isManaged && mayInvite,
    createInvite: c.kind === 'group' && mayInvite,
    seeInvites: c.kind === 'group' && member,
    revokeAnyInvite: c.kind === 'group' && staff,
    seeBans: isManaged && staff,
    unban: isManaged && live && staff,
    transfer: isManaged && live && actor.role === 'owner',
    archive: isManaged && live && (actor.role === 'owner' || actor.siteRole === 'admin'),
    leave: isManaged && member,
    member,
  }
}

export type MemberPermissions = {
  remove: boolean
  ban: boolean
  silence: boolean
  /** Give or take away the administrator role (the owner only). */
  changeRole: boolean
  /** Hand the conversation over to this person (the owner only). */
  transfer: boolean
}

export const noMemberPermissions: MemberPermissions = {
  remove: false,
  ban: false,
  silence: false,
  changeRole: false,
  transfer: false,
}

/** What I may do to one member: never to myself or the owner; an administrator only to plain members. */
export function memberPermissions(
  c: ConversationFacts,
  actor: Actor,
  target: { userId: string; role: MemberRole },
  meId: string,
): MemberPermissions {
  if (!managed(c) || c.archived || target.userId === meId || target.role === 'owner') {
    return noMemberPermissions
  }
  const rank = Math.max(
    actor.role === null ? 0 : RANK[actor.role],
    actor.siteRole === 'admin' ? SITE_ADMIN_RANK : 0,
  )
  const mayAct = rank >= RANK.admin && (target.role !== 'admin' || rank >= SITE_ADMIN_RANK)
  return {
    remove: mayAct,
    ban: mayAct,
    silence: mayAct,
    changeRole: actor.role === 'owner',
    transfer: actor.role === 'owner',
  }
}

export const anyMemberAction = (p: MemberPermissions): boolean =>
  p.remove || p.ban || p.silence || p.changeRole
