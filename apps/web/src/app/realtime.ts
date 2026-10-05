import { meSchema, WS_PROTOCOL_VERSION } from '@chatapp/contracts'
import { engine } from '@/app/sync.ts'
import { getProfile } from '@/features/conversations/api.ts'
import { ApiError, api } from '@/lib/api.ts'
import { writeMe } from '@/lib/queries.ts'
import { queryClient } from '@/lib/query-client.ts'
import { RealtimeClient, realtimeUrl } from '@/lib/realtime.ts'
import { endSession } from '@/lib/session.ts'
import { ActivityReporter } from '@/lib/sync/activity.ts'
import { applyPresence, PresenceWatch } from '@/lib/sync/presence.ts'
import { registerStoreReset } from '@/lib/sync/stores.ts'
import { applyTyping } from '@/lib/sync/typing.ts'

/**
 * The server closes a connection with 4401 whenever the identity it was opened with is no longer current. That includes
 * a password change on this very device, which gives the session a new epoch while the user stays signed in. So before
 * treating 4401 as the end of the session, ask the API: a 401 there is the real answer, a user means "reconnect".
 *
 * The probe does not write its answer into the query cache: `endSession` looks at the cached identity to know whether
 * the session was still considered live, and a probe that stored "nobody" first would make it think it was already over.
 */
async function onUnauthenticated(): Promise<void> {
  try {
    const me = await api('/api/me', { schema: meSchema, anonymous: true })
    writeMe(queryClient, me)
    realtime.start()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) endSession('expired')
    else realtime.start() // the API is unreachable: keep the session and let the connection back off and retry
  }
}

/** After a failed attempt, how long before the same person is asked about again. */
const LEARN_RETRY_MS = 30_000
/** The people whose profile is being asked for, or was asked for and refused a moment ago. */
const learning = new Set<string>()

/**
 * Somebody is typing whose name the page does not have: they have said nothing here yet and no list of members has been
 * opened (a group made with them in it has no "joined" line to bring them in). Their profile is asked for once, so that the
 * line under the list names them instead of "a member" (D-167).
 */
function learnOf(userId: string): void {
  if (engine.scope === null || engine.knowsUser(userId) || learning.has(userId)) return
  learning.add(userId)
  getProfile(userId).then(
    () => learning.delete(userId),
    () => void setTimeout(() => learning.delete(userId), LEARN_RETRY_MS),
  )
}

export const realtime: RealtimeClient = new RealtimeClient({
  url: realtimeUrl(),
  onSessionLost: () => void onUnauthenticated(),
  onEvent: (message) => {
    // Hints only raise what the engine has heard of; it decides what to read and when (docs/05 section 4.5, D-150).
    engine.onEvent(message)
    // Typing and presence are transient and live in their own small stores.
    if (message.type === 'typing') {
      applyTyping(message.data, engine.scope?.userId, Date.now())
      if (message.data.state === 'start' && message.data.userId !== engine.scope?.userId) {
        learnOf(message.data.userId)
      }
    } else if (message.type === 'presence') applyPresence([message.data])
    else if (message.type === 'presence.snapshot') applyPresence(message.data.users)
  },
  // The server forgets what it was told per connection: say it again to the new one.
  onHello: () => {
    engine.onHello()
    presenceWatch.resend()
    activity.resend()
  },
})

/** The people whose online status is on screen (docs/05 section 4.3: the whole set is replaced each time). */
export const presenceWatch = new PresenceWatch((userIds) =>
  realtime.send({ v: WS_PROTOCOL_VERSION, type: 'presence.watch', data: { userIds } }),
)

/** Active while the page is in front and touched; idle otherwise. */
export const activity = new ActivityReporter({
  send: (state) =>
    realtime.send({ v: WS_PROTOCOL_VERSION, type: 'presence.activity', data: { state } }),
})

registerStoreReset(() => {
  presenceWatch.clear()
  activity.stop()
})
