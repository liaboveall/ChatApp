import { type Me, meSchema, timezoneSchema } from '@chatapp/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { api } from '@/lib/api.ts'
import { queryKeys, writeMeAnswer } from '@/lib/queries.ts'

/**
 * While the account follows the browser's time zone (the default, `settings.timezoneAuto !== false`), keep the stored zone
 * equal to it. A fixed zone is never touched by a browser (docs/01 section 4.3). One attempt per version and zone: a
 * conflict or an outage must not turn into a request loop.
 */
export function useAutoTimezone(me: Me | null): void {
  const queryClient = useQueryClient()
  const attempted = useRef<string>('')
  useEffect(() => {
    if (!me || me.settings.timezoneAuto === false) return
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!zone || zone === me.timezone || !timezoneSchema.safeParse(zone).success) return
    const key = `${me.meVersion}:${zone}`
    if (attempted.current === key) return
    attempted.current = key
    api('/api/me', {
      method: 'PATCH',
      json: { expectedMeVersion: me.meVersion, timezone: zone },
      schema: meSchema,
    })
      .then((updated) => writeMeAnswer(queryClient, updated))
      .catch(() => queryClient.invalidateQueries({ queryKey: queryKeys.me }))
  }, [me, queryClient])
}
