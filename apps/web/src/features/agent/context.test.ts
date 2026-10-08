import { describe, expect, it, vi } from 'vitest'
import { makeMessage, uuid } from '@/lib/sync/fixtures.ts'
import type { TimelineWindow } from '@/lib/sync/types.ts'

vi.mock('@/app/sync.ts', () => ({ forScreen: vi.fn() }))

import { segmentWindow } from './context.ts'
import { rememberContext, useAgent } from './store.ts'

const context = {
  conversationId: uuid(1),
  contextEpoch: uuid(8),
  stateVersion: 2,
  historyFromSeq: 2,
  keySource: 'site' as const,
  readScope: 'all_accessible' as const,
}
describe('private assistant segment transition', () => {
  it('late context reads cannot restore a prior own-key segment', () => {
    useAgent.setState({ contexts: {} })
    rememberContext(context)
    rememberContext({
      ...context,
      stateVersion: 1,
      keySource: 'user',
      contextEpoch: uuid(7),
      historyFromSeq: 0,
    })
    expect(useAgent.getState().contexts[uuid(1)]).toEqual(context)
  })
  it('a key change removes old prompts from the view; scope changes retain same-key visible history', () => {
    const window = {
      messages: [
        makeMessage(1, { body: 'PRIVATE_CANARY' }),
        makeMessage(2, { kind: 'agent' }),
        makeMessage(3, { body: 'site request' }),
      ],
      hasMoreBefore: true,
    } as TimelineWindow
    const blank = segmentWindow(window, context)
    expect(blank.messages.map((m) => m.body)).toEqual(['site request'])
    expect(blank.hasMoreBefore).toBe(false)
    expect(segmentWindow(window, { ...context, historyFromSeq: 0 }).messages).toHaveLength(3)
  })
})
