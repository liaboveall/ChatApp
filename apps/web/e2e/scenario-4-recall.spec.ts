import { createVerifiedMember } from './support/api.ts'
import {
  ageMessage,
  composer,
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 4 (M2b) and L-07: A recalls a message within two minutes and B sees the notice; after the
 * time is up the interface no longer offers it. A's browser clock is ten minutes slow and the message is made three
 * minutes older on the server (D-155): the client has to judge by the server's time (corrected with `hello.serverTime`),
 * because by its own clock the message is from the future and would still look recallable.
 */
test('@smoke a message can be recalled within two minutes, B sees the notice, and later the menu has no recall (judged by the server clock)', async ({
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `撤回群${Date.now().toString(36)}`
  await createGroupApi(apiA, name, [bobId])

  // A's browser runs ten minutes behind; time still flows.
  const aContext = await newContext(browser)
  await aContext.clock.install({ time: Date.now() - 10 * 60_000 })
  await aContext.clock.resume()
  const a = await aContext.newPage()
  const bContext = await newContext(browser)
  const b = await bContext.newPage()
  await signIn(a, alice.email, alice.password)
  await signIn(b, bob.email, bob.password)
  await openFromSidebar(a, name)
  await openFromSidebar(b, name)

  // Within the window: recall from the context menu; B sees who recalled it, A sees "you recalled".
  await sendFromComposer(a, '马上撤回这条')
  await expect(message(b, '马上撤回这条')).toBeVisible()
  await message(a, '马上撤回这条').click({ button: 'right' })
  await a.getByRole('menuitem', { name: '撤回' }).click()
  await expect(b.getByText(`${alice.name} 撤回了一条消息`)).toBeVisible()
  await expect(a.getByText('你撤回了一条消息')).toBeVisible()
  await expect(message(b, '马上撤回这条')).toHaveCount(0)

  // After the window. The page has not heard of the new age yet, so it still offers recall; the server refuses it.
  await sendFromComposer(a, '已经过了两分钟')
  const old = message(a, '已经过了两分钟')
  await expect(old).toBeVisible()
  const id = await old.getAttribute('data-message-id')
  if (id === null) throw new Error('the message has no id')
  await ageMessage(apiA, id, 3 * 60_000)
  await old.click({ button: 'right' })
  await a.getByRole('menuitem', { name: '撤回' }).click()
  await expect(a.getByText('已超过撤回时限。')).toBeVisible()
  await expect(message(a, '已经过了两分钟')).toBeVisible()

  // Read again with the true age: the menu offers everything that is still possible, but not recall.
  await a.reload()
  await openFromSidebar(a, name)
  await message(a, '已经过了两分钟').click({ button: 'right' })
  await expect(a.getByRole('menuitem', { name: '回复' })).toBeVisible()
  await expect(a.getByRole('menuitem', { name: '编辑' })).toBeVisible()
  await expect(a.getByRole('menuitem', { name: '撤回' })).toHaveCount(0)
  await expect(composer(a)).toBeVisible()
})
