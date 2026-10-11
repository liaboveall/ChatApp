import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import {
  addMembersApi,
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendApi,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, networkCut, test } from './support/fixtures.ts'
import { controlNetwork } from './support/network.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * M6, offline (docs/03 section 11, docs/05 section 3.4, D-070, D-205, AT-17): a tab that is open keeps showing what it has
 * loaded when the network goes; plain text written meanwhile waits in the line and goes by itself, once, when the network is
 * back and the account and the membership have been checked; it survives a reload; what is older than 24 hours, written
 * under a membership that ended, or written by a session that was revoked in the meantime is never sent by itself; and a
 * sign-out leaves nothing of the account in the browser's storage.
 */

/** A message of mine that the server has not accepted yet (the pending bubble), by its text. */
const pending = (page: Page, text: string) =>
  page.locator('article[data-pending]').filter({ hasText: text })

type Stored = { key: string; kind: string; userId: string; body?: string; text?: string }

/**
 * What the app keeps on disk (src/lib/offline/store.ts), read without creating the database: a probe that created it would
 * leave it without its store, and the app could not write to it any more.
 */
async function storedRecords(page: Page): Promise<Stored[]> {
  return await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((database) => database.name)
    if (!names.includes('chatapp-local')) return []
    return await new Promise<Stored[]>((resolve, reject) => {
      const opening = indexedDB.open('chatapp-local')
      opening.onupgradeneeded = () => opening.transaction?.abort()
      opening.onerror = () => resolve([])
      opening.onsuccess = () => {
        const database = opening.result
        if (!database.objectStoreNames.contains('records')) {
          database.close()
          resolve([])
          return
        }
        const transaction = database.transaction('records')
        const store = transaction.objectStore('records')
        const keys = store.getAllKeys()
        const values = store.getAll()
        transaction.oncomplete = () => {
          database.close()
          resolve(
            keys.result.map((key, index) => ({
              key: String(key),
              ...(values.result[index] as Omit<Stored, 'key'>),
            })),
          )
        }
        transaction.onerror = () => reject(transaction.error)
      }
    })
  })
}

/** Puts a record on disk as the app would have written it on an earlier visit. */
async function storeRecord(page: Page, key: string, record: object): Promise<void> {
  await page.evaluate(
    ({ key, record }) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open('chatapp-local')
        opening.onupgradeneeded = () => opening.result.createObjectStore('records')
        opening.onerror = () => reject(opening.error)
        opening.onsuccess = () => {
          const database = opening.result
          const transaction = database.transaction('records', 'readwrite')
          transaction.objectStore('records').put(record, key)
          transaction.oncomplete = () => {
            database.close()
            resolve()
          }
          transaction.onerror = () => reject(transaction.error)
        }
      }),
    { key, record },
  )
}

/** The messages of a conversation as another member reads them from the server. */
async function bodiesSeenBy(
  api: Awaited<ReturnType<typeof signedIn>>,
  conversationId: string,
): Promise<string[]> {
  const response = await api.get(`/api/conversations/${conversationId}/messages?limit=50`)
  const { messages } = (await response.json()) as { messages: Array<{ body: string | null }> }
  return messages.map((entry) => entry.body ?? '')
}

/**
 * Makes every message that a tab of this browser sends fail as if the server could not be reached (the pages themselves still
 * think they are online), and declares the failures the browser reports meanwhile. All tabs: another tab of the same person
 * finds the kept message on disk and sends it, which is right, so it must not be able to either. Returns the function that
 * lets them through again.
 */
async function unreachableSends(page: Page): Promise<() => Promise<void>> {
  const context = page.context()
  const pattern = /\/api\/conversations\/[^/]+\/messages(\/replay)?$/
  const handler = async (route: import('@playwright/test').Route) =>
    route.request().method() === 'POST'
      ? await route.abort('internetdisconnected')
      : await route.fallback()
  await context.route(pattern, handler)
  networkCut(context, true)
  return async () => {
    await context.unroute(pattern, handler)
    networkCut(context, false)
  }
}

test('@smoke an open tab keeps what it loaded without a network; what is written meanwhile goes once, after the checks', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `离线写作${Date.now().toString(36)}`
  const group = await createGroupApi(apiA, name, [bobId])
  await sendApi(apiA, group, '断网之前的消息')

  const network = await controlNetwork(page)
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(message(page, '断网之前的消息')).toBeVisible()

  // What the page asks of the server from here on, in order.
  const asked: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (
      request.method() === 'GET' &&
      (path === '/api/me' || path === `/api/conversations/${group}`)
    )
      asked.push(`GET ${path}`)
    if (request.method() === 'POST' && path.startsWith(`/api/conversations/${group}/messages`))
      asked.push(`POST ${path}`)
  })

  await network.goOffline()
  // What was loaded stays readable.
  await expect(message(page, '断网之前的消息')).toBeVisible()

  // Written without a network: it waits in the line, says so, and nothing goes out.
  await sendFromComposer(page, '没有网络时写的')
  await expect(pending(page, '没有网络时写的')).toHaveAttribute(
    'aria-label',
    '等待网络，恢复后自动发送，也可以删除',
  )
  await expect(pending(page, '没有网络时写的')).toContainText('等待网络，恢复后自动发送')
  expect(asked.filter((entry) => entry.startsWith('POST'))).toEqual([])

  // Back online: who is signed in and the membership are read again before the message goes, through the queue's endpoint.
  await network.goOnline()
  await expect(message(page, '没有网络时写的')).toHaveCount(1)
  await expect(pending(page, '没有网络时写的')).toHaveCount(0)
  const replay = asked.indexOf(`POST /api/conversations/${group}/messages/replay`)
  expect(replay).toBeGreaterThan(-1)
  expect(asked.slice(0, replay)).toContain('GET /api/me')
  expect(asked.slice(0, replay)).toContain(`GET /api/conversations/${group}`)
  expect(asked.filter((entry) => entry === `POST /api/conversations/${group}/messages`)).toEqual([])

  // The others have it exactly once.
  await expect
    .poll(async () => (await bodiesSeenBy(apiA, group)).filter((body) => body === '没有网络时写的'))
    .toEqual(['没有网络时写的'])
})

test('the app opened without a network shows only its shell; the kept message goes once the account is checked', async ({
  page,
  allowConsole,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    "Playwright's offline mode in WebKit refuses the navigation before the worker answers (pwa.spec.ts)",
  )
  allowConsole(
    /ApiError: NETWORK/,
    'the identity check fails while offline, and the router reports the error it caught',
  )
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `冷启动${Date.now().toString(36)}`
  const group = await createGroupApi(apiA, name, [bobId])
  await sendApi(apiA, group, '谁都能看见的消息')

  const network = await controlNetwork(page)
  await signIn(page, bob.email, bob.password)
  await page.evaluate(() => navigator.serviceWorker.ready)
  await openFromSidebar(page, name)
  await expect(message(page, '谁都能看见的消息')).toBeVisible()

  await network.goOffline()
  await sendFromComposer(page, '冷启动之前写的')
  await expect(pending(page, '冷启动之前写的')).toContainText('等待网络，恢复后自动发送')
  await expect
    .poll(async () => (await storedRecords(page)).map((record) => record.kind))
    .toEqual(['queued'])

  // A cold start without a network: the shell, and nothing of the account (no conversation, no message, not the queue).
  await page.reload()
  await expect(page.getByRole('heading', { name: '没有网络连接' })).toBeVisible()
  await expect(page.getByText('谁都能看见的消息')).toHaveCount(0)
  await expect(page.getByText('冷启动之前写的')).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: '会话' })).toHaveCount(0)

  // The network is back: the account is checked, the conversation list comes, and the kept message goes, once.
  await network.goOnline()
  await openFromSidebar(page, name)
  await expect(message(page, '冷启动之前写的')).toHaveCount(1)
  await expect
    .poll(async () => (await bodiesSeenBy(apiA, group)).filter((body) => body === '冷启动之前写的'))
    .toEqual(['冷启动之前写的'])
})

test('older than 24 hours, or written before leaving and joining again: kept for the person, never sent by itself', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `人工确认${Date.now().toString(36)}`
  const group = await createGroupApi(apiA, name, [bobId])
  await sendApi(apiA, group, '起点')

  const network = await controlNetwork(page)
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(message(page, '起点')).toBeVisible()

  // A message kept from a visit more than a day ago, as the app would have written it then.
  const me = (await (await page.request.get('/api/me')).json()) as {
    id: string
    authEpoch: number
    restoreEpoch: string
  }
  const conversation = (await (await page.request.get(`/api/conversations/${group}`)).json()) as {
    me: { membershipId: string }
  }
  const clientId = crypto.randomUUID()
  const dayAndAHour = 25 * 60 * 60 * 1000
  await storeRecord(page, `q/${me.id}/${clientId}`, {
    kind: 'queued',
    userId: me.id,
    authEpoch: me.authEpoch,
    restoreEpoch: me.restoreEpoch,
    updatedAt: Date.now() - dayAndAHour,
    conversationId: group,
    membershipId: conversation.me.membershipId,
    clientId,
    body: '一天多以前写的',
    replyToId: null,
    createdAt: new Date(Date.now() - dayAndAHour).toISOString(),
    state: 'offline',
    error: null,
  })
  await page.reload()
  await expect(message(page, '起点')).toBeVisible()
  const old = pending(page, '一天多以前写的')
  await expect(old).toHaveAttribute('aria-label', '发送失败，可以重试或删除')
  await expect(old).toContainText('超过 24 小时，没有自动发送')

  // Written without a network; meanwhile Bob is taken out of the group and put back in (a new membership).
  await network.goOffline()
  await sendFromComposer(page, '重新入群之前写的')
  await expect(pending(page, '重新入群之前写的')).toContainText('等待网络，恢复后自动发送')
  expect((await apiA.delete(`/api/conversations/${group}/members/${bobId}`)).ok()).toBe(true)
  await addMembersApi(apiA, group, [bobId])
  await network.goOnline()
  const rejoined = pending(page, '重新入群之前写的')
  await expect(rejoined).toHaveAttribute('aria-label', '发送失败，可以重试或删除')
  await expect(rejoined).toContainText('你离开后又重新加入了这个会话，没有自动发送')

  // Neither went by itself.
  const seen = await bodiesSeenBy(apiA, group)
  expect(seen).not.toContain('一天多以前写的')
  expect(seen).not.toContain('重新入群之前写的')

  // The person decides: one is sent now, by hand (the ordinary send), the other is deleted.
  await rejoined.getByRole('button', { name: '重试', exact: true }).click()
  await expect(message(page, '重新入群之前写的')).toHaveCount(1)
  await old.getByRole('button', { name: '删除', exact: true }).click()
  await expect(pending(page, '一天多以前写的')).toHaveCount(0)
  await expect
    .poll(async () => (await bodiesSeenBy(apiA, group)).filter((body) => body.includes('之前写的')))
    .toEqual(['重新入群之前写的'])
  await expect
    .poll(async () => (await storedRecords(page)).filter((record) => record.kind === 'queued'))
    .toEqual([])
})

test('AT-17: a session revoked while the device was offline sends nothing when the network is back, and forgets the queue', async ({
  page,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const bobId = await myId(apiB)
  const name = `撤销会话${Date.now().toString(36)}`
  const group = await createGroupApi(apiA, name, [bobId])
  await sendApi(apiA, group, '撤销之前')

  const network = await controlNetwork(page)
  await signIn(page, bob.email, bob.password)
  await openFromSidebar(page, name)
  await expect(message(page, '撤销之前')).toBeVisible()

  await network.goOffline()
  await sendFromComposer(page, '设备离线时写的')
  await expect(pending(page, '设备离线时写的')).toContainText('等待网络，恢复后自动发送')
  await expect
    .poll(async () => (await storedRecords(page)).map((record) => record.kind))
    .toEqual(['queued'])

  // From another device of Bob's: every other session ends, this browser's included.
  expect((await apiB.post('/api/me/devices/revoke-others')).ok()).toBe(true)

  await network.goOnline()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await expect.poll(() => storedRecords(page)).toEqual([])
  expect(await bodiesSeenBy(apiA, group)).not.toContain('设备离线时写的')
})

test.describe('with the sends of every tab cut by the test', () => {
  // Playwright intercepts requests reliably only in pages no service worker controls (in WebKit and Firefox the worker's
  // pages escape `route`; those two block the worker everywhere, playwright.config.ts), so these two, which do not depend
  // on the worker, run without it in Chromium too.
  test.use({ serviceWorkers: 'block' })

  test('a message that could not reach the server outlives a reload, and goes by itself when the server is back', async ({
    page,
  }) => {
    const alice = await createVerifiedMember('alice')
    const bob = await createVerifiedMember('bob')
    const apiA = await signedIn(alice)
    const bobId = await myId(await signedIn(bob))
    const name = `重载离线${Date.now().toString(36)}`
    const group = await createGroupApi(apiA, name, [bobId])
    await sendApi(apiA, group, '开头')

    await signIn(page, bob.email, bob.password)
    await openFromSidebar(page, name)
    await expect(message(page, '开头')).toBeVisible()

    const letThrough = await unreachableSends(page)
    await sendFromComposer(page, '重新加载之前写的')
    await expect(pending(page, '重新加载之前写的')).toContainText('等待网络，恢复后自动发送')
    // On disk, under this account: the message, and nothing that somebody else wrote.
    await expect
      .poll(async () => (await storedRecords(page)).map((record) => [record.kind, record.body]))
      .toEqual([['queued', '重新加载之前写的']])

    await page.reload()
    await expect(message(page, '开头')).toBeVisible()
    await expect(pending(page, '重新加载之前写的')).toContainText('等待网络，恢复后自动发送')

    await letThrough()
    // The queue looks again by itself (its timer, the page coming back to the front, the network coming back).
    await expect(message(page, '重新加载之前写的')).toHaveCount(1, { timeout: 30_000 })
    await expect
      .poll(async () => (await storedRecords(page)).filter((record) => record.kind === 'queued'))
      .toEqual([])
    expect((await bodiesSeenBy(apiA, group)).filter((body) => body === '重新加载之前写的')).toEqual(
      ['重新加载之前写的'],
    )
  })

  test('AT-17: a sign-out in one tab empties what every tab kept on disk; the next person finds nothing of it', async ({
    page,
    context,
  }) => {
    const alice = await createVerifiedMember('alice')
    const bob = await createVerifiedMember('bob')
    const carol = await createVerifiedMember('carol')
    const apiA = await signedIn(alice)
    const bobId = await myId(await signedIn(bob))
    const name = `退出清理${Date.now().toString(36)}`
    const group = await createGroupApi(apiA, name, [bobId])
    await sendApi(apiA, group, '大家好')

    await signIn(page, bob.email, bob.password)
    await openFromSidebar(page, name)
    await expect(message(page, '大家好')).toBeVisible()
    const letThrough = await unreachableSends(page)
    await sendFromComposer(page, '还没发出去的消息')
    await expect(pending(page, '还没发出去的消息')).toContainText('等待网络，恢复后自动发送')
    await page.getByRole('textbox', { name: /^给 .* 的消息$/ }).fill('还没写完的草稿')
    await expect
      .poll(async () => (await storedRecords(page)).map((record) => record.kind).sort())
      .toEqual(['draft', 'queued'])

    // Bob signs out in another tab: this one stops at once, and the disk is empty.
    const other = await context.newPage()
    await openSettings(other, 'account')
    await other.getByRole('button', { name: '退出登录' }).click()
    await expect(other).toHaveURL(/\/login/)
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
    await expect.poll(() => storedRecords(page)).toEqual([])
    await letThrough()

    // Carol signs in on the same browser: nothing of Bob's is there, and his message never left.
    await signIn(page, carol.email, carol.password)
    await expect(page.getByText('还没写完的草稿')).toHaveCount(0)
    await expect(page.getByText('还没发出去的消息')).toHaveCount(0)
    expect((await storedRecords(page)).filter((record) => record.userId === bobId)).toEqual([])
    expect(await bodiesSeenBy(apiA, group)).not.toContain('还没发出去的消息')
  })
})
