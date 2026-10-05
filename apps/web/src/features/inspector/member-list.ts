/**
 * The member list of one conversation as the Inspector reads it (docs/05 section 3.3): pages of a listing that all carry
 * the membership version they were read under. A page read under another version means the members changed while the
 * person was scrolling, and the listing starts again from its first page instead of splicing two different lists.
 */
import type { Member, MembersPage } from '@chatapp/contracts'

export type MemberList = {
  /** The membership version every page of this listing was read under. */
  version: number
  members: Member[]
  nextCursor: string | null
}

export const startMemberList = (page: MembersPage): MemberList => ({
  version: page.membershipVersion,
  members: page.members,
  nextCursor: page.nextCursor,
})

/** Adds the next page. null: it was read under another version, so the listing has to start again. */
export function extendMemberList(list: MemberList, page: MembersPage): MemberList | null {
  if (page.membershipVersion !== list.version) return null
  const known = new Set(list.members.map((member) => member.user.id))
  return {
    version: list.version,
    members: [...list.members, ...page.members.filter((member) => !known.has(member.user.id))],
    nextCursor: page.nextCursor,
  }
}
