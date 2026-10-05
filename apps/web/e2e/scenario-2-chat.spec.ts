import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createChannelInUi,
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendFromComposer,
  sidebarItem,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 2 (M2b): A creates a channel and B joins it; both send and receive in real time, both see
 * the other typing, and the unread counts are right.
 */
test('@smoke A creates a channel, B joins; they talk in real time, see each other typing, and the unread counts are right', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const name = `频道${Date.now().toString(36)}`

  // A creates the channel through the "New" menu.
  await signIn(page, alice.email, alice.password)
  await createChannelInUi(page, name, '用来聊天的频道')
  await expect(page.getByText(`这是 ${name} 的开始`)).toBeVisible()

  // B finds it in the channel directory and joins.
  const bobContext = await newContext(browser)
  const b = await bobContext.newPage()
  await signIn(b, bob.email, bob.password)
  await b.goto('/channels')
  await b.getByLabel('搜索频道').fill(name)
  await b
    .locator('.list-row')
    .filter({ hasText: name })
    .getByRole('button', { name: '加入' })
    .click()
  await expect(b).toHaveURL(/\/c\//)
  await expect(composer(b)).toBeVisible()

  // Messages both ways, in real time (nothing is reloaded).
  await sendFromComposer(page, '你好，Bob')
  await expect(message(b, '你好，Bob')).toBeVisible()
  await sendFromComposer(b, '你好，Alice')
  await expect(message(page, '你好，Alice')).toBeVisible()

  // Typing: A sees B typing while B has text in the field, and it goes when B clears it.
  await composer(b).pressSequentially('我正在打字')
  await expect(page.getByText(`${bob.name} 正在输入…`)).toBeVisible()
  await composer(b).fill('')
  await expect(page.getByText(`${bob.name} 正在输入…`)).toBeHidden({ timeout: 8_000 })

  // Unread: B is looking at the channel, so a message that arrives is read at once.
  await sendFromComposer(page, '你在看的时候来的')
  await expect(message(b, '你在看的时候来的')).toBeVisible()
  await expect(sidebarItem(b, name)).not.toHaveAccessibleName(/未读/)

  // B goes elsewhere; two messages from A count as two unread, with the line where they begin when B comes back.
  await b.goto('/channels')
  await sendFromComposer(page, '第一条新消息')
  await sendFromComposer(page, '第二条新消息')
  await expect(sidebarItem(b, name)).toHaveAccessibleName(new RegExp(`^${name}, 2 条未读`))
  await sidebarItem(b, name).click()
  await expect(b.locator('.unread-div')).toBeVisible()
  await expect(message(b, '第一条新消息')).toBeVisible()
  // Reading them clears the count.
  await expect(sidebarItem(b, name)).not.toHaveAccessibleName(/未读/, { timeout: 8_000 })
  await expect(sidebarItem(page, name)).not.toHaveAccessibleName(/未读/)
})

test('somebody who has said nothing yet is named when typing', async ({ page, browser }) => {
  // A group made with both in it has no "joined" line, so A has nothing that names B until B is seen typing.
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const name = `没开口的群${Date.now().toString(36)}`
  await createGroupApi(apiA, name, [await myId(await signedIn(bob))])

  await signIn(page, alice.email, alice.password)
  const bobContext = await newContext(browser)
  const b = await bobContext.newPage()
  await signIn(b, bob.email, bob.password)
  await openFromSidebar(page, name)
  await openFromSidebar(b, name)

  await composer(b).pressSequentially('我还没发')
  await expect(page.getByText(`${bob.name} 正在输入…`)).toBeVisible()
  await expect(page.getByText('某位成员 正在输入…')).toHaveCount(0)
})
