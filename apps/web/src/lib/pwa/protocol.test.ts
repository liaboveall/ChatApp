import { describe, expect, test } from 'vitest'
import { isFromWorker, isToWorker, SAFE_PATH } from './protocol.ts'

describe('what the page tells the worker', () => {
  test('who is signed in, with the installation', () => {
    expect(isToWorker({ type: 'identity', userId: 'u1', installationId: 'i1' })).toBe(true)
    expect(isToWorker({ type: 'identity', userId: '', installationId: 'i1' })).toBe(false)
    expect(isToWorker({ type: 'identity', userId: 'u1' })).toBe(false)
    expect(isToWorker({ type: 'identity', userId: 7, installationId: 'i1' })).toBe(false)
  })

  test('that nobody is, naming the account that left when the sender knew it', () => {
    expect(isToWorker({ type: 'signed-out' })).toBe(true)
    expect(isToWorker({ type: 'signed-out', userId: 'u1' })).toBe(true)
    expect(isToWorker({ type: 'signed-out', userId: 7 })).toBe(false)
  })

  test('nothing else', () => {
    for (const value of [null, undefined, 'signed-out', 3, [], {}, { type: 'open' }])
      expect(isToWorker(value)).toBe(false)
  })
})

describe('what the worker tells the page', () => {
  test('to open a place of the app, for an account', () => {
    expect(isFromWorker({ type: 'open', userId: 'u1', url: '/c/abc' })).toBe(true)
    expect(isFromWorker({ type: 'open', userId: 'u1', url: '/' })).toBe(true)
  })

  test('never an address that leaves the app, and never without an account', () => {
    for (const url of [
      'https://evil.example/',
      '//evil.example',
      '/c/a?x=1',
      '/c/../x',
      'javascript:alert(1)',
      '',
    ])
      expect(isFromWorker({ type: 'open', userId: 'u1', url })).toBe(false)
    expect(isFromWorker({ type: 'open', url: '/c/abc' })).toBe(false)
    expect(isFromWorker({ type: 'close', userId: 'u1', url: '/c/abc' })).toBe(false)
    expect(isFromWorker(null)).toBe(false)
  })

  test('a safe path is short and made of the characters ids and routes use', () => {
    expect(SAFE_PATH.test(`/c/${'a'.repeat(199)}`)).toBe(false)
    expect(SAFE_PATH.test('/c/01a11e64-8b93-74b8-b53b-1b0cb7abdfc9')).toBe(true)
  })
})
