import { useQuery } from '@tanstack/react-query'
import { meQuery } from '@/lib/queries.ts'
import { serverNow } from '@/lib/realtime.ts'
import { getLocale } from '@/paraglide/runtime.js'

/**
 * What a component needs to word a time: the language, the person's own time zone and a clock corrected by the server's
 * time. The zone comes from the account (it already follows the browser when the person asked for that, D-118).
 */
export function useTime(): { locale: string; timeZone: string | undefined; now: () => number } {
  const { data } = useQuery(meQuery)
  return { locale: getLocale(), timeZone: data?.timezone, now: serverNow }
}
