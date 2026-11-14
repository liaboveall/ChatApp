import { createVerifiedMember } from './support/api.ts'
import { createChannelApi, message, openFromSidebar, sendApi, signedIn } from './support/chat.ts'
import { expect, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * A bubble is never wider than the column it sits in. A line of code does not wrap, so a long one used to give the
 * bubble that width: a message of one's own (aligned to the right) grew out to the left, under the sidebar, and its
 * tools went with it. The code scrolls inside its block instead.
 */
const LONG_LINE =
  "const veryLongLine = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon'].map((name, index) => index + ':' + name).join(' | ')"
const body = (label: string) => `${label}\n\n\`\`\`js\n${LONG_LINE}\n\`\`\`\n\nafter the code`

test('a long line of code stays inside the bubble, in my own message and in somebody else’s', async ({
  page,
}) => {
  const alice = await createVerifiedMember('widealice')
  const bob = await createVerifiedMember('widebob')
  const apiA = await signedIn(alice)
  const apiB = await signedIn(bob)
  const name = `Wide-${Date.now().toString(36)}`
  const id = await createChannelApi(apiA, name)
  expect((await apiB.post(`/api/conversations/${id}/join`, { data: {} })).ok()).toBe(true)
  await sendApi(apiB, id, body('THEIRS_WITH_CODE'))
  await sendApi(apiA, id, body('MINE_WITH_CODE'))

  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  for (const label of ['THEIRS_WITH_CODE', 'MINE_WITH_CODE']) {
    const row = message(page, label)
    const bubble = row.locator('.bubble')
    const code = bubble.locator('pre').first()
    await expect(code).toContainText('veryLongLine')
    const rowBox = await row.boundingBox()
    const bubbleBox = await bubble.boundingBox()
    if (!rowBox || !bubbleBox) throw new Error(`${label}: nothing to measure`)
    expect({
      label,
      startsInside: bubbleBox.x >= rowBox.x - 1,
      endsInside: bubbleBox.x + bubbleBox.width <= rowBox.x + rowBox.width + 1,
    }).toEqual({ label, startsInside: true, endsInside: true })
    // The line is longer than the block: it scrolls there, and nowhere else.
    expect(await code.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true)
})
