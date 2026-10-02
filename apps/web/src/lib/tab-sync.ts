/**
 * Cross-tab sign-out (D-070, SEC-34): the tab that signs out leaves a tombstone and tells the others, which stop
 * rendering account data, close their connection and drop their caches. BroadcastChannel is the fast path; the
 * localStorage tombstone also reaches tabs without it (and, through the `storage` event, tabs in other windows).
 */
import { local } from './storage.ts'

const CHANNEL = 'chatapp.auth'
const TOMBSTONE_KEY = 'chatapp.signed-out-at'

export type TabMessage = { type: 'signed-out'; reason: string } | { type: 'signed-in' }

type Listener = (message: TabMessage) => void

export function announce(message: TabMessage): void {
  try {
    const channel = new BroadcastChannel(CHANNEL)
    channel.postMessage(message)
    channel.close()
  } catch {
    // No BroadcastChannel: the storage event below still reaches the other tabs.
  }
  if (message.type === 'signed-out') local.set(TOMBSTONE_KEY, `${Date.now()}:${message.reason}`)
}

/** Listens for messages from other tabs. Returns the unsubscribe function. */
export function listen(listener: Listener): () => void {
  let channel: BroadcastChannel | undefined
  try {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as Partial<TabMessage> | null
      if (data?.type === 'signed-out' && typeof data.reason === 'string')
        listener({ type: 'signed-out', reason: data.reason })
      else if (data?.type === 'signed-in') listener({ type: 'signed-in' })
    }
  } catch {
    channel = undefined
  }
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== TOMBSTONE_KEY || event.newValue === null) return
    const reason = event.newValue.split(':')[1] ?? 'signed-out'
    listener({ type: 'signed-out', reason })
  }
  window.addEventListener('storage', onStorage)
  return () => {
    channel?.close()
    window.removeEventListener('storage', onStorage)
  }
}
