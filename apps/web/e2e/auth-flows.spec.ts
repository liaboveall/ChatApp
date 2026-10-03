import { newPerson } from './support/accounts.ts'
import { createInviteCode, createVerifiedMember, registerMember } from './support/api.ts'
import { expect, test } from './support/fixtures.ts'
import { deleteMail, linkIn, waitForMail } from './support/mailpit.ts'
import { signIn } from './support/ui.ts'

/** Sign-in, registration, e-mail verification and password reset, with their failures (docs/01 section 4.1, docs/05 section 3.1). */

test.describe('sign in', () => {
  test('@smoke the form explains what is missing and what is wrong', async ({ page }) => {
    await page.goto('/login')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByText('请输入完整的邮箱地址。')).toBeVisible()
    await expect(page.getByText('请输入密码。')).toBeVisible()

    const person = await createVerifiedMember('wrongpw')
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByLabel('密码', { exact: true }).fill('not-the-password-1')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    // The same answer for a wrong password and for an unknown account: nothing to enumerate.
    await expect(page.getByRole('alert')).toContainText('邮箱或密码不对')
    await expect(page).toHaveURL(/\/login/)

    await page.getByLabel('邮箱').fill('nobody-here@example.test')
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('邮箱或密码不对')
  })

  test('the password can be shown and hidden', async ({ page }) => {
    await page.goto('/login')
    const field = page.getByLabel('密码', { exact: true })
    await field.fill('visible-secret-1')
    await expect(field).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: '显示密码' }).click()
    await expect(field).toHaveAttribute('type', 'text')
    await page.getByRole('button', { name: '隐藏密码' }).click()
    await expect(field).toHaveAttribute('type', 'password')
  })

  test('a signed-in visitor is taken from the sign-in page to the app, and back after a deep link', async ({
    page,
  }) => {
    const person = await createVerifiedMember('deeplink')
    // An address behind the sign-in: the guard sends the visitor to the form and returns afterwards.
    await page.goto('/?settings=invites')
    await expect(page).toHaveURL(/\/login\?redirect=/)
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByLabel('密码', { exact: true }).fill(person.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page).toHaveURL(/settings=invites/)
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.goto('/login')
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('a redirect target outside this site is ignored', async ({ page }) => {
    const person = await createVerifiedMember('openredirect')
    await page.goto('/login?redirect=//evil.example/steal')
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByLabel('密码', { exact: true }).fill(person.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page).toHaveURL('http://localhost:4173/')
  })
})

test.describe('registration', () => {
  test('a wrong invitation code is explained before anything is filled in', async ({ page }) => {
    await page.goto('/register#invite=AAAAAAAAAAAAAAAA')
    await expect(page.getByText('邀请码无效、已过期或已用完')).toBeVisible()
    await page.goto('/register')
    await page.getByLabel('邀请码').fill('not a code')
    await page.getByLabel('邀请码').blur()
    await expect(page.getByText('邀请码格式不对')).toBeVisible()
  })

  test("the rules for a new password are listed and the server's refusals are shown on the field", async ({
    page,
  }) => {
    const code = await createInviteCode()
    const person = newPerson('rules')
    await page.goto(`/register#invite=${code}`)
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByLabel('用户名').fill(person.username)
    await page.getByLabel('显示名').fill(person.name)
    const rules = page.getByRole('list', { name: '密码要求' })
    await page.getByLabel('密码', { exact: true }).fill('short')
    await expect(rules).toContainText('至少 10 位，未满足')
    await page.getByLabel('密码', { exact: true }).fill(`${person.username}-x-1234`)
    await expect(rules).toContainText('不含邮箱前缀、用户名、显示名或产品名，未满足')
    // A password from the common list passes the local rules and is refused by the server.
    await page.getByLabel('密码', { exact: true }).fill('basketball')
    await page.getByLabel('密码', { exact: true }).fill('qwertyuiop1')
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await expect(page.getByText(/常见的弱密码|密码太简单|还没有满足/)).toBeVisible()
  })

  test('reserved and taken usernames are refused with the reason', async ({ page }) => {
    const taken = await createVerifiedMember('taken')
    const code = await createInviteCode()
    const person = newPerson('names')
    await page.goto(`/register#invite=${code}`)
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByLabel('显示名').fill(person.name)
    await page.getByLabel('密码', { exact: true }).fill(person.password)
    await page.getByLabel('用户名').fill('admin')
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await expect(page.getByText('这个用户名被保留了，换一个。')).toBeVisible()
    await page.getByLabel('用户名').fill(taken.username)
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await expect(page.getByText('这个用户名已被占用，换一个。')).toBeVisible()
  })
})

test.describe('e-mail verification', () => {
  test('sending the mail again replaces the earlier link', async ({ page }) => {
    const { person, startedAt } = await registerMember('resend')
    const first = await waitForMail(person.email, startedAt - 2_000)
    const firstLink = linkIn(first, '/verify-email')

    // Signing in is refused, and the page offers to send the mail again.
    await page.goto('/login')
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByLabel('密码', { exact: true }).fill(person.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('link', { name: '重新发送验证邮件' }).click()
    await expect(page.getByRole('heading', { name: '查看你的邮箱' })).toBeVisible()
    const before = Date.now()
    await page.getByRole('button', { name: '重新发送验证邮件' }).click()
    await expect(page.getByRole('button', { name: /秒后可以重发/ })).toBeVisible()
    const second = await waitForMail(person.email, before - 1_000, 20_000, [first.id])
    expect(second.id).not.toBe(first.id)
    const secondLink = linkIn(second, '/verify-email')
    expect(secondLink.token).not.toBe(firstLink.token)

    // The old link no longer works; the new one does.
    await page.goto(`/verify-email#token=${firstLink.token}`)
    await page.getByRole('button', { name: '确认验证' }).click()
    await expect(page.getByRole('heading', { name: '这个链接不能用了' })).toBeVisible()
    await page.goto(`/verify-email#token=${secondLink.token}`)
    await page.getByRole('button', { name: '确认验证' }).click()
    await expect(page.getByRole('heading', { name: '邮箱已验证' })).toBeVisible()
    await deleteMail(first.id)
    await deleteMail(second.id)
  })

  test('a link that is not a token, or no link at all, leads somewhere sensible', async ({
    page,
  }) => {
    await page.goto('/verify-email#token=nonsense')
    await expect(page.getByRole('heading', { name: '这个链接不能用了' })).toBeVisible()
    await page.goto('/verify-email')
    await expect(page).toHaveURL(/\/check-email/)
    await expect(page.getByRole('heading', { name: '重新发送验证邮件' })).toBeVisible()
  })
})

test.describe('password reset', () => {
  test('@smoke request, mail, new password, old password refused, link used once', async ({
    page,
  }) => {
    const person = await createVerifiedMember('reset')
    const started = Date.now()

    await page.goto('/login')
    await page.getByRole('link', { name: '忘记密码？' }).click()
    // The address changes while the old page is still on screen (the new route's script is fetched first), and the sign-in
    // form has an «邮箱» field too: without waiting for the new page the address is typed into the form that is about to
    // be replaced, and the reset form is submitted empty.
    await expect(page.getByRole('heading', { name: '找回密码' })).toBeVisible()
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByRole('button', { name: '发送重置邮件' }).click()
    await expect(page.getByRole('heading', { name: '检查你的邮箱' })).toBeVisible()

    const mail = await waitForMail(person.email, started - 2_000)
    const { token } = linkIn(mail, '/reset-password')
    await page.goto(`/reset-password#token=${token}`)
    await expect(page).not.toHaveURL(/token=/) // read once, then removed from the address bar

    const newPassword = `Zq9-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}-comet`
    await page.getByLabel('新密码').fill(newPassword)
    await page.getByLabel('再输入一次').fill(`${newPassword}x`)
    await page.getByRole('button', { name: '重置密码' }).click()
    await expect(page.getByText('两次输入的密码不一样。')).toBeVisible()
    await page.getByLabel('再输入一次').fill(newPassword)
    await page.getByRole('button', { name: '重置密码' }).click()
    await expect(page.getByRole('heading', { name: '密码已重置' })).toBeVisible()

    // The old password is dead, the new one signs in.
    await page.getByRole('link', { name: '去登录' }).click()
    await page.getByLabel('邮箱').fill(person.email)
    await page.getByLabel('密码', { exact: true }).fill(person.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('邮箱或密码不对')
    await page.getByLabel('密码', { exact: true }).fill(newPassword)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await expect(page.getByRole('navigation', { name: '会话' })).toBeVisible()

    // The same link a second time: used up.
    await page.goto(`/reset-password#token=${token}`)
    await page.getByLabel('新密码').fill(`${newPassword}-2`)
    await page.getByLabel('再输入一次').fill(`${newPassword}-2`)
    await page.getByRole('button', { name: '重置密码' }).click()
    await expect(page.getByRole('heading', { name: '这个链接不能用了' })).toBeVisible()
    await deleteMail(mail.id)
  })

  test('asking for a reset gives the same answer for an unknown address', async ({ page }) => {
    await page.goto('/forgot-password')
    await page.getByLabel('邮箱').fill('nobody-registered@example.test')
    await page.getByRole('button', { name: '发送重置邮件' }).click()
    await expect(page.getByRole('heading', { name: '检查你的邮箱' })).toBeVisible()
    await expect(page.getByText('我们不会告诉你这个邮箱是否注册过')).toBeVisible()
  })

  test('a reset link without a token explains itself', async ({ page }) => {
    await page.goto('/reset-password')
    await expect(page.getByRole('heading', { name: '这个链接不能用了' })).toBeVisible()
    await page.getByRole('link', { name: '重新申请重置邮件' }).click()
    await expect(page).toHaveURL(/\/forgot-password/)
    void signIn
  })
})
