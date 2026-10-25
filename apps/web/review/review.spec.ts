import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, type Route, test } from '@playwright/test'
import { makeMessage, makeUser, uuid } from '../src/lib/sync/fixtures.ts'
import { approval, conversation, me, run, task, usage } from './fixtures.ts'

const errors = new Map<Page, string[]>()
const answer = (route: Route, json: unknown, status = 200) => route.fulfill({ status, json })
const failure = (route: Route, status = 503) =>
  answer(
    route,
    {
      error: {
        code: status === 403 ? 'FORBIDDEN' : 'CAPACITY_UNAVAILABLE',
        message: 'Synthetic failure',
        requestId: 'review',
      },
    },
    status,
  )
async function openShellPalette(page: Page) {
  // The fixture starts the sync engine before React renders. WebKit can finish navigation while #root is still empty.
  const trigger = page.getByRole('button', { name: '搜索、跳转或执行命令', exact: true })
  await expect(trigger).toBeVisible()
  await trigger.press('Control+k')
  await expect(page.getByRole('combobox')).toBeFocused()
}
const member = {
  id: uuid(2),
  username: 'alice',
  name: 'Alice',
  email: 'alice@example.test',
  role: 'user',
  banned: false,
  banReason: null,
  emailVerified: true,
  active: true,
  inviteQuota: 5,
  invitesUsed: 0,
  storageUsedBytes: 0,
  storageReservedBytes: 0,
  storageQuotaBytes: null,
  aiDailyTokens: null,
  meVersion: 1,
  createdAt: run.createdAt,
}
test.beforeEach(async ({ page }) => {
  errors.set(page, [])
  page.on('pageerror', (error) => errors.get(page)?.push(error.message))
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/me') return answer(route, me)
    if (path === '/api/conversations')
      return answer(route, { conversations: [conversation], userChangeSeq: 0 })
    if (path === '/api/agent/usage') return answer(route, usage)
    if (path === '/api/me/ai-key') return answer(route, { aiKey: null })
    if (path === '/api/reminders') return answer(route, { reminders: [], nextCursor: null })
    if (path === '/api/scheduled-messages')
      return answer(route, { scheduledMessages: [], nextCursor: null })
    if (path === '/api/me/memories') return answer(route, { memories: [] })
    if (path === '/api/admin/users') return answer(route, { users: [member], nextCursor: null })
    if (path === '/api/admin/conversations')
      return answer(route, { conversations: [], nextCursor: null })
    if (path === '/api/notifications')
      return answer(route, { items: [], nextCursor: null, unreadCount: 0 })
    if (path.startsWith('/api/users/search'))
      return answer(route, { users: [makeUser(2)], nextCursor: null })
    return answer(route, {})
  })
})
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([])
  errors.delete(page)
})

for (const outcome of ['success', 'failure'] as const) {
  test(`memory ${outcome} keeps edits made while saving, including a changed sharing choice`, async ({
    page,
  }) => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let submissions = 0
    await page.route('**/api/me/memories', async (route) => {
      if (route.request().method() !== 'POST') return answer(route, { memories: [] })
      submissions += 1
      expect(route.request().postDataJSON()).toEqual({ content: 'first memory', allowSite: false })
      await held
      if (outcome === 'failure') return failure(route)
      return answer(route, {
        memory: {
          id: uuid(9),
          content: 'first memory',
          source: 'user',
          privacyClass: 'byok_private',
          contentVersion: 1,
          createdByRunId: null,
          createdAt: run.createdAt,
          deletedAt: null,
        },
      })
    })
    await page.goto('/?mode=memories')
    const field = page.locator('textarea')
    await field.fill('first memory')
    await page.locator('button[type="submit"]').click()
    await expect.poll(() => submissions).toBe(1)
    await field.fill('second unsaved memory')
    await page.getByRole('switch').check()
    await field.evaluate((node) => node.closest('form')?.requestSubmit())
    release()
    await expect(page.locator('button[type="submit"]')).not.toHaveAttribute('aria-busy', 'true')
    await expect(field).toHaveValue('second unsaved memory')
    await expect(page.getByRole('switch')).toBeChecked()
    expect(submissions).toBe(1)
  })
}

test('a memory save from the previous account cannot clear the current draft', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/me/memories', async (route) => {
    if (route.request().method() !== 'POST') return answer(route, { memories: [] })
    await held
    return answer(route, {
      memory: {
        id: uuid(9),
        content: 'old account memory',
        source: 'user',
        privacyClass: 'byok_private',
        contentVersion: 1,
        createdByRunId: null,
        createdAt: run.createdAt,
        deletedAt: null,
      },
    })
  })
  await page.goto('/?mode=memories')
  await page.locator('textarea').fill('old account memory')
  const sent = page.waitForRequest((request) => request.method() === 'POST')
  await page.locator('button[type="submit"]').click()
  await sent
  await page.evaluate(() =>
    (
      window as unknown as { review: { switchAccount: () => Promise<void> } }
    ).review.switchAccount(),
  )
  await page.locator('textarea').fill('current account draft')
  release()
  await expect(page.locator('button[type="submit"]')).not.toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('textarea')).toHaveValue('current account draft')
})

test('both task sources paginate independently; history does not obscure pending work; cancellation refreshes every page', async ({
  page,
}) => {
  const cancelled = new Set<string>()
  const calls: string[] = []
  await page.route(/\/api\/(reminders|scheduled-messages)(\?|\/|$)/, (route) => {
    const url = new URL(route.request().url())
    const reminder = url.pathname.includes('reminders')
    const make = (index: number, status: 'scheduled' | 'sent' | 'cancelled') => {
      const row = task(index, status)
      return reminder ? { ...row, id: uuid(4000 + index), text: `待办提醒 ${index}` } : row
    }
    calls.push(`${route.request().method()} ${url.pathname}${url.search}`)
    if (route.request().method() === 'DELETE') {
      const id = url.pathname.split('/').at(-1) ?? ''
      cancelled.add(id)
      return answer(
        route,
        reminder
          ? { reminder: { ...make(52, 'cancelled'), id } }
          : { scheduledMessage: { ...make(52, 'cancelled'), id } },
      )
    }
    const status = url.searchParams.get('status') === 'sent' ? 'sent' : 'scheduled'
    const all = Array.from({ length: status === 'sent' ? 75 : 52 }, (_, index) =>
      make(index + 1, status),
    ).filter((row) => !cancelled.has(row.id))
    const offset = url.searchParams.has('cursor') ? 50 : 0
    const rows = all.slice(offset, offset + 50)
    return answer(route, {
      [reminder ? 'reminders' : 'scheduledMessages']: rows,
      nextCursor: all.length > offset + 50 ? 'page-2' : null,
    })
  })
  await page.goto('/?mode=tasks')
  await expect(page.locator('.task-row')).toHaveCount(100)
  expect(
    calls
      .filter((call) => call.startsWith('GET'))
      .every((call) => call.includes('status=scheduled')),
  ).toBe(true)
  await page.getByRole('button', { name: '加载更多 · 提醒', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(102)
  await page.getByRole('button', { name: '加载更多 · 定时消息', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(104)
  await page
    .locator('.task-row')
    .filter({ hasText: '待办消息 52' })
    .getByRole('button', { name: '取消', exact: true })
    .click()
  await expect(page.locator('.task-row')).toHaveCount(103)
  await expect(page.locator('.task-row').filter({ hasText: '待办消息 52' })).toHaveCount(0)
  await page.getByRole('radio', { name: '已执行', exact: true }).check()
  await expect(page.locator('.task-row')).toHaveCount(100)
  await page.getByRole('button', { name: '加载更多 · 提醒', exact: true }).click()
  await page.getByRole('button', { name: '加载更多 · 定时消息', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(149)
  await page.getByRole('radio', { name: '等待执行', exact: true }).check()
  await expect(page.locator('.task-row').filter({ hasText: '待办提醒 52' })).toHaveCount(1)
})

test('approval editing preserves ambiguous time choices, supports cancel, and retries the same visible target/time after a failure', async ({
  page,
}) => {
  let attempts = 0
  await page.route('**/api/agent/approvals/*', (route) => {
    attempts += 1
    expect(route.request().postDataJSON()).toMatchObject({
      decision: 'approve',
      editedArgs: { body: '修改后的消息', offsetMinutes: -300 },
    })
    return attempts === 1
      ? failure(route)
      : answer(route, {
          approval: { ...approval, status: 'approved', decidedAt: run.createdAt },
          run,
        })
  })
  await page.route(`**/api/agent/runs/${run.id}`, (route) =>
    answer(route, { run, steps: [], approvals: [], effects: [] }),
  )
  await page.goto('/?mode=approval')
  await page.getByRole('button', { name: '修改', exact: true }).click()
  await expect(page.getByRole('radio')).toHaveCount(2)
  await page.getByRole('radio').last().check()
  await page.locator('textarea').fill('暂存修改')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('textarea')).toHaveCount(0)
  await expect(page.getByRole('radio').last()).toBeChecked()
  await page.getByRole('button', { name: '修改', exact: true }).click()
  await expect(page.locator('textarea')).toHaveValue('原定时消息')
  await page.locator('textarea').fill('修改后的消息')
  await page.getByRole('button', { name: '保存并批准', exact: true }).click()
  await expect.poll(() => attempts).toBe(1)
  await expect(page.getByRole('button', { name: '保存并批准', exact: true })).not.toHaveAttribute(
    'aria-busy',
    'true',
  )
  await expect(page.locator('textarea')).toHaveValue('修改后的消息')
  await expect(page.getByRole('radio').last()).toBeChecked()
  await expect(page.locator('.approval')).toContainText('产品讨论')
  await page.getByRole('button', { name: '保存并批准', exact: true }).click()
  await expect.poll(() => attempts).toBe(2)
  await expect(page.locator('textarea')).toHaveCount(0)
})

test('keyboard navigation keeps the active palette option visible, including wraparound', async ({
  page,
}) => {
  await page.goto('/?mode=palette')
  const input = page.getByRole('combobox')
  for (const key of ['End', 'ArrowDown', 'ArrowUp', 'Home', 'ArrowUp', 'ArrowDown']) {
    await input.press(key)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const list = document.querySelector('.palette__list')?.getBoundingClientRect()
          const option = document.querySelector('[aria-selected="true"]')?.getBoundingClientRect()
          return (
            !!list && !!option && option.top >= list.top - 1 && option.bottom <= list.bottom + 1
          )
        }),
      )
      .toBe(true)
    await expect(input).toBeFocused()
  }
})

test('message search exposes later pages and source information, and can retry a failed page', async ({
  page,
}) => {
  let laterAttempts = 0
  await page.route('**/api/search/messages?**', (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.has('cursor') && ++laterAttempts === 1) return failure(route)
    const later = url.searchParams.has('cursor')
    return answer(route, {
      messages: later
        ? [makeMessage(21, { body: '重复结果 21' })]
        : Array.from({ length: 20 }, (_, index) =>
            makeMessage(index + 1, { body: `重复结果 ${index + 1}` }),
          ),
      users: { [uuid(1)]: makeUser(1, { displayName: 'Bob' }) },
      nextCursor: later ? null : 'older-search-results',
    })
  })
  await page.goto('/?mode=shell')
  await openShellPalette(page)
  await page.getByRole('combobox').fill('重复结果')
  await expect(page.getByRole('option')).toHaveCount(20)
  await expect(page.getByRole('option').first()).toContainText('产品讨论 · Bob')
  await expect(page.locator('.palette__search-status')).toContainText('全部可访问会话')
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible()
  await expect(page.getByRole('option')).toHaveCount(20)
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('option')).toHaveCount(21)
  await page.getByRole('combobox').press('End')
  await expect(page.getByRole('option').last()).toBeInViewport()
  await expect(page.getByRole('button', { name: '加载更多', exact: true })).toHaveCount(0)
  await expect(page.getByRole('combobox')).toBeFocused()
  await page.getByRole('combobox').press('Enter')
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            reviewNavigation: { jump: (id: string) => number; path: () => string }
          }
        ).reviewNavigation.jump('00000000-0000-4000-8000-000000000500'),
      ),
    )
    .toBe(21)
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { reviewNavigation: { path: () => string } }).reviewNavigation.path(),
      ),
    )
    .toBe(`/c/${conversation.id}`)
})

test('an invalid message search cursor can restart from a fresh first page', async ({ page }) => {
  let firstPages = 0
  await page.route('**/api/search/messages?**', (route) => {
    if (new URL(route.request().url()).searchParams.has('cursor'))
      return answer(
        route,
        { error: { code: 'VALIDATION_FAILED', message: 'Expired cursor', requestId: 'review' } },
        400,
      )
    firstPages += 1
    return answer(route, {
      messages: [makeMessage(1, { body: '游标测试' })],
      users: {},
      nextCursor: firstPages === 1 ? 'expired-cursor' : null,
    })
  })
  await page.goto('/?mode=shell')
  await openShellPalette(page)
  await page.getByRole('combobox').fill('游标测试')
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.getByRole('button', { name: '加载更多', exact: true }).click()
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect.poll(() => firstPages).toBe(2)
  await expect(page.getByRole('button', { name: '重试', exact: true })).toHaveCount(0)
})

test('a failed task page preserves loaded tasks and an invalid cursor refreshes that source', async ({
  page,
}) => {
  let firstPages = 0
  await page.route('**/api/scheduled-messages?**', (route) => {
    const later = new URL(route.request().url()).searchParams.has('cursor')
    if (later && firstPages === 1)
      return answer(
        route,
        { error: { code: 'VALIDATION_FAILED', message: 'Expired cursor', requestId: 'review' } },
        400,
      )
    if (!later) firstPages += 1
    return answer(route, {
      scheduledMessages: later
        ? [task(51)]
        : Array.from({ length: 50 }, (_, index) => task(index + 1)),
      nextCursor: later ? null : `page-${firstPages}`,
    })
  })
  await page.goto('/?mode=tasks')
  await expect(page.locator('.task-row')).toHaveCount(50)
  await page.getByRole('button', { name: '加载更多 · 定时消息', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(50)
  await page.getByRole('button', { name: '重试 · 定时消息', exact: true }).click()
  await expect.poll(() => firstPages).toBe(2)
  await page.getByRole('button', { name: '加载更多 · 定时消息', exact: true }).click()
  await expect(page.locator('.task-row')).toHaveCount(51)
})

test('audit filters match their request and a target link opens the correctly filtered management list', async ({
  page,
}) => {
  await page.route('**/api/admin/audit-logs?**', (route) =>
    answer(route, {
      entries: [
        {
          id: uuid(10),
          action: 'user.ban',
          actorName: 'Operator',
          targetType: 'user',
          targetId: member.id,
          summary: { roleChanged: true },
          createdAt: run.createdAt,
        },
      ],
      nextCursor: null,
    }),
  )
  await page.goto('/?mode=admin')
  await page.getByRole('button', { name: '审计', exact: true }).click()
  await expect(page.locator('.admin-list')).toContainText(member.id)
  await page.getByRole('textbox', { name: '动作（完整名称）' }).fill('user.ban')
  await page.getByRole('textbox', { name: '操作者 ID' }).fill(me.id)
  const filtered = page.waitForRequest((request) => request.url().includes('action=user.ban'))
  await page.getByRole('button', { name: '应用筛选', exact: true }).click()
  expect(new URL((await filtered).url()).searchParams.get('actorId')).toBe(me.id)
  const target = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('query') === member.id,
  )
  await page.getByRole('button', { name: '查看操作对象', exact: true }).click()
  await target
  await expect(page.getByRole('textbox', { name: '搜索成员或会话' })).toHaveValue(member.id)
  await expect(page.locator('.admin-list')).toContainText('Alice')
})

test('welcome actions open direct message and assistant dialogs without requiring a shortcut', async ({
  page,
}) => {
  await page.goto('/?mode=shell')
  await page.getByRole('button', { name: '发起私信', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '发起私信', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '新建助手对话', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '新建助手对话', exact: true })).toBeVisible()
})

for (const status of [403, 503, 0]) {
  test(`AI usage failure ${status} has an explicit error and retry, and recovers without inventing a quota`, async ({
    page,
  }) => {
    let recovered = false
    await page.route('**/api/agent/usage', (route) =>
      recovered
        ? answer(route, usage)
        : status === 0
          ? route.abort('internetdisconnected')
          : failure(route, status),
    )
    await page.goto('/?mode=usage')
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.locator('.agent-usage')).not.toContainText('正在加载')
    await expect(page.locator('.agent-usage')).not.toContainText('1000')
    recovered = true
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.locator('.agent-usage')).toContainText('123')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
}

test('AI usage keeps the last data and timestamp when a refresh fails', async ({ page }) => {
  await page.goto('/?mode=usage')
  await expect(page.locator('.agent-usage')).toContainText('123')
  await page.route('**/api/agent/usage', (route) => failure(route))
  await page.evaluate(() =>
    (window as unknown as { review: { refreshUsage: () => Promise<void> } }).review.refreshUsage(),
  )
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('.agent-usage')).toContainText('123')
  await expect(page.locator('.agent-usage')).toContainText('上次更新')
})

test('admin tab changes reset the draft, applied filter and cursor together', async ({ page }) => {
  await page.goto('/?mode=admin')
  const field = page.getByRole('textbox', { name: '搜索成员或会话' })
  await field.fill('Alice')
  const searched = page.waitForRequest((request) => request.url().includes('query=Alice'))
  await page.getByRole('button', { name: '搜索成员或会话', exact: true }).click()
  await searched
  const changed = page.waitForRequest((request) =>
    request.url().includes('/api/admin/conversations'),
  )
  await page.getByRole('button', { name: '频道与群组', exact: true }).click()
  expect(new URL((await changed).url()).searchParams.has('query')).toBe(false)
  await expect(field).toHaveValue('')
  await page.getByRole('button', { name: '成员', exact: true }).click()
  await expect(field).toHaveValue('')
})

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [320, 767, 768, 1023, 1024, 1440]) {
    test(`shell ${width}px ${colorScheme} has named usable collapse controls and reachable navigation`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/?mode=shell')
      await expect(page.getByRole('heading', { name: '欢迎回来，Alice' })).toBeVisible()
      if (width < 1024) {
        await page.locator('.toolbar__menu-btn').click()
        await expect(page.locator('.sidebar .search__text')).toBeVisible()
        await expect(page.locator('.sidebar__top .icon-btn')).toBeVisible()
      }
      const toggle = page.locator('.s-section__toggle').first()
      await expect(toggle).toHaveAccessibleName(/.+/)
      const bounds = await toggle.boundingBox()
      expect(bounds?.height).toBeGreaterThanOrEqual(28)
      await toggle.focus()
      await page.keyboard.press('Space')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await page.keyboard.press('Space')
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      if (width < 1024) await page.keyboard.press('Escape')
      await page.getByRole('heading', { name: '欢迎回来，Alice' }).click()
      await page.mouse.move(width - 20, 880)
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      expect(
        axe.violations.map((violation) => ({
          id: violation.id,
          nodes: violation.nodes.map((node) => node.target),
        })),
      ).toEqual([])
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    })
  }
}

test('a desktop folded group remains expandable after shrinking to the rail; desktop resizing releases the drawer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/?mode=shell')
  await page.locator('.s-section__toggle').first().click()
  await page.setViewportSize({ width: 768, height: 900 })
  const toggle = page.locator('.s-section__toggle').first()
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAccessibleName(/.+/)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.locator('.toolbar__menu-btn').click()
  await expect(page.locator('main')).toHaveAttribute('inert', '')
  await page.setViewportSize({ width: 1024, height: 900 })
  await expect(page.locator('main')).not.toHaveAttribute('inert', '')
})
