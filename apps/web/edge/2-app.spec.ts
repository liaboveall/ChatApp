import { createVerifiedMember } from '../e2e/support/api.ts'
import {
  composer,
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendFromComposer,
  signedIn,
} from '../e2e/support/chat.ts'
import { expect, newContext, test } from '../e2e/support/fixtures.ts'
import { openSettings, signIn } from '../e2e/support/ui.ts'

/**
 * The application behind the real gateway, over HTTPS (docs/12 D-147): the session cookie is a `__Host-` cookie, the
 * conversation works over `wss://` (typing and messages arrive), and a Passkey is registered and used for the host name the
 * gateway serves (its RP ID is `chat.localhost`). Every test here counts against the API's per-address limits, which the
 * whole suite shares (everything reaches the API from the gateway), so there are few and none repeats a sign-up.
 */
test('@smoke over HTTPS: a __Host- session cookie, and a conversation that works over wss', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `网关群${Date.now().toString(36)}`
  await createGroupApi(apiA, name, [bobId])

  await signIn(page, alice.email, alice.password)
  const session = (await page.context().cookies()).find((cookie) =>
    cookie.name.startsWith('__Host-'),
  )
  expect(session, 'a session cookie with the __Host- prefix').toBeDefined()
  expect(session).toMatchObject({ secure: true, httpOnly: true, path: '/', sameSite: 'Lax' })

  const bContext = await newContext(browser)
  const b = await bContext.newPage()
  await signIn(b, bob.email, bob.password)
  await openFromSidebar(page, name)
  await openFromSidebar(b, name)

  await sendFromComposer(page, '经过网关的消息')
  await expect(message(b, '经过网关的消息')).toBeVisible()
  await composer(b).pressSequentially('在输入')
  await expect(page.getByText(`${bob.name} 正在输入…`)).toBeVisible()
  await composer(b).fill('')
  await sendFromComposer(b, '收到了')
  await expect(message(page, '收到了')).toBeVisible()
})

test.describe('passkeys behind the gateway', () => {
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'virtual authenticators exist only in Chromium',
  )

  test('a passkey is added for chat.localhost and signs the person in', async ({
    page,
    context,
  }) => {
    const person = await createVerifiedMember('passkey')
    await signIn(page, person.email, person.password)
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
    await openSettings(page, 'account')
    await page
      .locator('.row', { has: page.getByText('Passkey', { exact: true }) })
      .getByRole('button', { name: '添加' })
      .click()
    await expect(page.getByText('Passkey 已添加')).toBeVisible()
    await page.getByRole('button', { name: '退出登录' }).click()
    await expect(page).toHaveURL(/\/login/)
    await page.getByRole('button', { name: '使用 Passkey 登录' }).click()
    await expect(page.getByRole('heading', { name: `欢迎回来，${person.name}` })).toBeVisible()
  })
})
