import { createVerifiedMember } from './support/api.ts'
import {
  composer,
  createGroupApi,
  message,
  openFromSidebar,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * docs/08 section 3, scenario 12 (M2b, D-050, D-154): while a Chinese input method is composing, Enter confirms the
 * candidate and does not send. Chromium only: the composition is driven through the DevTools protocol, which the other
 * engines do not offer; the rule itself (the 40 ms grace after the composition ends, for engines that deliver the final
 * Enter after `compositionend`) is covered by the unit tests of `enter-key.ts`.
 */
test('Enter while an input method is composing confirms the candidate and sends nothing', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'the composition is simulated through the DevTools protocol',
  )
  const alice = await createVerifiedMember('alice')
  const name = `输入法群${Date.now().toString(36)}`
  await createGroupApi(await signedIn(alice), name)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)

  const client = await page.context().newCDPSession(page)
  const field = composer(page)
  await field.focus()

  // The person types "nihao" into the input method: the field shows the composition, nothing is committed.
  await client.send('Input.imeSetComposition', {
    text: 'nihao',
    selectionStart: 5,
    selectionEnd: 5,
  })
  // Enter picks the candidate. (A real input method swallows that key; the simulated one does not, so the browser may
  // add a line break of its own. What is under test is that the composer does not send.)
  await page.keyboard.press('Enter')
  await client.send('Input.insertText', { text: '你好' })
  await page.waitForTimeout(300)
  await expect(message(page, '你好')).toHaveCount(0)
  await expect(page.locator('[data-pending]')).toHaveCount(0)
  await expect(field).toHaveValue(/你好/)

  // Once nothing is composing, the same Enter sends the message.
  await field.fill('你好')
  await field.press('Enter')
  await expect(message(page, '你好')).toBeVisible()
  await expect(field).toHaveValue('')

  // Shift+Enter breaks the line and sends nothing.
  await field.fill('第一行')
  await field.press('Shift+Enter')
  await field.pressSequentially('第二行')
  await expect(field).toHaveValue('第一行\n第二行')
  await sendFromComposer(page, '第一行\n第二行')
  await expect(message(page, '第二行')).toBeVisible()
})
