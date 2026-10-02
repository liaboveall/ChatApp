import { describe, expect, test } from 'vitest'
import { safeRedirect } from './redirect.ts'

describe('safeRedirect', () => {
  test('keeps paths inside this site, with their query and fragment', () => {
    expect(safeRedirect('/')).toBe('/')
    expect(safeRedirect('/?settings=invites')).toBe('/?settings=invites')
    expect(safeRedirect('/settings/account#top')).toBe('/settings/account#top')
  })

  test('drops everything that could leave it', () => {
    for (const value of [
      undefined,
      '',
      'https://evil.example/',
      '//evil.example/x',
      '/\\evil.example',
      'javascript:alert(1)',
      'evil',
      '/ spaced',
      '/\nnewline',
    ]) {
      expect(safeRedirect(value), String(value)).toBeUndefined()
    }
  })
})
