import { createVerifiedMember } from './support/api.ts'
import {
  createGroupApi,
  message,
  myId,
  openDmApi,
  openFromSidebar,
  sendApi,
  sidebarItem,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 5 (M2b) and L-05: C is not a member of a group or of A's and B's direct message. Every way
 * of reaching them answers as if they did not exist — the same words on the page, the same answer from the API — and the
 * sidebar does not list them. Messages are shown as text inside the timeline, never as a banner of the page (L-05).
 */
test('@smoke somebody who is not a member sees nothing of a group or a direct message, and it looks like nothing is there', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const carol = await createVerifiedMember('carol')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const groupName = `私密群${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, groupName, [bobId])
  const dmId = await openDmApi(apiA, bobId)
  const secretInGroup = await sendApi(apiA, groupId, '群里的秘密')
  const secretInDm = await sendApi(apiA, dmId, '私信里的秘密')

  await signIn(page, carol.email, carol.password)
  await expect(sidebarItem(page, groupName)).toHaveCount(0)
  await expect(page.getByText('群里的秘密')).toHaveCount(0)

  // What the page says for a conversation that does not exist, and for the two that are not C's.
  const nowhere = crypto.randomUUID()
  const looks = async (id: string): Promise<{ title: string; text: string }> => {
    await page.goto(`/c/${id}`)
    await expect(page.getByText('找不到这个会话', { exact: true })).toBeVisible()
    return { title: await page.title(), text: await page.locator('main').innerText() }
  }
  const missing = await looks(nowhere)
  expect(await looks(groupId)).toEqual(missing)
  expect(await looks(dmId)).toEqual(missing)
  expect(missing.text).not.toContain('秘密')

  // Every API path, the same refusal as for an id that was never used (the request id is the only difference).
  const paths = (id: string, messageId: string): string[] => [
    `/api/conversations/${id}`,
    `/api/conversations/${id}/messages`,
    `/api/conversations/${id}/members`,
    `/api/conversations/${id}/bans`,
    `/api/conversations/${id}/invites`,
    `/api/messages/${messageId}`,
  ]
  const answer = async (path: string): Promise<{ status: number; body: unknown }> => {
    const response = await page.request.get(path)
    const body = (await response.json()) as { error?: { requestId?: string } }
    if (body.error?.requestId !== undefined) body.error.requestId = '-'
    return { status: response.status(), body }
  }
  const baseline = await Promise.all(paths(nowhere, crypto.randomUUID()).map(answer))
  for (const [id, messageId] of [
    [groupId, secretInGroup.id],
    [dmId, secretInDm.id],
  ] as const) {
    const found = await Promise.all(paths(id, messageId).map(answer))
    expect(found.map((entry) => entry.status)).toEqual(baseline.map((entry) => entry.status))
    expect(found).toEqual(baseline)
  }
  expect(baseline.every((entry) => entry.status === 404)).toBe(true)
})

test('L-05: what people write in a direct message is text in the timeline, never a banner of the page', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const dmId = await openDmApi(apiA, bobId)
  const bait = '错误：你的登录已失效，请重新登录'
  await sendApi(apiA, dmId, bait)

  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, alice.name)
  await expect(message(page, bait)).toBeVisible()
  // No alert or banner on the page, and the text is only inside its article.
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.banner')).toHaveCount(0)
  await expect(page.locator('.timeline').getByText(bait)).toHaveCount(1)
})
