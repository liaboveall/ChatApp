import { createVerifiedMember } from './support/api.ts'
import {
  createGroupApi,
  editApi,
  message,
  myId,
  openFromSidebar,
  sendApi,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { controlNetwork } from './support/network.ts'
import { signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 3 (M2b): B drops off the network, A writes and edits meanwhile; when B comes back every
 * change has caught up and nothing is there twice. Also AC-06: a hint that never arrives is made up for by the periodic
 * reconciliation within 35 seconds. The disconnection is the one of `support/network.ts` (V-14, D-134).
 */
test('@smoke what happened while B was offline catches up when B is back, and nothing is doubled', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `离线群${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, name, [bobId])
  await sendApi(apiA, groupId, '断线之前')

  // B is in the conversation, connected.
  const network = await controlNetwork(page)
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(message(page, '断线之前')).toBeVisible()
  await expect.poll(() => network.connections()).toBe(1)

  await network.goOffline()
  expect(network.connections()).toBe(0)

  // While B is away: three messages, and the second is edited.
  await sendApi(apiA, groupId, '离线一')
  const second = await sendApi(apiA, groupId, '离线二')
  await sendApi(apiA, groupId, '离线三')
  await editApi(apiA, second.id, '离线二（改过）')

  await network.goOnline()
  await expect(message(page, '离线一')).toHaveCount(1)
  await expect(message(page, '离线二（改过）')).toHaveCount(1)
  await expect(message(page, '离线二（改过）')).toContainText('已编辑')
  await expect(message(page, '离线三')).toHaveCount(1)
  // The text before the edit is gone, and each message is there exactly once: three from the outage, one from before.
  await expect(page.getByText('离线二', { exact: true })).toHaveCount(0)
  await expect(page.locator('article[data-message-id]').filter({ hasText: '离线' })).toHaveCount(3)
  await expect(message(page, '断线之前')).toHaveCount(1)
})

test('a hint that never arrives is made up for by the periodic reconciliation within 35 seconds (AC-06)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `漏掉提示${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, name, [bobId])

  const network = await controlNetwork(page)
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect.poll(() => network.connections()).toBe(1)

  // The connection stays up, but the server's hints are swallowed on the way.
  network.muteHints(true)
  await sendApi(apiA, groupId, '没有提示的消息')
  await expect.poll(() => network.droppedHints(), { timeout: 5_000 }).toBeGreaterThan(0)

  // No hint, so nothing yet; the reconciliation (every 24 to 30 seconds while the page is in front) finds it.
  const started = Date.now()
  await expect(message(page, '没有提示的消息')).toBeVisible({ timeout: 35_000 })
  expect(Date.now() - started).toBeLessThanOrEqual(35_000)
})
