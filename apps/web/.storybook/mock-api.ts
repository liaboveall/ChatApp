/**
 * A tiny in-browser stand-in for the API, so stories of screens that load data render the same way every time and need
 * no server. A story lists the answers it wants in `parameters.api`; anything else is a 404, which the app shows as an
 * error state (that is a story too).
 */
export type MockAnswer = { status?: number; body?: unknown; delayMs?: number }
export type MockApi = Record<string, MockAnswer | ((init: RequestInit | undefined) => MockAnswer)>

let installed: typeof fetch | undefined

export function installMockApi(api: MockApi): void {
  installed ??= window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.href,
    )
    const method = (init?.method ?? 'GET').toUpperCase()
    const entry = api[`${method} ${url.pathname}`] ?? api[url.pathname]
    if (!entry) {
      return new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No mock', requestId: 'mock' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      )
    }
    const answer = typeof entry === 'function' ? entry(init) : entry
    if (answer.delayMs) await new Promise((resolve) => setTimeout(resolve, answer.delayMs))
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
}

export function restoreFetch(): void {
  if (installed) window.fetch = installed
}

export const sampleMe = {
  id: '0198d0c0-0000-7000-8000-000000000001',
  profileVersion: 1,
  username: 'alice',
  displayName: 'Alice Chen',
  avatarUrl: null,
  isBot: false,
  deleted: false,
  meVersion: 3,
  authEpoch: 0,
  restoreEpoch: 'epoch',
  email: 'alice@example.test',
  role: 'user',
  bio: null,
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  settings: {},
  inviteQuota: 5,
  invitesUsed: 2,
  storageUsedBytes: 0,
  storageQuotaBytes: 5368709120,
  aiDailyTokens: 500000,
} as const
