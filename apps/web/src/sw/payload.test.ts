import { describe, expect, test } from 'vitest'
import { forgetApplies, isForAccount, parsePayload } from './payload.ts'

const good = {
  v: 1,
  userId: '01a11e64-8b93-74b8-b53b-1b0cb7abdfc9',
  kind: 'message',
  title: 'ChatApp',
  body: '你有新消息',
  url: '/c/01a11e64-8b93-74b8-b53b-1b0cb7abdfc9',
  tag: 'c-01a11e64-8b93-74b8-b53b-1b0cb7abdfc9',
  unread: 3,
}

describe('the payload of a push', () => {
  test('a well-formed one is read', () => {
    expect(parsePayload(JSON.stringify(good))).toEqual({
      userId: good.userId,
      kind: 'message',
      title: 'ChatApp',
      body: '你有新消息',
      url: good.url,
      tag: good.tag,
      unread: 3,
    })
  })

  test('anything else is refused: not JSON, wrong version, unknown kind, long text, an address that leaves the app', () => {
    for (const text of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, kind: 'ad' }),
      JSON.stringify({ ...good, title: 'x'.repeat(121) }),
      JSON.stringify({ ...good, body: 'x'.repeat(241) }),
      JSON.stringify({ ...good, url: 'https://evil.example/' }),
      JSON.stringify({ ...good, url: '//evil.example/x' }),
      JSON.stringify({ ...good, url: '/c/../../etc' }),
      JSON.stringify({ ...good, url: 'javascript:alert(1)' }),
      JSON.stringify({ ...good, url: '/c/a?x=1' }),
      JSON.stringify({ ...good, unread: -1 }),
      JSON.stringify({ ...good, unread: 1.5 }),
      JSON.stringify({ ...good, userId: 7 }),
    ]) {
      expect(parsePayload(text)).toBeNull()
    }
  })

  test('it is shown only to the account it was made for', () => {
    const payload = parsePayload(JSON.stringify(good))
    if (!payload) throw new Error('fixture')
    expect(isForAccount(payload, good.userId)).toBe(true)
    expect(isForAccount(payload, 'somebody-else')).toBe(false)
    expect(isForAccount(payload, undefined)).toBe(false)
  })
})

describe('a sign-out message reaching the worker', () => {
  test('applies to the account it names, and to whoever is known when it names nobody', () => {
    expect(forgetApplies('carol', 'carol')).toBe(true)
    expect(forgetApplies('carol', undefined)).toBe(true)
    expect(forgetApplies(undefined, 'carol')).toBe(true)
    expect(forgetApplies(undefined, undefined)).toBe(true)
  })

  test('does not apply once somebody else has signed in: a late message of the previous person is not about them', () => {
    expect(forgetApplies('bob', 'carol')).toBe(false)
  })
})
