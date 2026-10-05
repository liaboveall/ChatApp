/**
 * The member list with its pages. The first page loads when the Inspector opens and again whenever the conversation's
 * membership version moves (somebody joined, left or was changed); "more" follows the cursor and starts over if the
 * server says the list changed under it (docs/05 section 3.3).
 */
import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/api.ts'
import { describeError } from '@/lib/error-messages.ts'
import { listMembers } from '../conversations/api.ts'
import { extendMemberList, type MemberList, startMemberList } from './member-list.ts'

export type MemberListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: MemberList; more: 'idle' | 'loading' | 'error' }

export function useMemberList(
  conversationId: string,
  membershipVersion: number,
): {
  state: MemberListState
  loadMore: () => void
  reload: () => void
} {
  const [state, setState] = useState<MemberListState>({ status: 'loading' })
  const token = useRef(0)

  const reload = (): void => {
    token.current += 1
    const mine = token.current
    listMembers(conversationId).then(
      (page) => {
        if (token.current === mine) {
          setState({ status: 'ready', list: startMemberList(page), more: 'idle' })
        }
      },
      (error: unknown) => {
        if (token.current !== mine) return
        setState((old) =>
          old.status === 'ready' ? old : { status: 'error', message: describeError(error) },
        )
      },
    )
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: starts over when the conversation's membership version moves
  useEffect(() => {
    reload()
    return () => {
      token.current += 1
    }
  }, [conversationId, membershipVersion])

  const loadMore = (): void => {
    if (state.status !== 'ready' || state.more === 'loading' || state.list.nextCursor === null)
      return
    const mine = token.current
    const { list } = state
    const cursor = state.list.nextCursor
    setState({ status: 'ready', list, more: 'loading' })
    listMembers(conversationId, cursor).then(
      (page) => {
        if (token.current !== mine) return
        const next = extendMemberList(list, page)
        if (next === null) return reload()
        setState({ status: 'ready', list: next, more: 'idle' })
      },
      (error: unknown) => {
        if (token.current !== mine) return
        const stale =
          error instanceof ApiError &&
          (error.code === 'VERSION_CONFLICT' || error.field === 'cursor')
        if (stale) return reload()
        setState({ status: 'ready', list, more: 'error' })
      },
    )
  }

  return { state, loadMore, reload }
}
