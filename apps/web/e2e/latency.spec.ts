import { createVerifiedMember } from './support/api.ts'
import { composer, createGroupApi, myId, openFromSidebar, signedIn } from './support/chat.ts'
import { expect, newContext } from './support/fixtures.ts'
import { recordMeasurement, measuringTest as test } from './support/perf.ts'
import { signIn } from './support/ui.ts'

/**
 * "A message reaches the other person in under 200 ms (p95)" (docs/11 M2b acceptance, docs/12 D-149): two contexts of the
 * same browser, forty samples. The time runs from the key press in A's page to the moment the message is in B's page
 * (the insertion into the document, not the paint). It includes the request, the transaction, the dispatch, Valkey, the
 * gateway, the client's catch-up read and the render. Asserted on a developer's machine; measured and attached on CI.
 */
const LOCAL = !process.env.CI
const SAMPLES = 40

test('@perf forty messages from A to B: send-to-render p95 under 200 ms', async ({ measuring }) => {
  test.setTimeout(180_000)
  const alice = await createVerifiedMember('alice')
  const bob = await createVerifiedMember('bob')
  const apiA = await signedIn(alice)
  const bobId = await myId(await signedIn(bob))
  const name = `延迟群${Date.now().toString(36)}`
  await createGroupApi(apiA, name, [bobId])

  const aContext = await newContext(measuring)
  const bContext = await newContext(measuring)
  const a = await aContext.newPage()
  const b = await bContext.newPage()
  await signIn(a, alice.email, alice.password)
  await signIn(b, bob.email, bob.password)
  await openFromSidebar(a, name)
  await openFromSidebar(b, name)

  // The probes: A notes when Enter goes down; B notes when each message shows up.
  await a.evaluate(() => {
    const w = window as unknown as { __enter: number }
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Enter') w.__enter = Date.now()
      },
      true,
    )
  })
  await b.evaluate(() => {
    const w = window as unknown as { __seen: Record<string, number> }
    w.__seen = {}
    new MutationObserver(() => {
      for (const article of document.querySelectorAll('article[data-message-id]')) {
        const match = /latency-\d+-end/.exec(article.textContent ?? '')
        if (match !== null && w.__seen[match[0]] === undefined) w.__seen[match[0]] = Date.now()
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true })
  })

  const samples: number[] = []
  // Two warm-up messages (first render, first connection use), then the measured ones. One a second keeps A under the
  // limit of ten messages in ten seconds.
  for (let i = -2; i < SAMPLES; i += 1) {
    const token = `latency-${i + 2}-end`
    await composer(a).fill(token)
    await composer(a).press('Enter')
    // Interval polling: a page that is not in front gets no animation frames, which the default polling waits for.
    await b.waitForFunction(
      (key) => (window as unknown as { __seen: Record<string, number> }).__seen[key] !== undefined,
      token,
      { timeout: 10_000, polling: 20 },
    )
    const [sent, seen] = await Promise.all([
      a.evaluate(() => (window as unknown as { __enter: number }).__enter),
      b.evaluate(
        (key) => (window as unknown as { __seen: Record<string, number> }).__seen[key],
        token,
      ),
    ])
    if (i >= 0 && seen !== undefined) samples.push(seen - sent)
    await a.waitForTimeout(1_050)
  }

  samples.sort((x, y) => x - y)
  const p95 = samples[Math.floor(0.95 * samples.length)] ?? Number.POSITIVE_INFINITY
  const numbers = {
    samples: samples.length,
    min: samples[0],
    median: samples[Math.floor(samples.length / 2)],
    p95,
    max: samples.at(-1),
  }
  await recordMeasurement(test.info(), 'latency (ms)', { ...numbers, all: samples })
  expect(samples).toHaveLength(SAMPLES)
  if (LOCAL) expect(p95).toBeLessThan(200)
})
