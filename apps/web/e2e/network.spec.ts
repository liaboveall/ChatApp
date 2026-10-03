import { createVerifiedMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { controlNetwork } from './support/network.ts'
import { signIn } from './support/ui.ts'

/**
 * The way end-to-end tests simulate a lost connection (V-14): see support/network.ts. This proves, against the real
 * application and in every engine, that the helper does what the M2b scenarios rely on: the open connection ends, the
 * client keeps trying with its back-off while the network is gone, and it is back on its own once the network returns.
 */
test('@smoke a dropped connection is retried with back-off and restored when the network returns', async ({
  page,
}) => {
  const person = await createVerifiedMember('offline')
  const network = await controlNetwork(page)
  await signIn(page, person.email, person.password)
  await expect.poll(() => network.connections()).toBe(1)

  await network.goOffline()
  expect(network.connections()).toBe(0)
  // The client notices, waits about a second, and tries again; every attempt is refused while we are offline.
  await expect.poll(() => network.refused(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
  const failedBefore = network.refused()
  expect(network.connections()).toBe(0)

  await network.goOnline()
  // The next attempt (back-off 1 s, 2 s, 4 s, with jitter) gets through to the server.
  await expect.poll(() => network.connections(), { timeout: 12_000 }).toBe(1)
  expect(network.refused()).toBeGreaterThanOrEqual(failedBefore)
})
