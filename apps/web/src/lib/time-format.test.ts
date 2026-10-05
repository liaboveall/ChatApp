import { describe, expect, test } from 'vitest'
import {
  dateTime,
  dayNumber,
  differentDay,
  exactTime,
  listTime,
  partsOf,
  relativeTime,
  separatorLabel,
  usableTimeZone,
} from './time-format.ts'

const words = { yesterday: 'Yesterday' }
const at = (iso: string) => Date.parse(iso)

describe('usableTimeZone', () => {
  test('accepts a real zone, and falls back to the browser for anything else', () => {
    expect(usableTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(usableTimeZone('Not/AZone')).toBeUndefined()
    expect(usableTimeZone('')).toBeUndefined()
    expect(usableTimeZone(undefined)).toBeUndefined()
  })
})

describe('calendar days in a zone', () => {
  test('the same instant is a different day in different zones', () => {
    // 2026-10-03 23:30 UTC is already the 4th in Shanghai (UTC+8) and still the 3rd in New York.
    const instant = '2026-10-03T23:30:00Z'
    expect(partsOf(instant, 'Asia/Shanghai')).toMatchObject({
      month: 10,
      day: 4,
      hour: 7,
      minute: 30,
    })
    expect(partsOf(instant, 'America/New_York')).toMatchObject({ month: 10, day: 3, hour: 19 })
    expect(dayNumber(instant, 'Asia/Shanghai') - dayNumber(instant, 'America/New_York')).toBe(1)
  })

  test('midnight splits two messages a minute apart; the same afternoon does not', () => {
    expect(differentDay('2026-10-03T15:59:00Z', '2026-10-03T16:01:00Z', 'Asia/Shanghai')).toBe(true)
    expect(differentDay('2026-10-03T05:00:00Z', '2026-10-03T09:00:00Z', 'Asia/Shanghai')).toBe(
      false,
    )
  })

  test('a day with a clock change is still one day', () => {
    // 2026-03-08 is the spring-forward day in New York: 23 hours long.
    expect(
      dayNumber('2026-03-09T12:00:00Z', 'America/New_York') -
        dayNumber('2026-03-08T12:00:00Z', 'America/New_York'),
    ).toBe(1)
    expect(differentDay('2026-03-08T05:30:00Z', '2026-03-09T03:30:00Z', 'America/New_York')).toBe(
      false,
    )
  })
})

describe('separatorLabel', () => {
  const now = at('2026-10-04T12:00:00Z')
  const zone = 'Asia/Shanghai'

  test('today shows only the time', () => {
    expect(separatorLabel('2026-10-04T06:05:00Z', now, 'en', words, zone)).toBe('02:05 PM')
    expect(separatorLabel('2026-10-04T06:05:00Z', now, 'zh-CN', words, zone)).toBe('14:05')
  })

  test('yesterday says so, this year gives month and day, earlier years add the year', () => {
    expect(separatorLabel('2026-10-03T06:05:00Z', now, 'en', words, zone)).toBe(
      'Yesterday 02:05 PM',
    )
    expect(separatorLabel('2026-05-03T06:05:00Z', now, 'en', words, zone)).toBe('May 3 02:05 PM')
    expect(separatorLabel('2025-05-03T06:05:00Z', now, 'en', words, zone)).toBe(
      'May 3, 2025 02:05 PM',
    )
  })

  test('is worded in the language asked for', () => {
    expect(separatorLabel('2026-05-03T06:05:00Z', now, 'zh-CN', words, zone)).toContain('5月3日')
  })

  test('uses the person’s day, not the server’s: 23:30 UTC the day before is already today in Shanghai', () => {
    expect(separatorLabel('2026-10-03T23:30:00Z', now, 'en', words, zone)).toBe('07:30 AM')
  })
})

describe('listTime', () => {
  const now = at('2026-10-04T12:00:00Z')
  const zone = 'Asia/Shanghai'

  test('today the time, yesterday the word, within the week the weekday, otherwise the date', () => {
    expect(listTime('2026-10-04T06:05:00Z', now, 'en', words, zone)).toBe('02:05 PM')
    expect(listTime('2026-10-04T06:05:00Z', now, 'zh-CN', words, zone)).toBe('14:05')
    expect(listTime('2026-10-03T06:05:00Z', now, 'en', words, zone)).toBe('Yesterday')
    expect(listTime('2026-10-01T06:05:00Z', now, 'en', words, zone)).toBe('Thu')
    expect(listTime('2026-09-20T06:05:00Z', now, 'en', words, zone)).toBe('9/20')
    expect(listTime('2025-09-20T06:05:00Z', now, 'en', words, zone)).toBe('9/20/25')
  })

  test('a time slightly in the future (clock skew) still reads as today', () => {
    expect(listTime('2026-10-04T12:00:30Z', now, 'zh-CN', words, zone)).toBe('20:00')
  })
})

describe('exactTime, dateTime and relativeTime', () => {
  test('exact time carries the seconds', () => {
    expect(exactTime('2026-10-04T06:05:09Z', 'en', 'Asia/Shanghai')).toContain('2:05:09')
  })

  test('dateTime is a date and a clock time', () => {
    expect(dateTime('2026-10-04T06:05:09Z', 'en', 'Asia/Shanghai')).toContain('Oct 4, 2026')
  })

  test('relative time scales from minutes to days', () => {
    const now = at('2026-10-04T12:00:00Z')
    expect(relativeTime(now - 30_000, now, 'en')).toBe('this minute')
    expect(relativeTime(now - 5 * 60_000, now, 'en')).toBe('5 minutes ago')
    expect(relativeTime(now - 3 * 3_600_000, now, 'en')).toBe('3 hours ago')
    expect(relativeTime('2026-10-02T12:00:00Z', now, 'en')).toBe('2 days ago')
  })
})

describe('what is remembered', () => {
  test('a day number is the same the second time, in its own zone, and for an instant given as a number', () => {
    const instant = '2026-10-04T16:30:00.000Z'
    const first = dayNumber(instant, 'Asia/Shanghai')
    expect(dayNumber(instant, 'Asia/Shanghai')).toBe(first)
    // 16:30 UTC is already the next day in Shanghai and still the same day in New York.
    expect(first).toBe(dayNumber('2026-10-05T01:00:00.000Z', 'Asia/Shanghai'))
    expect(dayNumber(instant, 'America/New_York')).toBe(first - 1)
    expect(dayNumber(Date.parse(instant), 'Asia/Shanghai')).toBe(first)
  })

  test('a zone name the runtime does not know is answered as "the browser\'s own" every time', () => {
    expect(usableTimeZone('Mars/Olympus_Mons')).toBeUndefined()
    expect(usableTimeZone('Mars/Olympus_Mons')).toBeUndefined()
    expect(usableTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(usableTimeZone('Asia/Shanghai')).toBe('Asia/Shanghai')
  })
})
