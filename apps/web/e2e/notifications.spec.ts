import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createChannelApi,
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendApi,
  sidebarItem,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { holdAnswer, identityStatus, signInInPlace, signOutInPlace } from './support/late.ts'
import { signIn } from './support/ui.ts'

/**
 * docs/01 section 4.8, M6: the notification centre in the browser. Somebody names or answers me while I am elsewhere: the bell
 * says so, the panel shows who and where, a click opens the message and reads the entry, the count goes, and another tab of mine
 * follows without being asked.
 */
test('@smoke a mention reaches the bell; opening it shows who and where; a click goes to the message and reads it', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiAlice = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `通知组${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiAlice, name, [bobId])

  // Bob is signed in twice: this page, and a second tab that must follow.
  await signIn(page, bob.email, bob.password)
  const second = await (await newContext(browser)).newPage()
  await signIn(second, bob.email, bob.password)
  await page.goto('/')
  const bell = page.getByRole('button', { name: /^通知/ })
  await expect(bell).toBeVisible()
  await expect(bell).toHaveAccessibleName('通知')

  // Alice names Bob after some chatter, and quotes nobody: one entry, and the count is 1.
  await sendApi(apiAlice, groupId, '随便聊聊')
  await expect(bell).toHaveAccessibleName('通知')
  const mention = await sendApi(apiAlice, groupId, `<@user:${bobId}> 看一下这个`)
  await expect(bell).toHaveAccessibleName('通知，1 条未读')
  await expect(second.getByRole('button', { name: '通知，1 条未读' })).toBeVisible()

  await bell.click()
  const panel = page.getByRole('dialog', { name: '通知' })
  await expect(panel).toBeVisible()
  const entry = panel.getByRole('button', {
    name: new RegExp(`${alice.name} 在「${name}」中提到了你`),
  })
  await expect(entry).toBeVisible()
  await expect(entry).toContainText('看一下这个')
  await expect(entry).toContainText('未读')

  // A click goes to the message and reads the entry; the panel closes.
  await entry.click()
  await expect(page).toHaveURL(new RegExp(`/c/${groupId}$`))
  await expect(message(page, '看一下这个')).toBeVisible()
  await expect(panel).toBeHidden()
  await expect(bell).toHaveAccessibleName('通知')
  await expect(second.getByRole('button', { name: '通知', exact: true })).toBeVisible()
  expect(mention.seq).toBeGreaterThan(0)

  // Opened again, the entry is still there and no longer unread.
  await bell.click()
  await expect(panel.getByRole('button', { name: /提到了你/ })).not.toContainText('未读')
  await expect(panel.getByRole('button', { name: '全部标为已读' })).toBeDisabled()
})

test('mark all as read, an empty centre, and a message that was withdrawn loses its words', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiAlice = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `撤回组${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiAlice, name, [bobId])
  await signIn(page, bob.email, bob.password)

  const bell = page.getByRole('button', { name: /^通知/ })
  await bell.click()
  const panel = page.getByRole('dialog', { name: '通知' })
  await expect(panel.getByText('没有通知', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  await sendApi(apiAlice, groupId, `<@user:${bobId}> 第一条`)
  const second = await sendApi(apiAlice, groupId, `<@user:${bobId}> 第二条秘密`)
  await expect(bell).toHaveAccessibleName('通知，2 条未读')
  await bell.click()
  await expect(panel.getByRole('button', { name: /提到了你/ })).toHaveCount(2)

  // Withdrawn: the entry stays but says nothing of what was said.
  const recall = await apiAlice.post(`/api/messages/${second.id}/recall`)
  expect(recall.ok()).toBe(true)
  await expect(panel.getByText('消息已撤回')).toBeVisible()
  await expect(panel).not.toContainText('第二条秘密')

  await panel.getByRole('button', { name: '全部标为已读' }).click()
  await expect(bell).toHaveAccessibleName('通知')
  await expect(panel.getByRole('button', { name: '全部标为已读' })).toBeDisabled()
})

test('a click during source invalidation rechecks the entry and still opens its authorized conversation', async ({
  page,
}) => {
  const alice = await createVerifiedMember('noticeclicka')
  const bob = await createVerifiedMember('noticeclickb')
  const apiAlice = await signedIn(alice)
  const apiBob = await signedIn(bob)
  const name = `点击复核${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiAlice, name, [await myId(apiBob)])
  await signIn(page, bob.email, bob.password)
  await sendApi(apiAlice, groupId, `<@user:${await myId(apiBob)}> 点击中的来源`)
  const bell = page.getByRole('button', { name: '通知，1 条未读' })
  await expect(bell).toBeVisible()
  await bell.click()
  const panel = page.getByRole('dialog', { name: '通知' })
  const entry = panel.getByRole('button', { name: /提到了你/ })
  await expect(entry).toBeVisible()
  const list = await apiBob.get('/api/notifications')
  const notice = ((await list.json()) as { items: Array<{ id: string }> }).items[0]
  if (!notice) throw new Error('the mention was not derived')
  const held = await holdAnswer(page, /\/api\/notifications\?/, 'GET')
  const box = await entry.boundingBox()
  if (!box) throw new Error('the entry is not on screen')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // Another device marks it while the pointer is down. The personal hint invalidates the projection, and its re-read is
  // held: the button is still there on pointer-up, but its render-time target is now "none".
  expect((await apiBob.post('/api/notifications/read', { data: { ids: [notice.id] } })).ok()).toBe(
    true,
  )
  await held.reached
  await expect(panel.getByRole('button', { name: /已经看不到/ })).toBeVisible()
  await page.mouse.up()
  await held.deliver()
  await expect(page).toHaveURL(new RegExp(`/c/${groupId}$`))
  await expect(message(page, '点击中的来源')).toBeVisible()
  await expect(panel).toBeHidden()
})

test('a loaded notification loses its source immediately when the reader leaves the conversation', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiAlice = await signedIn(alice)
  const apiBob = await signedIn(bob)
  const bobId = await myId(apiBob)
  const name = `退出通知组${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiAlice, name, [bobId])
  await signIn(page, bob.email, bob.password)
  await sendApi(apiAlice, groupId, `<@user:${bobId}> 不应保留的通知秘密`)
  const bell = page.getByRole('button', { name: /^通知/ })
  await expect(bell).toHaveAccessibleName('通知，1 条未读')
  await bell.click()
  const panel = page.getByRole('dialog', { name: '通知' })
  await expect(panel).toContainText('不应保留的通知秘密')
  expect((await apiBob.post(`/api/conversations/${groupId}/leave`, { data: {} })).ok()).toBe(true)
  await expect(panel).not.toContainText('不应保留的通知秘密')
  await expect(panel).not.toContainText(name)
})

test('a late source recheck for a click never navigates the next account or changes its draft', async ({
  page,
}) => {
  const alice = await createVerifiedMember('noticeolda')
  const bob = await createVerifiedMember('noticeoldb')
  const carol = await createVerifiedMember('noticenewc')
  const apiAlice = await signedIn(alice)
  const apiBob = await signedIn(bob)
  const groupId = await createGroupApi(apiAlice, `旧通知${Date.now().toString(36)}`, [
    await myId(apiBob),
  ])
  const nextName = `新账号${Date.now().toString(36)}`
  await createChannelApi(await signedIn(carol), nextName)
  await signIn(page, bob.email, bob.password)
  await sendApi(apiAlice, groupId, `<@user:${await myId(apiBob)}> 前一人的通知`)
  const bell = page.getByRole('button', { name: '通知，1 条未读' })
  await expect(bell).toBeVisible()
  await bell.click()
  const panel = page.getByRole('dialog', { name: '通知' })
  const entry = panel.getByRole('button', { name: /提到了你/ })
  await expect(entry).toBeVisible()
  const notices = (
    (await (await apiBob.get('/api/notifications')).json()) as { items: Array<{ id: string }> }
  ).items
  if (!notices[0]) throw new Error('the mention was not derived')
  const initial = await holdAnswer(page, /\/api\/notifications\?/, 'GET')
  const box = await entry.boundingBox()
  if (!box) throw new Error('the entry is not on screen')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  expect(
    (await apiBob.post('/api/notifications/read', { data: { ids: [notices[0].id] } })).ok(),
  ).toBe(true)
  await initial.reached
  await expect(panel.getByRole('button', { name: /已经看不到/ })).toBeVisible()
  const clickRead = await holdAnswer(page, /\/api\/notifications\?/, 'GET')
  await page.mouse.up()
  await clickRead.reached
  await signOutInPlace(page)
  await signInInPlace(page, carol.email, carol.password)
  await openFromSidebar(page, nextName)
  await composer(page).fill('新账号尚未发送的草稿')
  const where = page.url()
  await clickRead.deliver()
  await initial.deliver()
  await expect(page).toHaveURL(where)
  await expect(composer(page)).toHaveValue('新账号尚未发送的草稿')
  expect(await identityStatus(page)).toBe(200)
})

test('a late notification projection cannot restore words withdrawn after the request began', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiAlice = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const groupId = await createGroupApi(apiAlice, `迟到通知${Date.now().toString(36)}`, [bobId])
  await signIn(page, bob.email, bob.password)
  const sent = await sendApi(apiAlice, groupId, `<@user:${bobId}> 迟到的秘密`)
  const bell = page.getByRole('button', { name: /^通知/ })
  await expect(bell).toHaveAccessibleName('通知，1 条未读')
  const held = await holdAnswer(page, /\/api\/notifications\?limit=30$/, 'GET')
  await bell.click()
  await held.reached
  const panel = page.getByRole('dialog', { name: '通知' })
  expect((await apiAlice.post(`/api/messages/${sent.id}/recall`)).ok()).toBe(true)
  await expect(panel.getByText('消息已撤回')).toBeVisible()
  await held.deliver()
  await expect(panel.getByText('消息已撤回')).toBeVisible()
  await expect(panel).not.toContainText('迟到的秘密')
})

test('a withdrawn source on an older loaded page is re-projected too', async ({ page }) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiAlice = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const groupId = await createGroupApi(apiAlice, `翻页通知${Date.now().toString(36)}`, [bobId])
  // Stay below the real per-conversation send limit while creating enough notifications to require a second page.
  const groups = [groupId]
  for (let n = 1; n < 4; n += 1)
    groups.push(await createGroupApi(apiAlice, `翻页通知${Date.now().toString(36)}-${n}`, [bobId]))
  const old = await sendApi(apiAlice, groupId, `<@user:${bobId}> 最旧的秘密`)
  for (let n = 0; n < 30; n += 1)
    await sendApi(
      apiAlice,
      groups[Math.floor((n + 1) / 8)] ?? groupId,
      `<@user:${bobId}> 新通知 ${n}`,
    )
  await signIn(page, bob.email, bob.password)
  const bell = page.getByRole('button', { name: /^通知/ })
  await expect(bell).toHaveAccessibleName('通知，31 条未读')
  await bell.click()
  const panel = page.getByRole('dialog', { name: '通知' })
  await panel.getByRole('button', { name: '更早的通知' }).click()
  await expect(panel).toContainText('最旧的秘密')
  expect((await apiAlice.post(`/api/messages/${old.id}/recall`)).ok()).toBe(true)
  await expect(panel).not.toContainText('最旧的秘密')
  await expect(panel.getByText('消息已撤回')).toBeVisible()
})

test('the tab title and the sidebar carry the unread count, and reading takes it away', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiAlice = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `标题组${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiAlice, name, [bobId])
  await signIn(page, bob.email, bob.password)
  await expect(page).toHaveTitle('ChatApp')

  await sendApi(apiAlice, groupId, '一')
  await sendApi(apiAlice, groupId, '二')
  await expect(page).toHaveTitle('(2) ChatApp')
  await sidebarItem(page, name).click()
  await expect(message(page, '二')).toBeVisible()
  await expect(page).toHaveTitle(new RegExp(`^${name} · ChatApp$`), { timeout: 8_000 })
})
