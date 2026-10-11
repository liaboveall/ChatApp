import { beforeEach, expect, test, vi } from 'vitest'
import { tellWorker } from './bridge.ts'
import { forgetDevice } from './device.ts'

const f = vi.hoisted(() => ({ registration: vi.fn() }))
vi.mock('./register.ts', () => ({ currentRegistration: f.registration }))

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => vi.clearAllMocks())

test('an old identity message waiting for a registration is never delivered after the next login', async () => {
  const registration = deferred<ServiceWorkerRegistration>()
  f.registration.mockReturnValue(registration.promise)
  let current = true
  const telling = tellWorker(
    { type: 'identity', userId: 'alice', installationId: 'device' },
    () => current,
  )
  current = false
  const postMessage = vi.fn()
  registration.resolve({ active: { postMessage } } as unknown as ServiceWorkerRegistration)
  await telling
  expect(postMessage).not.toHaveBeenCalled()
})

test('logout waiting for the registration does not drop the next account subscription', async () => {
  const registration = deferred<ServiceWorkerRegistration>()
  f.registration.mockReturnValue(registration.promise)
  let current = true
  const forgetting = forgetDevice('alice', () => current)
  current = false
  const getSubscription = vi.fn()
  const postMessage = vi.fn()
  registration.resolve({
    active: { postMessage },
    pushManager: { getSubscription },
  } as unknown as ServiceWorkerRegistration)
  await forgetting
  expect(getSubscription).not.toHaveBeenCalled()
  expect(postMessage).not.toHaveBeenCalled()
})

test('logout waiting for the subscription does not unsubscribe the next account', async () => {
  const subscription = deferred<PushSubscription>()
  const getSubscription = vi.fn(() => subscription.promise)
  f.registration.mockResolvedValue({
    active: { postMessage: vi.fn() },
    pushManager: { getSubscription },
  })
  let current = true
  const forgetting = forgetDevice('alice', () => current)
  await vi.waitFor(() => expect(getSubscription).toHaveBeenCalled())
  current = false
  const unsubscribe = vi.fn()
  subscription.resolve({ unsubscribe } as unknown as PushSubscription)
  await forgetting
  expect(unsubscribe).not.toHaveBeenCalled()
})

test('an ending account is forgotten and unsubscribed while its generation is current', async () => {
  const unsubscribe = vi.fn(async () => true)
  const postMessage = vi.fn()
  f.registration.mockResolvedValue({
    active: { postMessage },
    pushManager: { getSubscription: async () => ({ unsubscribe }) },
  })
  await forgetDevice('alice', () => true)
  expect(postMessage).toHaveBeenCalledWith({ type: 'signed-out', userId: 'alice' })
  expect(unsubscribe).toHaveBeenCalledOnce()
})
