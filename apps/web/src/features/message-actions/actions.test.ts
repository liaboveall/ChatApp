/**
 * What becomes of the save of an edit when its answer comes late (M2b recheck 2026-10-06, R5, D-173): the answer is
 * merged by the engine only while the account and the membership it was made under are still the ones here, and the
 * edit the composer is in is finished only if it is the very edit the save went out under. The engine, the request and
 * the toast are replaced here; the stores of the composer (the reply or edit in progress, the drafts) are the real ones.
 */
import type { Message, MessageEnvelope } from '@chatapp/contracts'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { type EditMode, modeOf, startEdit, useCompose } from '@/lib/sync/compose.ts'
import { draftOf, setDraft, useDrafts } from '@/lib/sync/drafts.ts'
import { edited, makeMessage, uuid } from '@/lib/sync/fixtures.ts'
import { clearClientStores } from '@/lib/sync/stores.ts'
import type { RequestTicket } from '@/lib/sync/types.ts'

const mocks = vi.hoisted(() => ({
  ticket: vi.fn(),
  ingestMessage: vi.fn(),
  handleAccessError: vi.fn(),
  refreshConversation: vi.fn(),
  api: vi.fn(),
  showToast: vi.fn(),
}))

vi.mock('@/app/sync.ts', () => ({
  engine: {
    ticket: mocks.ticket,
    ingestMessage: mocks.ingestMessage,
    handleAccessError: mocks.handleAccessError,
    refreshConversation: mocks.refreshConversation,
  },
}))
vi.mock('@/lib/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api.ts')>()),
  api: mocks.api,
}))
vi.mock('@/lib/toast.ts', () => ({ showToast: mocks.showToast }))

const { ApiError } = await import('@/lib/api.ts')
const { editMessage, saveEdit } = await import('./actions.ts')

const C = uuid(500)
const M1 = uuid(700)
const M2 = uuid(701)
const original = makeMessage(3, { body: 'the original' })
const saved = edited(original, 50, 'the new text')
const ticketOf = (membershipId: string | null): RequestTicket => ({
  scope: null,
  session: 0,
  conversationId: C,
  membershipId,
  watermark: 3,
})
const answer = (message: Message): MessageEnvelope => ({ message, users: {} })

const draftNow = (): string => draftOf(useDrafts.getState(), C)
const modeNow = (membershipId: string) => modeOf(useCompose.getState(), C, membershipId)

/** What the composer holds when Enter is pressed in an edit: the edit, and the new text in the field. */
function pressEnterInEdit(membershipId: string, stash = 'typed before'): EditMode {
  startEdit(C, membershipId, original, stash)
  setDraft(C, 'the new text')
  const mode = modeNow(membershipId)
  if (mode?.type !== 'edit') throw new Error('no edit in progress')
  return mode
}

beforeEach(() => {
  clearClientStores()
  vi.resetAllMocks()
  mocks.ticket.mockReturnValue(ticketOf(M1))
  mocks.api.mockResolvedValue(answer(saved))
  mocks.ingestMessage.mockReturnValue(true)
  mocks.handleAccessError.mockReturnValue(false)
})

describe('the save of an edit, as far as the composer is told', () => {
  test('the saved message comes back when the server took it and the page took the answer', async () => {
    expect(await editMessage(original, 'the new text')).toBe(saved)
    expect(mocks.api).toHaveBeenCalledWith(
      `/api/messages/${original.id}`,
      expect.objectContaining({
        method: 'PATCH',
        json: { body: 'the new text', expectedChangeSeq: original.changeSeq },
      }),
    )
    expect(mocks.ingestMessage).toHaveBeenCalledWith(answer(saved), ticketOf(M1))
  })

  test('nothing is reported as saved when the engine refused the answer: it was made for an account or a membership that is gone', async () => {
    mocks.ingestMessage.mockReturnValue(false)
    expect(await editMessage(original, 'the new text')).toBeNull()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  test('a failure is worded for the person, and nothing is reported as saved', async () => {
    mocks.api.mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT'))
    expect(await editMessage(original, 'the new text')).toBeNull()
    expect(mocks.showToast).toHaveBeenCalledTimes(1)
    expect(mocks.refreshConversation).toHaveBeenCalledWith(C)
  })

  test('the failure of a request made for something that is gone shows nothing', async () => {
    mocks.api.mockRejectedValue(new ApiError(0, 'NETWORK'))
    mocks.handleAccessError.mockReturnValue(true)
    expect(await editMessage(original, 'the new text')).toBeNull()
    expect(mocks.showToast).not.toHaveBeenCalled()
  })
})

describe('finishing the edit when the save is answered', () => {
  test('an edit that is still the one in progress ends, and what was set aside is back in the field', async () => {
    const mode = pressEnterInEdit(M1)
    await saveEdit(mode, 'the new text')
    expect(modeNow(M1)).toBeUndefined()
    expect(draftNow()).toBe('typed before')
  })

  test('an answer the engine refused leaves the edit and the field of whoever is there now alone (another account)', async () => {
    const mode = pressEnterInEdit(M1)
    let release: () => void = () => undefined
    mocks.api.mockImplementation(
      () =>
        new Promise<MessageEnvelope>((resolve) => {
          release = () => resolve(answer(saved))
        }),
    )
    mocks.ingestMessage.mockReturnValue(false)
    const finished = saveEdit(mode, 'the new text')
    // The account changed while the request was out: everything of the first is emptied, the second starts writing.
    clearClientStores()
    setDraft(C, 'BOB_UNSENT_DRAFT')
    release()
    await finished
    expect(draftNow()).toBe('BOB_UNSENT_DRAFT')
    expect(useCompose.getState().byConversation).toEqual({})
  })

  test('the same, when whoever is there now was already in an edit of their own', async () => {
    const mode = pressEnterInEdit(M1)
    mocks.ingestMessage.mockReturnValue(false)
    clearClientStores()
    startEdit(C, M2, makeMessage(5), 'bob typed before')
    setDraft(C, 'bob’s edit text')
    await saveEdit(mode, 'the new text')
    expect(modeNow(M2)?.type).toBe('edit')
    expect(draftNow()).toBe('bob’s edit text')
  })

  test('the engine took the answer but the person left that edit and started another meanwhile: the second is not touched', async () => {
    const mode = pressEnterInEdit(M1)
    startEdit(C, M1, makeMessage(4), 'goes on from the stash of the first')
    setDraft(C, 'second edit text')
    await saveEdit(mode, 'the new text')
    const second = modeNow(M1)
    expect(second?.type === 'edit' && second.message.id === makeMessage(4).id).toBe(true)
    expect(draftNow()).toBe('second edit text')
  })

  test('text typed while the save was out stays, and the edit goes on from the version that was saved', async () => {
    const mode = pressEnterInEdit(M1)
    let release: () => void = () => undefined
    mocks.api.mockImplementation(
      () =>
        new Promise<MessageEnvelope>((resolve) => {
          release = () => resolve(answer(saved))
        }),
    )
    const finished = saveEdit(mode, 'the new text')
    setDraft(C, 'the new text, and more')
    release()
    await finished
    expect(draftNow()).toBe('the new text, and more')
    const now = modeNow(M1)
    expect(now?.type === 'edit' && now.message === saved && now.stash === 'typed before').toBe(true)
  })

  test('a save that failed leaves the edit open with its text', async () => {
    const mode = pressEnterInEdit(M1)
    mocks.api.mockRejectedValue(new ApiError(0, 'NETWORK'))
    await saveEdit(mode, 'the new text')
    expect(modeNow(M1)?.type).toBe('edit')
    expect(draftNow()).toBe('the new text')
  })
})
