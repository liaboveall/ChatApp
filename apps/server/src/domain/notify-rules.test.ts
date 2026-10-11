import { describe, expect, test } from 'bun:test'
import {
  decideNotification,
  isMuted,
  type NotifyEvent,
  type NotifyPreferences,
  pushSettingsOf,
} from './notify-rules.ts'

const base: NotifyPreferences = {
  pushEnabled: true,
  assistantEnabled: true,
  level: 'all',
  muted: false,
}

describe('the notification truth table (docs/01 section 4.8)', () => {
  const rows: Array<[NotifyEvent, Partial<NotifyPreferences>, { site: boolean; push: boolean }]> = [
    // an ordinary message: only "all" pushes it, and it never makes an in-site entry
    ['plain', { level: 'all' }, { site: false, push: true }],
    ['plain', { level: 'mentions' }, { site: false, push: false }],
    ['plain', { level: 'none' }, { site: false, push: false }],
    // a mention or a reply: "all" and "mentions" push, the centre keeps it always
    ['mention', { level: 'all' }, { site: true, push: true }],
    ['mention', { level: 'mentions' }, { site: true, push: true }],
    ['mention', { level: 'none' }, { site: true, push: false }],
    ['reply', { level: 'all' }, { site: true, push: true }],
    ['reply', { level: 'mentions' }, { site: true, push: true }],
    ['reply', { level: 'none' }, { site: true, push: false }],
    // the assistant: governed by its own switch, and by the level of the conversation it belongs to
    ['approval', { level: 'all' }, { site: true, push: true }],
    ['approval', { level: 'mentions' }, { site: true, push: true }],
    ['approval', { level: 'none' }, { site: true, push: false }],
    ['approval', { assistantEnabled: false }, { site: true, push: false }],
    ['reminder', { level: 'all' }, { site: true, push: true }],
    ['reminder', { level: 'mentions' }, { site: true, push: true }],
    ['reminder', { level: 'none' }, { site: true, push: false }],
    ['reminder', { assistantEnabled: false }, { site: true, push: false }],
  ]
  for (const [event, change, expected] of rows) {
    test(`${event} with ${JSON.stringify(change)}`, () => {
      expect(decideNotification(event, { ...base, ...change })).toEqual(expected)
    })
  }

  test('a mute silences every push but the centre still keeps what it keeps', () => {
    for (const event of ['plain', 'mention', 'reply', 'approval', 'reminder'] as const) {
      const decision = decideNotification(event, { ...base, muted: true })
      expect(decision.push).toBe(false)
      expect(decision.site).toBe(event !== 'plain')
    }
  })

  test('the account switch beats every row', () => {
    for (const event of ['plain', 'mention', 'reply', 'approval', 'reminder'] as const) {
      expect(decideNotification(event, { ...base, pushEnabled: false }).push).toBe(false)
    }
  })

  test('the assistant switch changes nothing for people', () => {
    expect(decideNotification('mention', { ...base, assistantEnabled: false }).push).toBe(true)
    expect(decideNotification('plain', { ...base, assistantEnabled: false }).push).toBe(true)
  })
})

describe('mutes', () => {
  const now = new Date('2026-10-09T12:00:00Z')
  test('forever, until a future time, lapsed and off', () => {
    expect(isMuted({ muteMode: 'forever', mutedUntil: null }, now)).toBe(true)
    expect(isMuted({ muteMode: 'until', mutedUntil: new Date('2026-10-09T13:00:00Z') }, now)).toBe(
      true,
    )
    expect(isMuted({ muteMode: 'until', mutedUntil: new Date('2026-10-09T11:59:59Z') }, now)).toBe(
      false,
    )
    expect(isMuted({ muteMode: 'until', mutedUntil: now }, now)).toBe(false)
    expect(isMuted({ muteMode: 'off', mutedUntil: null }, now)).toBe(false)
  })
})

describe('account push settings', () => {
  test('defaults: push on, assistant pushes on, no preview', () => {
    expect(pushSettingsOf({})).toEqual({
      pushEnabled: true,
      assistantEnabled: true,
      preview: false,
    })
  })
  test('only an explicit false turns a switch off and only an explicit true turns the preview on', () => {
    expect(pushSettingsOf({ pushEnabled: false, pushAssistant: false, pushPreview: true })).toEqual(
      {
        pushEnabled: false,
        assistantEnabled: false,
        preview: true,
      },
    )
    expect(pushSettingsOf({ pushEnabled: 'no', pushPreview: 'yes' })).toEqual({
      pushEnabled: true,
      assistantEnabled: true,
      preview: false,
    })
  })
})
