import { meSchema } from '@chatapp/contracts'
import { ApiError, api } from '@/lib/api.ts'
import { queryKeys } from '@/lib/queries.ts'
import { queryClient } from '@/lib/query-client.ts'
import { RealtimeClient, realtimeUrl } from '@/lib/realtime.ts'
import { endSession } from '@/lib/session.ts'

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
    queryClient.setQueryData(queryKeys.me, me)
    realtime.start()
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) endSession('expired')
    else realtime.start() // the API is unreachable: keep the session and let the connection back off and retry
  }
}

export const realtime = new RealtimeClient({
  url: realtimeUrl(),
  onSessionLost: () => void onUnauthenticated(),
})
