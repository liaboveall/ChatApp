import type { APIRequestContext, Page } from '@playwright/test'
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
import {
  frames,
  holdAnswer,
  signInInPlace,
  signOutInPlace,
  waitForChanges,
  watchText,
} from './support/late.ts'
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
 *
 * The answer to the save of an edit also finishes something on the screen: the composer leaves the edit and puts back
 * the text it had set aside (M2b recheck 2026-10-06, R5, D-173). That is done only for the very edit the save went out
 * under, so a late answer cannot clear the draft of whoever signed in next, of the person who signed in again or joined
 * again, nor end the edit they went to meanwhile.
 */

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

/**
 * Puts the person in an edit of one of their messages and presses Enter with the new text. The server handles the save
 * (its effect is real and stays); the page is not told yet, `deliver()` of the result tells it.
 */
async function saveEditHeld(page: Page, source: { id: string }, oldText: string, newText: string) {
  await message(page, oldText).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  await expect(page.locator('.composer__ctx')).toContainText('正在编辑')
  await expect(composer(page)).toHaveValue(oldText)
  const held = await holdAnswer(page, new RegExp(`/api/messages/${source.id}$`), 'PATCH')
  await sendFromComposer(page, newText)
  await held.reached
  return held
}

test('R5: the answer to an edit made before another person signed in does not clear what that person has typed', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r5alice')
  const bob = await createVerifiedMember('r5bob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const name = `R5-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  const source = await sendApi(apiA, id, 'R5_ALICE_ORIGINAL')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await expect(message(page, 'R5_ALICE_ORIGINAL')).toBeVisible()
  const held = await saveEditHeld(page, source, 'R5_ALICE_ORIGINAL', 'R5_ALICE_EDITED')

  // Alice signs out and Bob signs in, in the same page, with the save still out; Bob starts writing.
  await signOutInPlace(page)
  await signInInPlace(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await composer(page).fill('R5_BOB_UNSENT_DRAFT')
  await expect(composer(page)).toHaveValue('R5_BOB_UNSENT_DRAFT')

  await held.deliver()
  await expect(composer(page)).toHaveValue('R5_BOB_UNSENT_DRAFT')
  await expect(page.locator('.composer__ctx')).toHaveCount(0)
  // Bob's page is in step: the edit that did happen reaches him through the log, and his draft goes out as it was.
  await expect(message(page, 'R5_ALICE_EDITED')).toBeVisible()
  await expect(composer(page)).toHaveValue('R5_BOB_UNSENT_DRAFT')
  await sendFromComposer(page, 'R5_BOB_UNSENT_DRAFT')
  await expect(message(page, 'R5_BOB_UNSENT_DRAFT')).toBeVisible()
})

test('R5: the answer to an edit made before the person signed out and in again does not clear what they typed since', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r5again')
  const apiA = await signedIn(alice)
  const name = `R5a-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  const source = await sendApi(apiA, id, 'R5_AGAIN_ORIGINAL')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await expect(message(page, 'R5_AGAIN_ORIGINAL')).toBeVisible()
  const held = await saveEditHeld(page, source, 'R5_AGAIN_ORIGINAL', 'R5_AGAIN_EDITED')

  await signOutInPlace(page)
  await signInInPlace(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await composer(page).fill('R5_DRAFT_AFTER_SIGNING_IN')
  await expect(composer(page)).toHaveValue('R5_DRAFT_AFTER_SIGNING_IN')

  await held.deliver()
  await expect(composer(page)).toHaveValue('R5_DRAFT_AFTER_SIGNING_IN')
  await expect(page.locator('.composer__ctx')).toHaveCount(0)
  await expect(message(page, 'R5_AGAIN_EDITED')).toBeVisible()
})

test('R5: the answer to an edit made before the person left the channel and joined it again does not clear what they typed in the new membership', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r5lalice')
  const bob = await createVerifiedMember('r5lbob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const name = `R5l-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  const source = await sendApi(apiB, id, 'R5_LEAVER_ORIGINAL')
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(message(page, 'R5_LEAVER_ORIGINAL')).toBeVisible()
  const held = await saveEditHeld(page, source, 'R5_LEAVER_ORIGINAL', 'R5_LEAVER_EDITED')

  await openDetails(page)
  await page.getByRole('button', { name: '退出会话' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '退出', exact: true }).click()
  await expect(page).toHaveURL(/\/$/)
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  await openFromSidebar(page, name)
  await composer(page).fill('R5_DRAFT_AFTER_JOINING')
  await expect(composer(page)).toHaveValue('R5_DRAFT_AFTER_JOINING')

  await held.deliver()
  await expect(composer(page)).toHaveValue('R5_DRAFT_AFTER_JOINING')
  await expect(page.locator('.composer__ctx')).toHaveCount(0)
})

for (const how of ['cancelled it', 'went on to another message'] as const) {
  test(`R5: the answer to an edit made before the person ${how} does not end the edit they are in now`, async ({
    page,
  }) => {
    const alice = await createVerifiedMember(how === 'cancelled it' ? 'r5cancel' : 'r5switch')
    const apiA = await signedIn(alice)
    const name = `R5${how === 'cancelled it' ? 'c' : 's'}-${Date.now().toString(36)}`
    const id = await createChannelApi(apiA, name)
    const first = await sendApi(apiA, id, 'R5_FIRST_ORIGINAL')
    await sendApi(apiA, id, 'R5_SECOND_ORIGINAL')
    await signIn(page, alice.email, alice.password)
    await openFromSidebar(page, name)
    await expect(message(page, 'R5_SECOND_ORIGINAL')).toBeVisible()
    await composer(page).fill('R5_TYPED_BEFORE_EDITING')
    const held = await saveEditHeld(page, first, 'R5_FIRST_ORIGINAL', 'R5_FIRST_EDITED')

    // The save is out. The person leaves the edit (Escape) or does not, and edits the other message.
    if (how === 'cancelled it') {
      await composer(page).press('Escape')
      await expect(page.locator('.composer__ctx')).toHaveCount(0)
      await expect(composer(page)).toHaveValue('R5_TYPED_BEFORE_EDITING')
    }
    await message(page, 'R5_SECOND_ORIGINAL').click({ button: 'right' })
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    await expect(composer(page)).toHaveValue('R5_SECOND_ORIGINAL')
    await composer(page).fill('R5_SECOND_HALF_WRITTEN')
    await expect(composer(page)).toHaveValue('R5_SECOND_HALF_WRITTEN')

    await held.deliver()
    // The first save went through and shows; the second edit is as the person left it.
    await expect(message(page, 'R5_FIRST_EDITED')).toBeVisible()
    await expect(page.locator('.composer__ctx')).toContainText('正在编辑')
    await expect(composer(page)).toHaveValue('R5_SECOND_HALF_WRITTEN')

    // It is saved like any edit, and what was typed before the edits is back.
    await sendFromComposer(page, 'R5_SECOND_EDITED')
    await expect(message(page, 'R5_SECOND_EDITED')).toBeVisible()
    await expect(page.locator('.composer__ctx')).toHaveCount(0)
    await expect(composer(page)).toHaveValue('R5_TYPED_BEFORE_EDITING')
  })
}

test('R5: a saved edit ends and puts back the text that was set aside before it', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r5normal')
  const apiA = await signedIn(alice)
  const name = `R5n-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  await sendApi(apiA, id, 'R5_NORMAL_ORIGINAL')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await expect(message(page, 'R5_NORMAL_ORIGINAL')).toBeVisible()
  await composer(page).fill('R5_TYPED_BEFORE')
  await message(page, 'R5_NORMAL_ORIGINAL').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  await expect(page.locator('.composer__ctx')).toContainText('正在编辑')
  await expect(composer(page)).toHaveValue('R5_NORMAL_ORIGINAL')

  await sendFromComposer(page, 'R5_NORMAL_EDITED')
  await expect(message(page, 'R5_NORMAL_EDITED')).toContainText('已编辑')
  await expect(page.locator('.composer__ctx')).toHaveCount(0)
  await expect(composer(page)).toHaveValue('R5_TYPED_BEFORE')
  await expect(page.getByText('R5_NORMAL_ORIGINAL')).toHaveCount(0)
})

test('R5: what is typed while the save of an edit is out is kept, and the edit goes on from the saved version', async ({
  page,
}) => {
  const alice = await createVerifiedMember('r5keep')
  const apiA = await signedIn(alice)
  const name = `R5k-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  const source = await sendApi(apiA, id, 'R5_KEEP_ORIGINAL')
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await expect(message(page, 'R5_KEEP_ORIGINAL')).toBeVisible()
  const held = await saveEditHeld(page, source, 'R5_KEEP_ORIGINAL', 'R5_KEEP_FIRST')
  await composer(page).fill('R5_KEEP_FIRST and then some more')

  await held.deliver()
  // The first text is saved and shows; the field keeps what was typed after it, and the edit is still open.
  await expect(message(page, 'R5_KEEP_FIRST')).toContainText('已编辑')
  await expect(composer(page)).toHaveValue('R5_KEEP_FIRST and then some more')
  await expect(page.locator('.composer__ctx')).toContainText('正在编辑')

  // Saving it again is not taken for a clash with the first save.
  await sendFromComposer(page, 'R5_KEEP_FIRST and then some more')
  await expect(message(page, 'R5_KEEP_FIRST and then some more')).toBeVisible()
  await expect(page.locator('.composer__ctx')).toHaveCount(0)
  await expect(composer(page)).toHaveValue('')
  await expect(page.getByText('这条消息刚被修改过')).toHaveCount(0)
})
