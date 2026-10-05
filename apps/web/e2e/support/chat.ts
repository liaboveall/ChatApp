/**
 * Helpers for the chat scenarios. Set-up goes through the API (a person signed in over HTTP, a conversation created, a
 * message sent), because the tests are about what the screens do with them; whatever a test is about it does through the
 * interface. Every helper that talks to the server returns what the test needs next and nothing more.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { COMPOSITION_END_GRACE_MS } from '../../src/features/composer/enter-key.ts'
import { apiContext, type Person } from './api.ts'
import { expect } from './fixtures.ts'

// ───────── The API, as one person ─────────

/** A person signed in over HTTP (not in a browser): their requests carry their own session. */
export async function signedIn(person: Person): Promise<APIRequestContext> {
  const context = await apiContext()
  const response = await context.post('/api/auth/sign-in/email', {
    data: { email: person.email, password: person.password },
  })
  if (!response.ok()) throw new Error(`sign-in of ${person.username} failed: ${response.status()}`)
  return context
}

async function json<T>(
  response: Awaited<ReturnType<APIRequestContext['get']>>,
  what: string,
): Promise<T> {
  if (!response.ok())
    throw new Error(`${what} failed: ${response.status()} ${await response.text()}`)
  return (await response.json()) as T
}

export async function myId(api: APIRequestContext): Promise<string> {
  return (await json<{ id: string }>(await api.get('/api/me'), 'reading the account')).id
}

export async function createGroupApi(
  api: APIRequestContext,
  name: string,
  memberIds: string[] = [],
): Promise<string> {
  const response = await api.post('/api/conversations', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: { kind: 'group', name, memberIds },
  })
  return (await json<{ id: string }>(response, 'creating a group')).id
}

export async function createChannelApi(api: APIRequestContext, name: string): Promise<string> {
  const response = await api.post('/api/conversations', {
    headers: { 'idempotency-key': crypto.randomUUID() },
    data: { kind: 'channel', name },
  })
  return (await json<{ id: string }>(response, 'creating a channel')).id
}

export async function openDmApi(api: APIRequestContext, userId: string): Promise<string> {
  const response = await api.post('/api/conversations/dm', { data: { userId } })
  return (await json<{ id: string }>(response, 'opening a direct message')).id
}

export async function addMembersApi(
  api: APIRequestContext,
  conversationId: string,
  userIds: string[],
): Promise<void> {
  await json(
    await api.post(`/api/conversations/${conversationId}/members`, { data: { userIds } }),
    'adding members',
  )
}

export async function sendApi(
  api: APIRequestContext,
  conversationId: string,
  body: string,
  replyToId?: string,
): Promise<{ id: string; seq: number }> {
  const response = await api.post(`/api/conversations/${conversationId}/messages`, {
    data: {
      clientId: crypto.randomUUID(),
      body,
      ...(replyToId === undefined ? {} : { replyToId }),
    },
  })
  const { message } = await json<{ message: { id: string; seq: number } }>(response, 'sending')
  return message
}

export async function editApi(
  api: APIRequestContext,
  messageId: string,
  body: string,
): Promise<void> {
  const read = await json<{ message: { changeSeq: number } }>(
    await api.get(`/api/messages/${messageId}`),
    'reading a message',
  )
  await json(
    await api.patch(`/api/messages/${messageId}`, {
      data: { body, expectedChangeSeq: read.message.changeSeq },
    }),
    'editing',
  )
}

/** Makes a message older on the server (test environment only): its time window runs out sooner. */
export async function ageMessage(
  api: APIRequestContext,
  messageId: string,
  ms: number,
): Promise<void> {
  await json(
    await api.post(`/api/test/messages/${messageId}/age`, { data: { ms } }),
    'aging a message',
  )
}

// ───────── The screen ─────────

export const conversationIdOf = (page: Page): string => {
  const id = new URL(page.url()).pathname.split('/')[2]
  if (id === undefined || id === '') throw new Error(`not a conversation page: ${page.url()}`)
  return id
}

/** The row of a conversation in the sidebar, by its name. */
export const sidebarItem = (page: Page, name: string): Locator =>
  page
    .getByRole('navigation', { name: '会话' })
    .getByRole('link', { name: new RegExp(`^${escapeForRegExp(name)}`) })

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export async function openFromSidebar(page: Page, name: string): Promise<void> {
  await sidebarItem(page, name).click()
  await expect(page.locator('.toolbar__title')).toHaveText(name)
}

/** The message field of the open conversation. */
export const composer = (page: Page): Locator =>
  page.getByRole('textbox', { name: /^给 .* 的消息$/ })

/**
 * Types into the composer and presses Enter. Firefox reports Playwright's insertion of the text as a finished composition,
 * and an Enter within a few milliseconds of one is taken for the key that confirmed it (the way Safari delivers it, D-154):
 * so the press waits out that window, as a person's would.
 */
export async function sendFromComposer(page: Page, text: string): Promise<void> {
  const field = composer(page)
  await field.fill(text)
  await page.waitForTimeout(COMPOSITION_END_GRACE_MS + 10)
  await field.press('Enter')
}

/** A message (an article of the feed) whose text contains `text`; a message still being sent is not one yet. */
export const message = (page: Page, text: string): Locator =>
  page.locator('article[data-message-id]').filter({ hasText: text })

/** Creates a channel through the "New" menu and its dialog. Ends on the new channel's page. */
export async function createChannelInUi(
  page: Page,
  name: string,
  description?: string,
): Promise<void> {
  await page.getByRole('button', { name: '新建', exact: true }).click()
  await page.getByRole('menuitem', { name: '新建频道' }).click()
  await page.getByLabel('名称').fill(name)
  if (description !== undefined) await page.getByLabel(/^简介/).fill(description)
  await page.getByRole('dialog').getByRole('button', { name: '创建' }).click()
  await expect(page).toHaveURL(/\/c\//)
  await expect(page.locator('.toolbar__title')).toHaveText(name)
}

/** Opens the details panel of the open conversation (idempotent). */
export async function openDetails(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: '成员与详情' })
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(page.locator('.details')).toBeVisible()
}

/** The row of a person in the member list of the details panel (not in the list of bans, which names people too). */
export const memberRow = (page: Page, name: string): Locator =>
  page.getByRole('list', { name: '成员列表' }).locator('.member').filter({ hasText: name })
