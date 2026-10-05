import { createVerifiedMember } from './support/api.ts'
import {
  createGroupApi,
  message,
  myId,
  openFromSidebar,
  sendApi,
  sendFromComposer,
  signedIn,
} from './support/chat.ts'
import { expect, newContext, test } from './support/fixtures.ts'
import { signIn } from './support/ui.ts'

/**
 * L-11 (docs/07): what people send is shown as text. Markup in a message does not run, does not become elements and
 * provokes no policy violation. And the Trusted Types canary: the policy really is enforced in this engine, so a bug that
 * wrote a string as HTML would throw instead of running (D-146, D-148).
 */
const HOSTILE = [
  '<img src=x onerror="window.__pwned = 1">',
  '<script>window.__pwned = 1</script>',
  '[click me](javascript:window.__pwned=1)',
  '<a href="javascript:window.__pwned=1">link</a>',
  '<svg onload="window.__pwned = 1"></svg>',
  '<iframe srcdoc="<script>parent.__pwned=1</script>"></iframe>', // guard-allow: a hostile sample, sent as text
  '![x](https://example.test/x.png)',
]

test('@smoke L-11: hostile markup in a message is plain text, nothing runs, and nothing is blocked', async ({
  page,
  browser,
}) => {
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `注入群${Date.now().toString(36)}`
  const groupId = await createGroupApi(apiA, name, [bobId])

  const bobContext = await newContext(browser)
  const b = await bobContext.newPage()
  await signIn(b, bob.email, bob.password)
  await openFromSidebar(b, name)

  // Sent from A over the API and typed by B in the field: both reach B's screen as they are.
  for (const text of HOSTILE) await sendApi(apiA, groupId, text)
  await signIn(page, alice.email, alice.password)
  await openFromSidebar(page, name)
  await sendFromComposer(page, '<img src=x onerror="window.__pwned = 1">来自界面')

  for (const screen of [b, page]) {
    await expect(message(screen, '<svg onload="window.__pwned = 1"></svg>')).toBeVisible()
    await expect(message(screen, '来自界面')).toBeVisible()
    // The text of the first one is shown, character for character.
    await expect(
      screen.locator('article[data-message-id]').filter({ hasText: '<img src=x onerror=' }).first(),
    ).toContainText('<img src=x onerror="window.__pwned = 1">')
    // Nothing became an element of the page, nothing ran.
    await expect(
      screen.locator('.bubble img, .bubble iframe, .bubble svg, .bubble script'),
    ).toHaveCount(0)
    expect(
      await screen.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined()
    // A link that is not http, https or mailto is not a link.
    await expect(screen.locator('.bubble a[href^="javascript:"]')).toHaveCount(0)
  }
})

test('Trusted Types canary: assigning a string as HTML throws, and that is the one violation', async ({
  page,
  claimViolation,
  allowConsole,
}) => {
  claimViolation(/require-trusted-types-for/, 'the canary assigns a string as HTML on purpose')
  allowConsole(
    /requires 'TrustedHTML' assignment/,
    'Chromium reports the blocked assignment on the console',
    ['chromium'],
  )
  allowConsole(
    /This requires a TrustedHTML value else it violates/,
    'WebKit reports the blocked assignment on the console',
    ['webkit'],
  )
  await page.goto('/login')
  const outcome = await page.evaluate(() => {
    try {
      document.createElement('div').innerHTML = '<b>x</b>' // guard-allow: the canary writes a string to the sink on purpose
      return 'no error'
    } catch (error) {
      return error instanceof Error ? error.name : 'unknown'
    }
  })
  expect(outcome).toBe('TypeError')
  // The browser reports the violation to the page; exactly one, and the test's claim above accounts for it.
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as unknown as { __csp: unknown[] }).__csp)).length,
    )
    .toBe(1)
})
