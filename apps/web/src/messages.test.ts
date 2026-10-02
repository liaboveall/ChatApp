import { describe, expect, test } from 'vitest'
import { m } from '@/paraglide/messages.js'

describe('messages', () => {
  test('Chinese is the base language and parameters are filled in', () => {
    expect(m.welcome_title({ name: 'Alice' })).toBe('欢迎回来，Alice')
    expect(m.verify_resend_wait({ seconds: 42 })).toBe('42 秒后可以重发')
  })

  test('English has singular and plural forms for counts; Chinese has one form', () => {
    expect(m.invites_days({ count: 1 }, { locale: 'en' })).toBe('1 day')
    expect(m.invites_days({ count: 7 }, { locale: 'en' })).toBe('7 days')
    expect(m.invites_quota_left({ count: 1 }, { locale: 'en' })).toBe('1 left')
    expect(m.invites_days({ count: 7 }, { locale: 'zh-CN' })).toBe('7 天')
  })

  test('the English text exists for what the Chinese text says', () => {
    expect(m.login_submit({}, { locale: 'en' })).toBe('Sign in')
    expect(m.settings_type_minus({ step: 1 }, { locale: 'en' })).toBe('−1')
  })
})
