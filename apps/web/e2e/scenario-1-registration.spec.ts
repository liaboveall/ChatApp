import { adminCredentials, newPerson } from './support/accounts.ts'
import { cspViolations, expect, newContext, test } from './support/fixtures.ts'
import { deleteMail, linkIn, waitForMail } from './support/mailpit.ts'
import { openSettings, signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 1 (M1b): the administrator creates an invitation, a new person registers through the link,
 * verifies the email from Mailpit and signs in to the app shell. Everything goes through the real interface.
 */
test('@smoke administrator invites, new member registers, verifies by email and signs in', async ({
  page,
  browser,
}) => {
  const admin = adminCredentials()
  const person = newPerson('member')

  // 1. The administrator creates an invitation in Settings and copies its registration link.
  await signIn(page, admin.email, admin.password)
  await openSettings(page, 'invites')
  await page.getByRole('button', { name: '生成邀请码' }).click()
  const link = await page.getByLabel('注册链接').inputValue()
  expect(link).toMatch(/\/register#invite=[A-Z2-7]{16}$/)

  // 2. The new member opens the link in their own browser. The code is read from the fragment and leaves the address bar.
  const memberContext = await newContext(browser)
  const member = await memberContext.newPage()
  try {
    const started = Date.now()
    await member.goto(new URL(link).pathname + new URL(link).hash)
    await expect(member.getByLabel('邀请码')).toHaveValue(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/)
    await expect(member.getByText('邀请码有效。')).toBeVisible()
    expect(member.url()).not.toContain('invite=')

    // 3. They fill in the form; the password rules are visible and are met.
    await member.getByLabel('邮箱').fill(person.email)
    await member.getByLabel('用户名').fill(person.username)
    await member.getByLabel('显示名').fill(person.name)
    await member.getByLabel('密码', { exact: true }).fill(person.password)
    await member.getByRole('button', { name: '注册', exact: true }).click()

    // 4. "Check your inbox": the page names the masked address.
    await expect(member.getByRole('heading', { name: '查看你的邮箱' })).toBeVisible()
    await expect(member.getByText(`${person.email.charAt(0)}***@example.test`)).toBeVisible()

    // 5. Until the address is verified, signing in is refused.
    const early = await memberContext.newPage()
    await early.goto('/login')
    await early.getByLabel('邮箱').fill(person.email)
    await early.getByLabel('密码', { exact: true }).fill(person.password)
    await early.getByRole('button', { name: '登录', exact: true }).click()
    await expect(early.getByText('这个邮箱还没有验证，不能登录。')).toBeVisible()
    await early.close()

    // 6. The email arrives in Mailpit; its link carries the token in the fragment only.
    const mail = await waitForMail(person.email, started - 2_000)
    const { path, token } = linkIn(mail, '/verify-email')
    await member.goto(`${path}#token=${token}`)
    await expect(member.getByRole('heading', { name: '确认验证邮箱' })).toBeVisible()
    expect(member.url()).not.toContain('token=') // removed from the address bar once read

    // 7. Opening the link verified nothing; a person has to confirm.
    await member.getByRole('button', { name: '确认验证' }).click()
    await expect(member.getByRole('heading', { name: '邮箱已验证' })).toBeVisible()
    await deleteMail(mail.id)

    // 8. Now signing in works and the app shell appears, with the member's own name.
    await member.getByRole('link', { name: '去登录' }).click()
    await member.getByLabel('邮箱').fill(person.email)
    await member.getByLabel('密码', { exact: true }).fill(person.password)
    await member.getByRole('button', { name: '登录', exact: true }).click()
    await expect(member.getByRole('heading', { name: `欢迎回来，${person.name}` })).toBeVisible()
    await expect(member.getByRole('navigation', { name: '会话' })).toBeVisible()
    expect(await cspViolations(member)).toEqual([])
  } finally {
    await memberContext.close()
  }
})
