import type { DeletionOperation } from '@chatapp/contracts'
import type { Page } from '@playwright/test'
import { createVerifiedMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

// Browser feedback only: offsite status responses are simulated. Real journal/application/restore evidence is separate.
async function deletionStatus(page: Page) {
  const operation: DeletionOperation = {
    operationId: crypto.randomUUID(),
    status: 'pending',
    statusUrl: '',
    version: 1,
    errorCode: null,
  }
  operation.statusUrl = `/api/deletion-operations/${operation.operationId}`
  let complete = false,
    submissions = 0,
    reads = 0
  await page.route('**/api/me', async (route) => {
    if (route.request().method() !== 'DELETE') return await route.continue()
    submissions++
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify(operation),
    })
  })
  await page.route(`**${operation.statusUrl}`, async (route) => {
    reads++
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        complete ? { ...operation, status: 'completed', version: 3 } : operation,
      ),
    })
  })
  return {
    complete: () => {
      complete = true
    },
    reads: () => reads,
    submissions: () => submissions,
  }
}
async function requestDeletion(page: Page, password: string) {
  await openSettings(page, 'account')
  await page.getByRole('button', { name: '注销账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '注销账号', exact: true })
  await dialog.getByLabel('当前密码').fill(password)
  await dialog.getByRole('button', { name: '确认注销账号', exact: true }).click()
  await expect(dialog.getByText('删除处理中，完成前内容可能仍然可见。')).toBeVisible()
  return dialog
}
test('202 keeps an honest pending state, prevents duplicate submission and announces completion only after the same operation completes', async ({
  page,
}) => {
  const person = await createVerifiedMember('deletepending')
  await signIn(page, person.email, person.password)
  const status = await deletionStatus(page)
  const dialog = await requestDeletion(page, person.password)
  expect(
    await dialog.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d')
      if (!context) return 0
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[3]
    }),
  ).toBe(255)
  await expect(dialog.getByRole('button', { name: '确认注销账号', exact: true })).toBeDisabled()
  await expect.poll(status.reads).toBeGreaterThan(0)
  expect(status.submissions()).toBe(1)
  await expect(page.getByText('账号已注销', { exact: true })).toHaveCount(0)
  status.complete()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('账号已注销', { exact: true }).first()).toBeVisible()
  expect(status.submissions()).toBe(1)
})
test('real session revocation moves pending confirmation to the anonymous page without turning logout into deletion success', async ({
  page,
  baseURL,
}) => {
  const person = await createVerifiedMember('deleterevoked')
  await signIn(page, person.email, person.password)
  const status = await deletionStatus(page)
  await requestDeletion(page, person.password)
  const revoked = await page.request.post('/api/me/devices/revoke-all', {
    headers: { origin: baseURL ?? '' },
  })
  expect(revoked.status()).toBe(200)
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('账号注销仍在处理中，完成状态尚未确认。')).toBeVisible()
  await expect(page.getByText('账号已注销', { exact: true })).toHaveCount(0)
  status.complete()
  await expect(page.getByText('账号已注销', { exact: true })).toBeVisible()
  expect(status.submissions()).toBe(1)
})

test('reload retains the pending account deletion locator and confirms only its completed operation after session revocation', async ({
  page,
  baseURL,
}) => {
  const person = await createVerifiedMember('deletereload')
  await signIn(page, person.email, person.password)
  const status = await deletionStatus(page)
  await requestDeletion(page, person.password)
  const revoked = await page.request.post('/api/me/devices/revoke-all', {
    headers: { origin: baseURL ?? '' },
  })
  expect(revoked.status()).toBe(200)
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('账号注销仍在处理中，完成状态尚未确认。')).toBeVisible()
  await page.reload()
  await expect(page.getByText('账号已注销', { exact: true })).toHaveCount(0)
  status.complete()
  await expect(page.getByText('账号已注销', { exact: true })).toBeVisible()
  expect(status.submissions()).toBe(1)
})

test('reload while still signed in restores pending feedback and continues status reads without resubmitting', async ({
  page,
}) => {
  const person = await createVerifiedMember('deleteactive')
  await signIn(page, person.email, person.password)
  const status = await deletionStatus(page)
  await requestDeletion(page, person.password)
  await page.reload()
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '注销账号', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '注销账号', exact: true })
  await expect(dialog.getByText('删除处理中，完成前内容可能仍然可见。')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '确认注销账号', exact: true })).toBeDisabled()
  const reads = status.reads()
  await expect.poll(status.reads).toBeGreaterThan(reads)
  status.complete()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('账号已注销', { exact: true }).first()).toBeVisible()
  expect(status.submissions()).toBe(1)
})

test('ordinary sign-out while account deletion is pending keeps confirmation available after reload', async ({
  page,
}) => {
  const person = await createVerifiedMember('deletesignout')
  await signIn(page, person.email, person.password)
  const status = await deletionStatus(page)
  const dialog = await requestDeletion(page, person.password)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page).toHaveURL(/\/login/)
  await expect(page.getByText('账号注销仍在处理中，完成状态尚未确认。')).toBeVisible()
  await page.reload()
  await expect(page.getByText('账号已注销', { exact: true })).toHaveCount(0)
  status.complete()
  await expect(page.getByText('账号已注销', { exact: true })).toBeVisible()
  expect(status.submissions()).toBe(1)
})

import AxeBuilder from '@axe-core/playwright'

test('pending account deletion keeps keyboard focus in its modal and provides accessible inline feedback', async ({
  page,
}) => {
  const person = await createVerifiedMember('deletefocus')
  await signIn(page, person.email, person.password)
  await deletionStatus(page)
  const dialog = await requestDeletion(page, person.password)
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(result.violations).toEqual([])
  await dialog.getByRole('button', { name: '关闭', exact: true }).focus()
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    // Base UI moves its hidden focus guard back into the modal with requestAnimationFrame.
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    const focus = await dialog.evaluate((element) => ({
      inside: element.contains(document.activeElement),
      tag: document.activeElement?.tagName,
      role: document.activeElement?.getAttribute('role'),
      className: document.activeElement?.className,
      guard: document.activeElement?.hasAttribute('data-base-ui-focus-guard'),
    }))
    expect(focus.inside, `Tab ${i + 1}: ${JSON.stringify(focus)}`).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: '注销账号', exact: true })).toBeFocused()
})
