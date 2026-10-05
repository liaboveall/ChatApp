import type { APIRequestContext, Page, Response } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import {
  addMembersApi,
  composer,
  createChannelApi,
  createGroupApi,
  message,
  myId,
  openDetails,
  openFromSidebar,
  sendApi,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * Answers that come back late, and what was written under a membership that has ended (M2b review 2026-10-05, D-171,
 * SEC-34, AT-12, AT-31): a request keeps what it was made for. The answer to a send, held back after the server has
 * already done what was asked, cannot bring back the quote of a message recalled in the meantime (R1), cannot enter the
 * timeline of whoever signs in next or of the membership that came after (R3); and a reply or an edit that was in
 * progress is not there any more when the person joins again (R4). A page of older messages that was read before a
 * recall cannot bring the recalled text back when it replaces the window (R2). The held answer is delivered, and the
 * page is given its turn to act on it, before anything is asserted: the assertion is about what the page does with a
 * late answer.
 */

/**
 * Holds the answer to the first matching request until `deliver()`. The server has handled the request by then (its effect
 * is real and stays), the page has not been told yet. `deliver` gives the page the answer and then a few frames to act on it.
 */
async function holdAnswer<T = { message: { id: string; seq: number } }>(
  page: Page,
  url: RegExp,
  method: string,
) {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached: (body: T) => void = () => undefined
  const answered = new Promise<T>((resolve) => {
    reached = resolve
  })
  let fulfilled: () => void = () => undefined
  const given = new Promise<void>((resolve) => {
    fulfilled = resolve
  })
  let taken = false
  await page.route(url, async (route) => {
    if (taken || route.request().method() !== method) return route.continue()
    taken = true
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    reached((await response.json()) as T)
    await gate
    await route.fulfill({ response })
    fulfilled()
  })
  return {
    /** The server has handled it; what the answer says. */
    reached: answered,
    async deliver(): Promise<void> {
      release()
      await given
      // The page reads the body and acts on it in the turns after the answer arrives: let two frames pass.
      await frames(page)
    },
  }
}

/** Two animation frames: what the page does with an answer it was just given (reading the body, merging, rendering) is done. */
const frames = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

/** Resolves once the page has received, in its catch-up reads of the conversation, a version of every one of these messages. */
function waitForChanges(page: Page, conversationId: string, messageIds: string[]): Promise<void> {
  const missing = new Set(messageIds)
  return new Promise((resolve) => {
    const listener = async (response: Response): Promise<void> => {
      if (!response.url().includes(`/api/conversations/${conversationId}/changes`)) return
      const body = await response.text().catch(() => '')
      for (const messageId of [...missing]) if (body.includes(messageId)) missing.delete(messageId)
      if (missing.size > 0) return
      page.off('response', listener)
      resolve()
    }
    page.on('response', listener)
  })
}

/**
 * Records whether a text is in the elements matching `css` at any moment from now on (a mutation observer, not a poll, so
 * that a text that is there for a single frame is seen); the returned function says whether it ever was.
 */
async function watchText(page: Page, css: string, needle: string): Promise<() => Promise<boolean>> {
  const key = `__seen:${css}:${needle}`
  await page.evaluate(
    ([selector, text, flag]) => {
      const holder = window as unknown as Record<string, boolean>
      const look = (): boolean =>
        [...document.querySelectorAll(selector as string)].some((element) =>
          (element.textContent ?? '').includes(text as string),
        )
      holder[flag as string] = look()
      new MutationObserver(() => {
        if (look()) holder[flag as string] = true
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    },
    [css, needle, key],
  )
  return () =>
    page.evaluate((flag) => (window as unknown as Record<string, boolean>)[flag] === true, key)
}

/** Signs out through the settings panel without leaving the page: a held request stays alive only in the same document. */
async function signOutInPlace(page: Page): Promise<void> {
  await composer(page).blur()
  await page.keyboard.press('Control+,')
  await page
    .getByRole('dialog', { name: '设置' })
    .getByRole('link', { name: '账号', exact: true })
    .click()
  await page.getByRole('button', { name: '退出登录' }).click()
  await expect(page).toHaveURL(/\/login/)
}

async function signInInPlace(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('邮箱').fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()
}

test('R1: a late answer to a send cannot bring back the quote of a message that was recalled meanwhile', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r1alice')
  const bob = await createVerifiedMember('r1bob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const name = `R1-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await expect(composer(page)).toBeVisible()

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${id}/messages$`), 'POST')
  await sendFromComposer(page, 'R1_SOURCE_TEXT')
  const sent = await held.reached
  // Bob quotes it; the page learns of the reply through the log and shows what the quote says.
  await sendApi(apiB, id, 'R1_REPLY_TEXT', sent.message.id)
  const quote = message(page, 'R1_REPLY_TEXT').locator('.bubble__quote')
  await expect(quote).toContainText('R1_SOURCE_TEXT')
  // Alice withdraws it from another place: the quote reads "recalled".
  expect((await apiA.post(`/api/messages/${sent.message.id}/recall`, { data: {} })).ok()).toBe(true)
  await expect(quote).toHaveText('原消息已撤回')

  // Now the answer that is older than the recall arrives.
  const quoted = await watchText(page, '.bubble__quote', 'R1_SOURCE_TEXT')
  await held.deliver()
  await expect(quote).toHaveText('原消息已撤回')
  expect(await quoted()).toBe(false)
  // The page is alive and in step: a message sent now goes through and the quote still reads recalled.
  await sendFromComposer(page, 'R1_AFTER')
  await expect(message(page, 'R1_AFTER')).toBeVisible()
  await expect(quote).toHaveText('原消息已撤回')
  expect(await quoted()).toBe(false)
})

test('R3: the answer to a send made before another person signed in never shows in that person’s timeline', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r3alice')
  const bob = await createVerifiedMember('r3bob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const name = `R3-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await expect(composer(page)).toBeVisible()

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${id}/messages$`), 'POST')
  await sendFromComposer(page, 'R3_ACCOUNT_A_PRE_JOIN_SECRET')
  const sent = await held.reached
  // Bob joins after it: the server really does not show it to him.
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  expect((await apiB.get(`/api/messages/${sent.message.id}`)).status()).toBe(404)

  // Alice signs out and Bob signs in, in the same page, with the request still out.
  await signOutInPlace(page)
  await signInInPlace(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(composer(page)).toBeVisible()
  await expect(message(page, 'R3_ACCOUNT_A_PRE_JOIN_SECRET')).toHaveCount(0)

  const seen = await watchText(page, 'body', 'R3_ACCOUNT_A_PRE_JOIN_SECRET')
  await held.deliver()
  await expect(message(page, 'R3_ACCOUNT_A_PRE_JOIN_SECRET')).toHaveCount(0)
  expect(await seen()).toBe(false)
  await expect(page.getByText('R3_ACCOUNT_A_PRE_JOIN_SECRET')).toHaveCount(0)
  // Bob's own page works, and still shows nothing of Alice's.
  await sendFromComposer(page, 'R3_BOB_AFTER')
  await expect(message(page, 'R3_BOB_AFTER')).toBeVisible()
  expect(await seen()).toBe(false)
})

test('R3: the answer to a send made before the person left and joined again does not enter the new membership', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r3lalice')
  const bob = await createVerifiedMember('r3lbob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const name = `R3L-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(composer(page)).toBeVisible()

  const held = await holdAnswer(page, new RegExp(`/api/conversations/${id}/messages$`), 'POST')
  await sendFromComposer(page, 'R3_BOB_BEFORE_LEAVING')
  const sent = await held.reached
  await openDetails(page)
  await page.getByRole('button', { name: '退出会话' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退出', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  expect((await apiB.get(`/api/messages/${sent.message.id}`)).status()).toBe(404)
  await openFromSidebar(page, name)
  await expect(composer(page)).toBeVisible()
  await expect(message(page, 'R3_BOB_BEFORE_LEAVING')).toHaveCount(0)

  const seen = await watchText(page, 'body', 'R3_BOB_BEFORE_LEAVING')
  await held.deliver()
  await expect(message(page, 'R3_BOB_BEFORE_LEAVING')).toHaveCount(0)
  expect(await seen()).toBe(false)
  await sendFromComposer(page, 'R3_BOB_AFTER_JOINING')
  await expect(message(page, 'R3_BOB_AFTER_JOINING')).toBeVisible()
  expect(await seen()).toBe(false)
})

for (const mode of ['reply', 'edit'] as const) {
  /** Puts the person in the middle of a reply or an edit that quotes (or is) a message from before the membership ends. */
  async function startWriting(page: Page, text: string): Promise<void> {
    await message(page, text).click({ button: 'right' })
    await page
      .getByRole('menuitem', { name: mode === 'reply' ? '回复' : '编辑', exact: true })
      .click()
    if (mode === 'reply') {
      await expect(page.locator('.composer__ctx')).toContainText(text)
    } else {
      await expect(page.locator('.composer__ctx')).toContainText('正在编辑')
      await expect(composer(page)).toHaveValue(text)
    }
  }

  /** Neither the bar, nor the old text in it, nor the text that was set aside for the edit is back in the field. */
  async function expectNothingLeft(page: Page, text: string): Promise<void> {
    await expect(composer(page)).toBeVisible()
    await expect(page.locator('.composer__ctx')).toHaveCount(0)
    await expect(composer(page)).toHaveValue('')
    await expect(page.getByText(text)).toHaveCount(0)
  }

  test(`R4: a ${mode} in progress is gone when the person leaves the channel and joins it again`, async ({
    page,
  }) => {
    const alice = await createVerifiedMember(`r4${mode}a`)
    const bob = await createVerifiedMember(`r4${mode}b`)
    const apiA = await signedIn(alice)
    const apiB = await signedIn(bob)
    const name = `R4${mode}-${Date.now().toString(36)}`
    const id = await createChannelApi(apiA, name)
    expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
    const text = `R4_PRE_REJOIN_${mode.toUpperCase()}_TEXT`
    const stash = 'R4_DRAFT_TYPED_BEFORE'
    const source = await sendApi(mode === 'reply' ? apiA : apiB, id, text)
    await signIn(page, bob.email, bob.password)
    await openFromSidebar(page, name)
    await expect(message(page, text)).toBeVisible()
    await composer(page).fill(stash)
    await startWriting(page, text)

    await openDetails(page)
    await page.getByRole('button', { name: '退出会话' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '退出', exact: true }).click()
    await expect(page).toHaveURL(/\/$/)
    expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
    expect((await apiB.get(`/api/messages/${source.id}`)).status()).toBe(404)
    await openFromSidebar(page, name)
    await expectNothingLeft(page, text)
  })

  test(`R4: a ${mode} in progress is gone when the person is removed from the group and added again`, async ({
    page,
  }) => {
    const alice = await createVerifiedMember(`r4r${mode}a`)
    const bob = await createVerifiedMember(`r4r${mode}b`)
    const apiA = await signedIn(alice)
    const apiB = await signedIn(bob)
    const bobId = await myId(apiB)
    const name = `R4r${mode}-${Date.now().toString(36)}`
    const groupId = await createGroupApi(apiA, name, [bobId])
    const text = `R4_PRE_REMOVAL_${mode.toUpperCase()}_TEXT`
    const stash = 'R4_DRAFT_TYPED_BEFORE'
    const source = await sendApi(mode === 'reply' ? apiA : apiB, groupId, text)
    await signIn(page, bob.email, bob.password)
    await openFromSidebar(page, name)
    await expect(message(page, text)).toBeVisible()
    await composer(page).fill(stash)
    await startWriting(page, text)

    expect((await apiA.delete(`/api/conversations/${groupId}/members/${bobId}`)).ok()).toBe(true)
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 })
    await addMembersApi(apiA, groupId, [bobId])
    expect((await apiB.get(`/api/messages/${source.id}`)).status()).toBe(404)
    await openFromSidebar(page, name)
    await expectNothingLeft(page, text)
  })
}

test('R2: a page of older messages that was read before a recall does not bring the recalled text back when it replaces the window', async ({
  page,
}) => {
  // Seven people write the messages (a person may send ten in ten seconds in one conversation) so that the quoted message
  // lies beyond the newest page of fifty.
  const alice = await createVerifiedMember('r2alice')
  const helpers: Awaited<ReturnType<typeof createVerifiedMember>>[] = []
  for (let n = 1; n <= 6; n += 1) helpers.push(await createVerifiedMember(`r2h${n}`))
  const apiA = await signedIn(alice)
  const apiHelpers = await Promise.all(helpers.map((person) => signedIn(person)))
  const name = `R2-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  for (const api of apiHelpers) {
    expect((await api.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  }

  const source = await sendApi(apiA, id, 'R2_OLD_SOURCE')
  const fills: Array<{ id: string; seq: number; text: string; api: APIRequestContext }> = []
  const write = async (api: APIRequestContext, count: number): Promise<void> => {
    for (let n = 0; n < count; n += 1) {
      const text = `R2_FILL_${String(fills.length + 1).padStart(2, '0')}`
      fills.push({ ...(await sendApi(api, id, text)), text, api })
    }
  }
  await write(apiA, 4)
  for (const api of apiHelpers.slice(0, 5)) await write(api, 9)
  await write(apiHelpers[5] ?? apiA, 3)
  const reply = await sendApi(apiA, id, 'R2_REPLY_TEXT', source.id)
  // Fifty-three messages after the source: the newest page (the last fifty) starts at the fourth of them.
  expect(reply.seq - source.seq).toBe(53)
  const inBoth = fills[4]
  const onlyInPage = fills[2]
  if (inBoth === undefined || onlyInPage === undefined) throw new Error('messages were not written')

  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await expect(message(page, 'R2_REPLY_TEXT')).toBeVisible()
  await expect(page.locator(`article[data-seq="${source.seq}"]`)).toHaveCount(0)

  // Jumping to the quoted message asks for the page around it; the server answers, the page is not told yet.
  const held = await holdAnswer<{ messages: Array<{ id: string }> }>(
    page,
    new RegExp(`/api/conversations/${id}/messages\\?.*aroundSeq=`),
    'GET',
  )
  await message(page, 'R2_REPLY_TEXT').locator('.bubble__quote').click()
  await held.reached

  // Meanwhile two messages of that page are recalled: one the page has in common with the newest page it already holds, and
  // one that only the page around the source has.
  const seen = waitForChanges(page, id, [inBoth.id, onlyInPage.id])
  expect((await inBoth.api.post(`/api/messages/${inBoth.id}/recall`, { data: {} })).ok()).toBe(true)
  expect((await apiA.post(`/api/messages/${onlyInPage.id}/recall`, { data: {} })).ok()).toBe(true)
  await seen
  await frames(page)

  const original = await watchText(page, 'article', inBoth.text)
  await held.deliver()
  // The jump lands on the quoted message.
  await expect(page.locator(`article[data-seq="${source.seq}"]`)).toBeVisible()
  // What the page it replaces already knew as recalled never shows its text again, not even for a frame…
  await expect(page.locator(`article[data-seq="${inBoth.seq}"]`)).toContainText('撤回了一条消息')
  expect(await original()).toBe(false)
  // …and what happened to a message that only this page has is applied to it from where the page was asked.
  await expect(page.locator(`article[data-seq="${onlyInPage.seq}"]`)).toContainText(
    '撤回了一条消息',
  )
  await expect(page.getByText(inBoth.text)).toHaveCount(0)
  await expect(page.getByText(onlyInPage.text)).toHaveCount(0)
})
