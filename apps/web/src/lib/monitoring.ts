/** Fixed categories only. Cookies, raw errors, traces, browsing history and user data never enter the payload. */
import {
  MONITOR_ERROR_KINDS,
  type MonitoringEvent,
  monitoringConfigSchema,
} from '@chatapp/contracts'
export function monitoringCategory(path: string): MonitoringEvent['page'] {
  if (/^\/(login|register|verify-email|reset-password|forgot-password)(?:\/|$)/.test(path))
    return 'auth'
  if (path.startsWith('/admin')) return 'admin'
  if (path.startsWith('/c/')) return 'chat'
  if (path.startsWith('/privacy')) return 'public'
  return 'unknown'
}
export function sanitizedError(value: unknown, path: string): MonitoringEvent {
  const name = value instanceof Error || value instanceof DOMException ? value.name : 'Error'
  return {
    kind: MONITOR_ERROR_KINDS.find((kind) => kind === name) ?? 'Error',
    page: monitoringCategory(path),
  }
}
export function startMonitoring() {
  let enabled = false,
    remaining = 10
  const send = (value: unknown) => {
    if (!enabled || remaining <= 0) return
    remaining--
    // Public monitoring has no account or screen effect, and deliberately uses a cookie-free request.
    void fetch('/api/monitoring', {
      method: 'POST',
      body: JSON.stringify(sanitizedError(value, location.pathname)),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  }
  const error = (event: ErrorEvent) => send(event.error)
  const rejection = (event: PromiseRejectionEvent) => send(event.reason)
  window.addEventListener('error', error)
  window.addEventListener('unhandledrejection', rejection)
  void fetch('/api/monitoring/config', {
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(5000),
  })
    .then(async (response) => {
      if (response.ok) enabled = monitoringConfigSchema.parse(await response.json()).enabled
    })
    .catch(() => {})
  return () => {
    enabled = false
    window.removeEventListener('error', error)
    window.removeEventListener('unhandledrejection', rejection)
  }
}
