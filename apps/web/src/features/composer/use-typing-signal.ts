import { LIMITS, WS_PROTOCOL_VERSION } from '@chatapp/contracts'
import { useEffect, useRef } from 'react'
import { realtime } from '@/app/realtime.ts'

/**
 * Tells the others that I am typing (docs/05 section 4.3): "start" when the field has text, at most once every three
 * seconds (the server's own limit), and "stop" when it is emptied or sent, unless a "start" went out less than three
 * seconds ago, in which case the others' five-second timer ends it anyway. Never queued: a signal that could not go out is
 * stale by the time a connection exists.
 */
export function useTypingSignal(conversationId: string, text: string): void {
  const lastStart = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text changes; the rest is the conversation
  useEffect(() => {
    const now = Date.now()
    if (text === '') {
      if (lastStart.current > 0 && now - lastStart.current >= LIMITS.typingMinIntervalMs) {
        realtime.send({
          v: WS_PROTOCOL_VERSION,
          type: 'typing',
          data: { conversationId, state: 'stop' },
        })
      }
      lastStart.current = 0
      return
    }
    if (now - lastStart.current >= LIMITS.typingMinIntervalMs) {
      if (
        realtime.send({
          v: WS_PROTOCOL_VERSION,
          type: 'typing',
          data: { conversationId, state: 'start' },
        })
      ) {
        lastStart.current = now
      }
    }
  }, [text])
}
