import { createVerifiedMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * The full Passkey ceremony (V-13, M1b acceptance: "on localhost, registering and signing in with a Passkey both work").
 * A virtual authenticator stands in for the platform authenticator; it is a Chromium feature, so the other engines are
 * covered by the by-hand check on real hardware (Windows Hello, Touch ID) listed in docs/12.
 */
test.describe('passkeys', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'virtual authenticators exist only in Chromium',
  )

  test('@smoke add a passkey in Settings, sign out, sign in with it, rename and remove it', async ({
    page,
    context,
  }) => {
    const person = await createVerifiedMember('passkey')
    await signIn(page, person.email, person.password)

    // D-078 asks for the Passkey request bodies to be measured against the 128 KiB budget that applies before parsing.
    const posted: Array<{ step: string; bytes: number }> = []
    page.on('request', (request) => {
      const { pathname } = new URL(request.url())
      if (request.method() === 'POST' && pathname.startsWith('/api/auth/passkey/')) {
        posted.push({
          step: pathname.split('/').pop() ?? pathname,
          bytes: request.postDataBuffer()?.length ?? 0,
        })
      }
    })

    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })

    // Register.
    await openSettings(page, 'account')
    const passkeyRow = page.locator('.row', { has: page.getByText('Passkey', { exact: true }) })
    await passkeyRow.getByRole('button', { name: '添加' }).click()
    await expect(page.getByText('Passkey 已添加')).toBeVisible()
    // The new passkey is listed, named after the device it was made on.
    const listed = page.locator('.row', { has: page.getByRole('button', { name: '重命名' }) })
    await expect(listed).toHaveCount(1)
    await expect(listed).toContainText('Chrome')

    // Sign out, then sign in with the passkey alone: no email, no password.
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login/)
    await page.getByRole('button', { name: '使用 Passkey 登录' }).click()
    await expect(page.getByRole('navigation', { name: '会话' })).toBeVisible()
    await expect(page.getByRole('heading', { name: `欢迎回来，${person.name}` })).toBeVisible()

    // Rename and remove.
    await openSettings(page, 'account')
    const row = page.locator('.row', { has: page.getByRole('button', { name: '重命名' }) })
    await row.getByRole('button', { name: '重命名' }).click()
    await page.getByLabel('名称').fill('我的笔记本')
    await page.getByRole('dialog').getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('我的笔记本')).toBeVisible()
    await page
      .locator('.row', { hasText: '我的笔记本' })
      .getByRole('button', { name: '移除' })
      .click()
    await page.getByRole('dialog').getByRole('button', { name: '移除' }).click()
    await expect(page.getByText('Passkey 已移除')).toBeVisible()
    await expect(page.getByText('我的笔记本')).toHaveCount(0)

    // Both ceremonies sent a body, and each is far inside the budget (an eighth of it at most). The numbers go into the
    // report; the server asks for no attestation, so a vendor certificate chain cannot make a real device's body grow.
    const ceremonies = posted.filter(
      ({ step }) => step === 'verify-registration' || step === 'verify-authentication',
    )
    expect(ceremonies.map(({ step }) => step).sort()).toEqual([
      'verify-authentication',
      'verify-registration',
    ])
    for (const { step, bytes } of ceremonies) expect(bytes, step).toBeLessThan(16 * 1024)
    test.info().annotations.push({
      type: 'passkey-body-bytes',
      description: ceremonies.map(({ step, bytes }) => `${step}=${bytes}`).join(' '),
    })
  })

  test('cancelling the system dialog is not an error', async ({ page, context }) => {
    const person = await createVerifiedMember('passkeycancel')
    await page.goto('/login')
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    // No authenticator is present at all: the browser refuses with NotAllowedError, as when the user dismisses the prompt.
    await page.getByRole('button', { name: '使用 Passkey 登录' }).click()
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('alert')).toHaveCount(0)
    void person
  })
})
