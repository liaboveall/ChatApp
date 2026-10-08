import { describe, expect, test } from 'vitest'
import { makeConversation, makeMe, makeUser, uuid } from './fixtures.ts'
import { displayName, isListed, sidebarGroups, sidebarOrder } from './selectors.ts'
import type { ConversationIndex } from './types.ts'

const indexOf = (...conversations: ReturnType<typeof makeConversation>[]): ConversationIndex => ({
  byId: Object.fromEntries(conversations.map((c) => [c.id, c])),
  removed: {},
  previewHidden: {},
})

describe('isListed', () => {
  test('mine, not hidden or archived; dedicated assistants are listed and private panels are not', () => {
    expect(isListed(makeConversation(1))).toBe(true)
    expect(isListed(makeConversation(1, { me: null }))).toBe(false)
    expect(
      isListed(makeConversation(1, { me: makeMe({ hiddenAt: '2026-10-04T08:00:00.000Z' }) })),
    ).toBe(false)
    expect(isListed(makeConversation(1, { archivedAt: '2026-10-04T08:00:00.000Z' }))).toBe(false)
    expect(isListed(makeConversation(1, { kind: 'agent' }))).toBe(true)
    expect(isListed(makeConversation(1, { kind: 'agent', panelForConversationId: uuid(2) }))).toBe(
      false,
    )
  })
})

describe('sidebarGroups', () => {
  test('pinned first, then channels, groups and direct messages; empty groups are left out', () => {
    const groups = sidebarGroups(
      indexOf(
        makeConversation(1, { kind: 'channel', name: 'general' }),
        makeConversation(2, { kind: 'group' }),
        makeConversation(3, { kind: 'dm', dmPeer: makeUser(9) }),
        makeConversation(4, {
          kind: 'group',
          me: makeMe({ pinnedAt: '2026-10-04T08:00:00.000Z' }),
        }),
      ),
      {},
    )
    expect(groups.map((g) => g.key)).toEqual(['pinned', 'channel', 'group', 'dm'])
    expect(groups[0]?.items.map((i) => i.conversation.id)).toEqual([uuid(4)])
    expect(groups[2]?.items.map((i) => i.conversation.id)).toEqual([uuid(2)])
    expect(
      sidebarGroups(indexOf(makeConversation(2, { kind: 'group' })), {}).map((g) => g.key),
    ).toEqual(['group'])
  })

  test('within a group the most recent activity comes first, and silent ones follow by name', () => {
    const groups = sidebarGroups(
      indexOf(
        makeConversation(1, { kind: 'group', name: 'Zed', lastMessageAt: null }),
        makeConversation(2, {
          kind: 'group',
          name: 'Old',
          lastMessageAt: '2026-10-01T08:00:00.000Z',
        }),
        makeConversation(3, {
          kind: 'group',
          name: 'New',
          lastMessageAt: '2026-10-04T08:00:00.000Z',
        }),
        makeConversation(4, { kind: 'group', name: 'Alpha', lastMessageAt: null }),
      ),
      {},
    )
    expect(groups[0]?.items.map((i) => displayName(i.conversation))).toEqual([
      'New',
      'Old',
      'Alpha',
      'Zed',
    ])
  })

  test('pinned conversations are ordered by when they were pinned, newest first', () => {
    const groups = sidebarGroups(
      indexOf(
        makeConversation(1, { me: makeMe({ pinnedAt: '2026-10-01T08:00:00.000Z' }) }),
        makeConversation(2, { me: makeMe({ pinnedAt: '2026-10-03T08:00:00.000Z' }) }),
      ),
      {},
    )
    expect(groups[0]?.items.map((i) => i.conversation.id)).toEqual([uuid(2), uuid(1)])
  })

  test('the unread count follows the further of the server position and the one this client claimed', () => {
    const conversation = makeConversation(1, { lastSeq: 20, me: makeMe({ lastReadSeq: 5 }) })
    const plain = sidebarGroups(indexOf(conversation), {})
    expect(plain[0]?.items[0]?.unread).toBe(15)
    const claimed = sidebarGroups(indexOf(conversation), { [conversation.id]: 18 })
    expect(claimed[0]?.items[0]?.unread).toBe(2)
    const behind = sidebarGroups(indexOf(conversation), { [conversation.id]: 3 })
    expect(behind[0]?.items[0]?.unread).toBe(15)
  })

  test('carries whether the preview is hidden', () => {
    const conversation = makeConversation(1)
    const index = { ...indexOf(conversation), previewHidden: { [conversation.id]: true as const } }
    expect(sidebarGroups(index, {})[0]?.items[0]?.previewHidden).toBe(true)
  })

  test('the keyboard order is the order on screen', () => {
    const groups = sidebarGroups(
      indexOf(
        makeConversation(1, { kind: 'dm', dmPeer: makeUser(9) }),
        makeConversation(2, { kind: 'channel' }),
        makeConversation(3, {
          kind: 'group',
          me: makeMe({ pinnedAt: '2026-10-04T08:00:00.000Z' }),
        }),
      ),
      {},
    )
    expect(sidebarOrder(groups).map((i) => i.conversation.id)).toEqual([uuid(3), uuid(2), uuid(1)])
  })
})

describe('displayName', () => {
  test('a direct message goes by the other person, everything else by its name', () => {
    expect(
      displayName(makeConversation(1, { kind: 'dm', dmPeer: makeUser(2, { displayName: 'Bea' }) })),
    ).toBe('Bea')
    expect(displayName(makeConversation(1, { name: 'Plans' }))).toBe('Plans')
    expect(displayName(makeConversation(1, { kind: 'dm', dmPeer: null }), 'Someone')).toBe(
      'Someone',
    )
    expect(displayName(makeConversation(1, { name: null }), 'Unnamed')).toBe('Unnamed')
  })
})
