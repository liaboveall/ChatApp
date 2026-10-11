import { useEffect, useMemo } from 'react'
import { setUnreadInTitle } from '@/lib/page-title.ts'
import { useConversationIndex } from '@/lib/sync/hooks.ts'
import { type SyncUi, useSyncUi } from '@/lib/sync/state.ts'
import { showAppBadge, unreadTotal } from '@/lib/unread.ts'

/**
 * Keeps the number in the tab title and on the installed app's icon (Badging API) equal to what is unread in the conversations
 * the sidebar lists (docs/01 section 4.8). Leaving the signed-in shell clears both: nothing of an account stays on the icon.
 */
export function useUnreadIndicators(): void {
  const index = useConversationIndex()
  const pendingRead = useSyncUi((state: SyncUi) => state.pendingRead)
  const total = useMemo(() => unreadTotal(index, pendingRead, Date.now()), [index, pendingRead])
  useEffect(() => {
    setUnreadInTitle(total)
    showAppBadge(total)
  }, [total])
  useEffect(
    () => () => {
      setUnreadInTitle(0)
      showAppBadge(0)
    },
    [],
  )
}
