import type { Page } from '@playwright/test'
import { apiContext, createVerifiedMember, type Person } from './support/api.ts'
import { composer, createChannelApi, openFromSidebar, signedIn } from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import {
  deletesCookie,
  holdAnswer,
  holdRequest,
  identityStatus,
  sessionCookie,
  signInInPlace,
  signOutInPlace,
  watchText,
} from './support/late.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * What comes back for a login session that is over (M2b recheck 2026-10-06, R6 and R7, D-175, SEC-34). A request is made,
 * the person signs out, somebody else (or the same person again) signs in, in the same page and stands on a channel of
 * their own with something typed; then the answer to the first request arrives, as the server wrote it: with its status,
 * its body and, in headers the page never sees, the instruction to drop the session cookie. The page must not end the
 * new session (R6, what the page does with the answer), and the cookie of the new session must still be there afterwards
 * (R7, what the browser does with the answer's headers whatever the page thinks of it): the identity check, asked from
 * inside the page, answers 200 before and after, the page is where it was, and what was typed is still in the field, and no
 * message was shown to anybody. Nothing of the answers is edited: a test that cut the cookie lines out of them would prove
 * nothing about them. What keeps the answer from doing any of it is that the page gave the request up when its session
 * ended (D-175), so that the browser takes nothing of the held answer; one test lets the answer come while the next person's
 * sign-in is still going on, which is what tells "given up when the session ended" from "given up once somebody had signed in".
 * The last tests are the controls: a refusal of the session that is current still ends it, and signing out ends the session
 * on the server and drops the cookie in the browser, each asked apart.
 */

const stamp = (): string => Date.now().toString(36)

/** A channel of their own for the person who signs in later, made through the API. */
async function ownChannel(person: Person, label: string): Promise<string> {
  const name = `LS-${label}-${stamp()}`
  await createChannelApi(await signedIn(person), name)
  return name
}

/** Who signs in after the first person has gone: somebody else, or the same person again. */
type Next = 'another person' | 'the same person'
const NEXT: readonly Next[] = ['another person', 'the same person']

/** The first person, the one who signs in next and the channel the second stands on. */
async function people(label: string, next: Next) {
  const first = await createVerifiedMember(`${label}a`)
  const second = next === 'the same person' ? first : await createVerifiedMember(`${label}b`)
  return { first, second, channel: await ownChannel(second, label) }
}

/** The person who signs in now stands on a channel of their own and has typed something that is not sent. */
async function standsWithADraft(page: Page, next: Person, channel: string, draft: string) {
  await signInInPlace(page, next.email, next.password)
  await openFromSidebar(page, channel)
  await composer(page).fill(draft)
  await expect(composer(page)).toHaveValue(draft)
  expect(await identityStatus(page)).toBe(200)
  expect(await sessionCookie(page)).not.toBeNull()
  return page.url()
}

/**
 * Records whether any message (toast) is shown from now on: a request that is given up is nobody's failure, so nobody is told
 * of it, and neither is anything said of what the first person did.
 */
const watchMessages = (page: Page): Promise<() => Promise<boolean>> => watchText(page, '.toast', '')

/** After the late answer: still the same person, in the same place, with the same words and the same cookie. */
async function stillStands(
  page: Page,
  where: string,
  draft: string,
  sawMessage: () => Promise<boolean>,
): Promise<void> {
  expect(await identityStatus(page)).toBe(200)
  await expect(page).toHaveURL(where)
  await expect(composer(page)).toHaveValue(draft)
  await expect(page.locator('.toast')).toHaveCount(0)
  expect(await sawMessage(), 'a message was shown to somebody').toBe(false)
  expect(await sessionCookie(page)).not.toBeNull()
}

/**
 * Another tab of the same browser, on the person who is signed in: what the late answer does to the first tab it would do to
 * this one too, by telling it that the session ended (the other tabs are told of an end, D-070).
 */
async function otherTabIsNotTold(page: Page, held: { deliver(): Promise<void> }): Promise<void> {
  const tab = await page.context().newPage()
  await tab.goto('/')
  await expect(tab.getByRole('navigation', { name: '会话' })).toBeVisible()
  await held.deliver()
  // A broadcast arrives within a moment; wait a little longer than that for something that must not happen.
  await tab.waitForTimeout(500)
  await expect(tab).not.toHaveURL(/\/login/)
  expect(await identityStatus(tab)).toBe(200)
}

async function startCreatingAGroup(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByRole('menuitem', { name: '新建群组' }).click()
  await page.getByLabel('名称').fill(name)
  await page.getByRole('dialog').getByRole('button', { name: '创建' }).click()
}

for (const next of NEXT) {
  test(`R6: the 401 that a request of the person who signed out gets, late, does not end the session of ${next}`, async ({
    page,
  }) => {
    const { first, second, channel } = await people('r6', next)
    await signIn(page, first.email, first.password)
    const sawMessage = await watchMessages(page)

    // The request is made and held before the server has it, with the first person's cookie on it.
    const held = await holdRequest(page, /\/api\/conversations$/, 'POST')
    await startCreatingAGroup(page, `LS-group-${stamp()}`)
    await held.requested
    await page.keyboard.press('Escape')
    await signOutInPlace(page)

    // Now it reaches the server and is refused for good: that session is over. The refusal tells the browser to drop the
    // cookie, and a browser does so whoever's cookie it is by the time the refusal gets there.
    const real = await held.sendToServer()
    expect(real.status).toBe(401)
    expect(real.error).toBe('UNAUTHENTICATED')
    expect(real.setCookies.some(deletesCookie)).toBe(true)

    const where = await standsWithADraft(page, second, channel, 'LS_R6_DRAFT')
    await otherTabIsNotTold(page, held)
    await stillStands(page, where, 'LS_R6_DRAFT', sawMessage)
  })

  test(`R7: the answer to "sign out everywhere", late, does not take the cookie of ${next}, who signed in meanwhile`, async ({
    page,
  }) => {
    const { first, second, channel } = await people('r7all', next)
    await signIn(page, first.email, first.password)
    await openSettings(page, 'account')
    const sawMessage = await watchMessages(page)

    const held = await holdAnswer(page, /\/api\/me\/devices\/revoke-all$/, 'POST')
    await page.getByRole('button', { name: '在所有设备上退出…', exact: true }).click()
    await page.getByRole('button', { name: '全部退出', exact: true }).click()
    await held.reached
    // The server has done it, and its answer, still on its way, says to drop the cookie.
    expect(held.setCookies.some(deletesCookie)).toBe(true)
    // The page learns of it from the connection, answer or not, and goes to the sign-in page.
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })

    const where = await standsWithADraft(page, second, channel, 'LS_R7_DRAFT')
    await held.deliver()
    await stillStands(page, where, 'LS_R7_DRAFT', sawMessage)
  })
}

test('R7: the answer to "sign out everywhere" that comes while the next person is still signing in does not take their cookie either', async ({
  page,
}) => {
  const { first, second, channel } = await people('r7mid', 'another person')
  await signIn(page, first.email, first.password)
  await openSettings(page, 'account')
  const sawMessage = await watchMessages(page)

  const held = await holdAnswer(page, /\/api\/me\/devices\/revoke-all$/, 'POST')
  await page.getByRole('button', { name: '在所有设备上退出…', exact: true }).click()
  await page.getByRole('button', { name: '全部退出', exact: true }).click()
  await held.reached
  expect(held.setCookies.some(deletesCookie)).toBe(true)
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })

  // The last step of signing in is asking who the new cookie belongs to. It is held: the new cookie is in the browser, the
  // page has not heard of it yet. That is when the late answer comes. The session of the first person was given up when it
  // ended, before this sign-in was begun, so there is nothing of it left to come (a request given up only once the sign-in
  // was through would still be alive here, and would take the cookie that was just given).
  const probe = await holdAnswer(page, /\/api\/me$/, 'GET')
  await page.getByLabel('邮箱').fill(second.email)
  await page.getByLabel('密码', { exact: true }).fill(second.password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await probe.reached
  await held.deliver()
  await probe.deliver()
  await expect(page.getByRole('heading', { name: /^欢迎回来/ })).toBeVisible()

  await openFromSidebar(page, channel)
  await composer(page).fill('LS_R7_MID_DRAFT')
  await expect(composer(page)).toHaveValue('LS_R7_MID_DRAFT')
  const where = page.url()
  await page.waitForTimeout(500)
  await stillStands(page, where, 'LS_R7_MID_DRAFT', sawMessage)
})

test('R7: the answer to a plain sign-out, late, neither takes the cookie of the person who signed in meanwhile nor ends their session', async ({
  page,
}) => {
  const { first, second, channel } = await people('r7out', 'another person')
  await signIn(page, first.email, first.password)

  const held = await holdAnswer(page, /\/api\/auth\/sign-out$/, 'POST')
  await openSettings(page, 'account')
  const sawMessage = await watchMessages(page)
  await page.getByRole('button', { name: '退出登录' }).click()
  await held.reached
  expect(held.setCookies.some(deletesCookie)).toBe(true)
  // The server ended the session when it handled the request; the page hears of that from the connection before the answer.
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })

  const where = await standsWithADraft(page, second, channel, 'LS_R7_OUT_DRAFT')
  await otherTabIsNotTold(page, held)
  await stillStands(page, where, 'LS_R7_OUT_DRAFT', sawMessage)
})

test('a request of the session that is current, refused because that session is over, still ends it: the page, the cookie, what was typed', async ({
  page,
}) => {
  const person = await createVerifiedMember('lsctl')
  const name = await ownChannel(person, 'ctl')
  // The server's close of the connection is what tells a page, in a few seconds; here it is held back, so that the page
  // finds out the way this test is about: from the refusal that the answer to one of its requests is.
  await page.routeWebSocket(/\/ws$/, (route) => {
    const server = route.connectToServer()
    server.onMessage((message) => route.send(message))
    route.onMessage((message) => server.send(message))
    server.onClose(() => undefined)
  })
  await signIn(page, person.email, person.password)
  await openFromSidebar(page, name)
  await composer(page).fill('LS_CTL_DRAFT')
  expect(await sessionCookie(page)).not.toBeNull()

  // Another device of the person ends this browser's session: really, on the server.
  const other = await signedIn(person)
  expect((await other.post('/api/me/devices/revoke-others')).ok()).toBe(true)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await startCreatingAGroup(page, `LS-ctl-group-${stamp()}`)

  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText(/登录已失效/)).toBeVisible()
  // The browser dropped the dead cookie (the refusal told it to), and what the session held went with it.
  expect(await sessionCookie(page)).toBeNull()
  expect(await identityStatus(page)).toBe(401)
  await signInInPlace(page, person.email, person.password)
  await openFromSidebar(page, name)
  await expect(composer(page)).toHaveValue('')
})

/** What the server and the browser each do when the person signs out: asked apart (a cookie kept is not a session kept). */
for (const how of ['signing out', 'signing out everywhere'] as const) {
  test(`${how} ends the session on the server and drops the cookie in the browser, answer in time`, async ({
    page,
  }) => {
    const person = await createVerifiedMember('lsend')
    await signIn(page, person.email, person.password)
    const cookie = await sessionCookie(page)
    expect(cookie).not.toBeNull()

    await openSettings(page, 'account')
    if (how === 'signing out') {
      await page.getByRole('button', { name: '退出登录' }).click()
    } else {
      await page.getByRole('button', { name: '在所有设备上退出…', exact: true }).click()
      await page.getByRole('button', { name: '全部退出', exact: true }).click()
    }
    await expect(page).toHaveURL(/\/login/)

    // The browser: the cookie is gone.
    expect(await sessionCookie(page)).toBeNull()
    expect(await identityStatus(page)).toBe(401)
    // The server: the cookie it had given is worth nothing any more, kept or not.
    const remembered = await apiContext()
    const refused = await remembered.get('/api/me', {
      headers: { cookie: `chatapp.session_token=${cookie}` },
    })
    expect(refused.status()).toBe(401)
    await remembered.dispose()
  })
}
