import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createChannelApi,
  createGroupApi,
  memberRow,
  myId,
  openDetails,
  openDmApi,
  openFromSidebar,
  sendApi,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * Automated accessibility checks (docs/08 section 2, AT-21): axe-core against WCAG 2.2 A and AA on the key screens, in
 * light and dark. Axe finds a part of the problems (roughly a third); the keyboard, focus and reading-order checks in the
 * other specs and the by-hand screen-reader pass listed in docs/12 cover the rest.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

async function expectAccessible(
  page: Page,
  label: string,
  options: { popup?: boolean } = {},
): Promise<void> {
  // A menu is drawn in a layer of its own, outside every landmark by nature: the rule about landmarks is not asked of it.
  const builder = new AxeBuilder({ page }).withTags(TAGS)
  if (options.popup) builder.disableRules(['region'])
  const result = await builder.analyze()
  const found = result.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact}): ${violation.help}\n` +
      violation.nodes
        .slice(0, 3)
        .map(
          (node) =>
            `    ${node.target.join(' ')}  ${node.failureSummary?.split('\n')[1]?.trim() ?? ''}`,
        )
        .join('\n'),
  )
  expect(found, `accessibility violations on ${label}`).toEqual([])
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('pages before sign-in', async ({ page }) => {
      for (const path of [
        '/login',
        '/register',
        '/forgot-password',
        '/check-email',
        '/verify-email#token=nonsense',
        '/reset-password',
      ]) {
        await page.goto(path)
        await expect(page.locator('main h1')).toBeVisible()
        await expectAccessible(page, `${path} (${scheme})`)
      }
    })

    test('the app shell, its dialogs and the settings sheet', async ({ page }) => {
      const person = await createVerifiedMember(`axe${scheme}`)
      await signIn(page, person.email, person.password)
      await expectAccessible(page, `shell (${scheme})`)

      await page.keyboard.press('Control+j')
      await expect(page.getByRole('complementary', { name: '详情与助手' })).toBeVisible()
      await expectAccessible(page, `shell with the assistant panel (${scheme})`)
      await page.keyboard.press('Control+j')

      await page.keyboard.press('Control+k')
      await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible()
      await expectAccessible(page, `command palette (${scheme})`)
      await page.keyboard.press('Escape')

      await page.keyboard.press('Control+/')
      await expect(page.getByRole('dialog', { name: '键盘快捷键' })).toBeVisible()
      await expectAccessible(page, `shortcut help (${scheme})`)
      await page.keyboard.press('Escape')

      for (const section of ['appearance', 'account', 'invites'] as const) {
        await openSettings(page, section)
        await expectAccessible(page, `settings ${section} (${scheme})`)
      }
    })

    test('the conversation screens: timeline, composer, details panel, dialogs, menus and lists', async ({
      page,
    }) => {
      test.setTimeout(120_000)
      const person = await createVerifiedMember(`chat${scheme}`)
      const friend = await createVerifiedMember(`pal${scheme}`)
      const api = await signedIn(person)
      const friendApi = await signedIn(friend)
      const friendId = await myId(friendApi)
      const name = `无障碍群${Date.now().toString(36)}`
      const groupId = await createGroupApi(api, name, [friendId])
      const first = await sendApi(
        api,
        groupId,
        '第一条：**加粗**、`代码` 和 [链接](https://example.test/a)',
      )
      await sendApi(friendApi, groupId, '- 列表一\n- 列表二\n\n```ts\nconst x = 1\n```', first.id)
      await sendApi(api, groupId, '最后一条消息')
      const channel = `无障碍频道${Date.now().toString(36)}`
      await createChannelApi(api, channel)
      // A direct message is listed for the other person once something has been said in it.
      const dm = await openDmApi(friendApi, await myId(api))
      await sendApi(friendApi, dm, '私信里的第一句话')

      await signIn(page, person.email, person.password)
      await openFromSidebar(page, name)
      await expect(page.locator('article[data-message-id]').first()).toBeVisible()
      await expectAccessible(page, `a conversation (${scheme})`)

      // The details panel, its menus and its dialogs.
      await openDetails(page)
      await expectAccessible(page, `the details of a group (${scheme})`)
      await memberRow(page, friend.name)
        .getByRole('button', { name: /的操作/ })
        .click()
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, `a member menu (${scheme})`, { popup: true })
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '添加成员' }).first().click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expectAccessible(page, `the add-members dialog (${scheme})`)
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: '创建链接' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expectAccessible(page, `the new-link dialog (${scheme})`)
      await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
      await expect(page.getByRole('textbox', { name: '邀请链接' })).toBeVisible()
      await expectAccessible(page, `the link that was made (${scheme})`)
      await page.getByRole('dialog').getByRole('button', { name: '完成' }).click()

      // A message's menu, and the question before deleting.
      await page.locator('article[data-message-id]').last().click({ button: 'right' })
      await expect(page.getByRole('menu')).toBeVisible()
      await expectAccessible(page, `a message menu (${scheme})`, { popup: true })
      await page.getByRole('menuitem', { name: '仅自己删除' }).click()
      await expect(page.getByRole('alertdialog')).toBeVisible()
      await expectAccessible(page, `the delete question (${scheme})`)
      await page.keyboard.press('Escape')

      // A direct message, the sidebar's menu and the dialogs that start conversations.
      await openFromSidebar(page, friend.name)
      await expect(page.locator('.details__name')).toHaveText(friend.name)
      // The list draws its rows after the panel is there; a feed is only a feed once it holds an article.
      await expect(page.locator('article[data-message-id]').first()).toBeVisible()
      await expectAccessible(page, `a direct message with its profile (${scheme})`)
      await page.getByRole('button', { name: '新建', exact: true }).click()
      await page.getByRole('menuitem', { name: '新建频道' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expectAccessible(page, `the new-channel dialog (${scheme})`)
      await page.keyboard.press('Escape')

      // The lists: the channel directory and the archive.
      await page.goto('/channels')
      await expect(page.locator('.list-row').first()).toBeVisible()
      await expectAccessible(page, `the channel directory (${scheme})`)
      await page.goto('/archived')
      await expect(page.getByText('没有已归档的会话。')).toBeVisible()
      await expectAccessible(page, `the archive (${scheme})`)
    })

    test('a conversation in which nobody has written yet', async ({ page }) => {
      const person = await createVerifiedMember(`empty${scheme}`)
      const api = await signedIn(person)
      const name = `空频道${Date.now().toString(36)}`
      await createChannelApi(api, name)
      await signIn(page, person.email, person.password)
      await openFromSidebar(page, name)
      await expect(composer(page)).toBeVisible()
      await expect(page.locator('article[data-message-id]')).toHaveCount(0)
      await expectAccessible(page, `an empty conversation (${scheme})`)
    })

    test('the timeline in the screen reader mode (page by page) and the conversation that cannot be found', async ({
      page,
    }) => {
      const person = await createVerifiedMember(`reader${scheme}`)
      const api = await signedIn(person)
      const name = `读屏群${Date.now().toString(36)}`
      const groupId = await createGroupApi(api, name)
      for (let i = 1; i <= 5; i += 1) await sendApi(api, groupId, `读屏消息 ${i}`)
      await signIn(page, person.email, person.password)
      await openSettings(page, 'appearance')
      await page.getByRole('switch', { name: /消息按页载入/ }).click()
      await page.keyboard.press('Escape')
      await openFromSidebar(page, name)
      await expect(page.locator('article[data-message-id]').first()).toBeVisible()
      await expectAccessible(page, `the timeline page by page (${scheme})`)
      await page.goto(`/c/${crypto.randomUUID()}`)
      await expect(page.getByText('找不到这个会话', { exact: true })).toBeVisible()
      await expectAccessible(page, `a conversation that cannot be found (${scheme})`)
    })
  })
}
