import { z } from 'zod'
export const MONITOR_ERROR_KINDS = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'AggregateError',
  'AbortError',
  'NetworkError',
] as const
export const monitoringEventSchema = z
  .object({
    kind: z.enum(MONITOR_ERROR_KINDS),
    page: z.enum(['auth', 'chat', 'settings', 'admin', 'public', 'unknown']),
  })
  .strict()
export type MonitoringEvent = z.infer<typeof monitoringEventSchema>
export const monitoringConfigSchema = z.object({ enabled: z.boolean() }).strict()
