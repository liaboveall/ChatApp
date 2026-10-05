import { LIMITS } from '@chatapp/contracts'
import { describe, expect, test } from 'vitest'
import { makeMessage, recalled, uuid } from '@/lib/sync/fixtures.ts'
import { type ActionInput, actionsFor, hasAny, lastEditable, noActions } from './eligibility.ts'

const ME = uuid(1)
const BEA = uuid(2)
const T0 = Date.parse('2026-10-04T08:00:00.000Z')
const created = (ageMs: number) => new Date(T0 - ageMs).toISOString()

function input(
  over: Partial<ActionInput> & { sender?: string | null; ageMs?: number } = {},
): ActionInput {
  const { sender = ME, ageMs = 30_000, ...rest } = over
  return {
    message: makeMessage(5, { senderId: sender, createdAt: created(ageMs) }),
    meId: ME,
    conversation: { kind: 'group', archivedAt: null, me: { role: 'member', silencedUntil: null } },
    siteRole: 'user',
    now: T0,
    ...rest,
  }
}

describe('actionsFor my own message', () => {
  test('a fresh one can be replied to, copied, edited, recalled and hidden, but not deleted by an administrator', () => {
    expect(actionsFor(input())).toEqual({
      reply: true,
      copy: true,
      edit: true,
      recall: true,
      hideForMe: true,
      adminDelete: false,
    })
  })

  test('recall goes at two minutes exactly (no grace in the interface), edit goes at 24 hours', () => {
    expect(actionsFor(input({ ageMs: LIMITS.messageRecallWindowMs - 1 })).recall).toBe(true)
    expect(actionsFor(input({ ageMs: LIMITS.messageRecallWindowMs })).recall).toBe(false)
    expect(actionsFor(input({ ageMs: LIMITS.messageRecallWindowMs })).edit).toBe(true)
    expect(actionsFor(input({ ageMs: LIMITS.messageEditWindowMs - 1 })).edit).toBe(true)
    expect(actionsFor(input({ ageMs: LIMITS.messageEditWindowMs })).edit).toBe(false)
  })

  test('a message that is gone offers only "delete for me"', () => {
    const base = input()
    const actions = actionsFor({ ...base, message: recalled(base.message, 9) })
    expect(actions).toEqual({ ...noActions, hideForMe: true })
  })

  test('a message still being streamed or failed cannot be edited', () => {
    const base = input()
    expect(actionsFor({ ...base, message: { ...base.message, status: 'streaming' } }).edit).toBe(
      false,
    )
  })
})

describe('actionsFor someone else’s message', () => {
  test('can be replied to, copied and hidden; not edited or recalled', () => {
    expect(actionsFor(input({ sender: BEA }))).toMatchObject({
      reply: true,
      copy: true,
      edit: false,
      recall: false,
      hideForMe: true,
      adminDelete: false,
    })
  })

  test('administrators and owners of a group or channel can delete it for everybody', () => {
    for (const role of ['admin', 'owner'] as const) {
      const actions = actionsFor(
        input({
          sender: BEA,
          conversation: { kind: 'group', archivedAt: null, me: { role, silencedUntil: null } },
        }),
      )
      expect(actions.adminDelete, role).toBe(true)
    }
  })

  test('not in a direct message, whoever I am', () => {
    const actions = actionsFor(
      input({
        sender: BEA,
        conversation: { kind: 'dm', archivedAt: null, me: { role: 'owner', silencedUntil: null } },
      }),
    )
    expect(actions.adminDelete).toBe(false)
  })

  test('a site administrator who is a member can; one who is not a member has no menu of this kind here', () => {
    expect(actionsFor(input({ sender: BEA, siteRole: 'admin' })).adminDelete).toBe(true)
    expect(
      actionsFor(
        input({
          sender: BEA,
          siteRole: 'admin',
          conversation: { kind: 'group', archivedAt: null, me: null },
        }),
      ).adminDelete,
    ).toBe(false)
  })

  test('a system line cannot be replied to or deleted for everybody, but I can hide it', () => {
    const base = input({ sender: null })
    const system = { ...base.message, kind: 'system' as const, body: null }
    const actions = actionsFor({
      ...base,
      message: system,
      conversation: { kind: 'group', archivedAt: null, me: { role: 'owner', silencedUntil: null } },
    })
    expect(actions).toEqual({ ...noActions, hideForMe: true })
  })

  test('a message an administrator already deleted cannot be deleted again', () => {
    const base = input({
      sender: BEA,
      conversation: { kind: 'group', archivedAt: null, me: { role: 'owner', silencedUntil: null } },
    })
    const deleted = { ...base.message, body: null, deletedAt: created(0) }
    expect(actionsFor({ ...base, message: deleted }).adminDelete).toBe(false)
  })
})

describe('what the conversation allows', () => {
  test('an archived conversation is read-only: only copy and hide remain', () => {
    const actions = actionsFor(
      input({
        conversation: {
          kind: 'group',
          archivedAt: created(0),
          me: { role: 'owner', silencedUntil: null },
        },
      }),
    )
    expect(actions).toEqual({ ...noActions, copy: true, hideForMe: true })
  })

  test('being silenced stops replying and editing, not recalling or hiding', () => {
    const actions = actionsFor(
      input({
        conversation: {
          kind: 'group',
          archivedAt: null,
          me: { role: 'member', silencedUntil: new Date(T0 + 60_000).toISOString() },
        },
      }),
    )
    expect(actions).toMatchObject({ reply: false, edit: false, recall: true, hideForMe: true })
  })

  test('a silence that has run out no longer counts', () => {
    const actions = actionsFor(
      input({
        conversation: {
          kind: 'group',
          archivedAt: null,
          me: { role: 'member', silencedUntil: new Date(T0 - 1).toISOString() },
        },
      }),
    )
    expect(actions.reply).toBe(true)
  })

  test('without a relation to the conversation nothing but copy is offered', () => {
    const actions = actionsFor(
      input({ conversation: { kind: 'channel', archivedAt: null, me: null } }),
    )
    expect(actions).toEqual({ ...noActions, copy: true })
  })
})

describe('hasAny and lastEditable', () => {
  test('an empty set of actions is recognised', () => {
    expect(hasAny(noActions)).toBe(false)
    expect(hasAny({ ...noActions, copy: true })).toBe(true)
  })

  test('up arrow edits my newest message that can still be edited, skipping others’, recalled and expired ones', () => {
    const base = input()
    const mine = (seq: number, ageMs: number) =>
      makeMessage(seq, { senderId: ME, createdAt: created(ageMs) })
    const list = [
      mine(1, 1000),
      mine(2, 2000),
      makeMessage(3, { senderId: BEA, createdAt: created(500) }),
      recalled(mine(4, 600), 9),
      mine(5, LIMITS.messageEditWindowMs + 1),
    ]
    const { message: _unused, ...context } = base
    expect(lastEditable(list, context)?.seq).toBe(2)
    expect(lastEditable([], base)).toBeUndefined()
  })
})
