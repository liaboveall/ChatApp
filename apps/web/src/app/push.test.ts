import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { disablePushHere, enablePushHere } from './push.ts'

const f = vi.hoisted(() => ({
  session: 1,
  userId: 'alice',
  api: vi.fn(),
  registration: vi.fn(),
  tellWorker: vi.fn(async () => undefined),
}))
vi.mock('@/app/sync.ts', () => ({
  engine: {
    ticket: () => ({ session: f.session, scope: { userId: f.userId } }),
    isCurrent: (ticket: { session: number }) => ticket.session === f.session,
  },
  forScreen: async (_id: unknown, request: () => Promise<unknown>) => {
    const session = f.session
    const answer = await request()
    return session === f.session ? answer : null
  },
}))
vi.mock('@/lib/api.ts', () => ({ api: f.api, ApiError: class extends Error {} }))
vi.mock('@/lib/pwa/register.ts', () => ({ currentRegistration: f.registration }))
vi.mock('@/lib/pwa/bridge.ts', () => ({ tellWorker: f.tellWorker }))
vi.mock('@/lib/push/installation.ts', () => ({ installationId: () => 'installation' }))
vi.mock('@/lib/push/support.ts', () => ({
  pushSupport: () => ({ supported: true }),
  notificationPermission: () => 'granted',
  keyBytes: () => new Uint8Array([1]),
  sameKey: () => true,
}))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const changeAccount = () => {
  f.session += 1
  f.userId = 'bob'
}

let unsubscribe: ReturnType<typeof vi.fn>
let subscribe: ReturnType<typeof vi.fn>
let getSubscription: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.clearAllMocks()
  f.session = 1
  f.userId = 'alice'
  unsubscribe = vi.fn(async () => true)
  const subscription = {
    options: { applicationServerKey: new Uint8Array([1]).buffer },
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/test',
      keys: { p256dh: 'key', auth: 'auth' },
    }),
    unsubscribe,
  }
  getSubscription = vi.fn(async () => subscription)
  subscribe = vi.fn(async () => subscription)
  f.registration.mockResolvedValue({ pushManager: { getSubscription, subscribe } })
  f.api.mockImplementation(async (url: string) =>
    url.endsWith('vapid-key') ? { publicKey: 'AQ' } : { subscription: { id: 'saved' } },
  )
  vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => 'granted') })
})
afterEach(() => vi.unstubAllGlobals())

test('permission granted after a different account signed in makes no request or identity change', async () => {
  const permission = deferred<NotificationPermission>()
  vi.mocked(Notification.requestPermission).mockReturnValue(permission.promise)
  const enabling = enablePushHere('alice')
  changeAccount()
  permission.resolve('granted')
  expect(await enabling).toBe('session-changed')
  expect(f.api).not.toHaveBeenCalled()
  expect(f.tellWorker).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
})

test('a subscription read that outlives its account cannot tell the worker the old identity or bind the endpoint to the new one', async () => {
  const read = deferred<null>()
  getSubscription.mockReturnValue(read.promise)
  const enabling = enablePushHere('alice')
  await vi.waitFor(() => expect(getSubscription).toHaveBeenCalled())
  changeAccount()
  read.resolve(null)
  expect(await enabling).toBe('session-changed')
  expect(subscribe).not.toHaveBeenCalled()
  expect(f.tellWorker).not.toHaveBeenCalled()
  expect(f.api.mock.calls.map(([url]) => url)).toEqual(['/api/push/vapid-key'])
})

test('disabling an old account stops after a stale delete and never unsubscribes the new account', async () => {
  const deleting = deferred<{ id: string }>()
  f.api.mockImplementation(async (url: string) =>
    url.includes('?') ? { subscriptions: [{ id: 'old', current: true }] } : deleting.promise,
  )
  const disabling = disablePushHere()
  await vi.waitFor(() => expect(f.api).toHaveBeenCalledTimes(2))
  changeAccount()
  deleting.resolve({ id: 'old' })
  expect(await disabling).toBe(false)
  expect(unsubscribe).not.toHaveBeenCalled()
})

test('a successful subscription belongs to the account that started the operation', async () => {
  expect(await enablePushHere('alice')).toBe('enabled')
  expect(f.tellWorker).toHaveBeenCalledWith(
    { type: 'identity', userId: 'alice', installationId: 'installation' },
    expect.any(Function),
  )
  expect(f.api.mock.calls.map(([url]) => url)).toEqual([
    '/api/push/vapid-key',
    '/api/push/subscriptions',
  ])
})
