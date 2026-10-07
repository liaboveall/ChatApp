import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { api } from '@/lib/api.ts'
import { makeConversation } from '@/lib/sync/fixtures.ts'
import { SharedFiles } from './shared-files.tsx'

const state = vi.hoisted(() => ({ window: { messages: [], hidden: {}, gone: {} } }))
vi.mock('@/app/sync.ts', () => ({
  forScreen: vi.fn((_scope, run: () => Promise<unknown>) => run()),
}))
vi.mock('@/lib/sync/hooks.ts', () => ({ useTimelineWindow: () => state.window }))
vi.mock('@/lib/api.ts', () => ({ api: vi.fn() }))
vi.mock('./gallery.tsx', () => ({
  Attachments: ({ files }: { files: { id: string }[] }) => (
    <div>
      {files.map((file) => (
        <span key={file.id}>{file.id}</span>
      ))}
    </div>
  ),
}))
beforeEach(() => {
  vi.clearAllMocks()
  state.window = { messages: [], hidden: {}, gone: {} }
})
test('loaded pages survive text-only messages, and attachment changes refresh all loaded pages', async () => {
  const first = { items: [{ messageId: 'm1', attachment: { id: 'a1' } }], nextCursor: 'next' },
    second = { items: [{ messageId: 'm2', attachment: { id: 'a2' } }], nextCursor: null }
  vi.mocked(api)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(second)
  const conversation = makeConversation(10)
  const view = render(<SharedFiles conversation={conversation} />)
  await screen.findByText('a1')
  fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
  await screen.findByText('a2')
  view.rerender(
    <SharedFiles
      conversation={{ ...conversation, lastChangeSeq: conversation.lastChangeSeq + 1 }}
    />,
  )
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
  expect(screen.getByText('a2')).toBeVisible()
  state.window = { ...state.window, gone: { older: 99 } }
  view.rerender(
    <SharedFiles
      conversation={{ ...conversation, lastChangeSeq: conversation.lastChangeSeq + 2 }}
    />,
  )
  await waitFor(() => expect(api).toHaveBeenCalledTimes(4))
  expect(screen.getByText('a1')).toBeVisible()
  expect(screen.getByText('a2')).toBeVisible()
})
