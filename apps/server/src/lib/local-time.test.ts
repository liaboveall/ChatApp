import { describe, expect, test } from 'bun:test'
import { localDateTimeAt, offsetLabel, readLocalTime, zoneOffsetMinutes } from './local-time.ts'

describe('reading a local time in a zone (AT-37)', () => {
  test('an ordinary time in a zone without daylight saving names exactly one instant', () => {
    const reading = readLocalTime('2026-10-09T09:30', 'Asia/Shanghai')
    expect(reading).toEqual({
      kind: 'exact',
      candidate: { instant: new Date('2026-10-09T01:30:00Z'), offsetMinutes: 480 },
    })
  })

  test('the hour skipped when clocks go forward does not exist and is never moved silently', () => {
    expect(readLocalTime('2026-03-08T02:30', 'America/New_York')).toEqual({ kind: 'nonexistent' })
    expect(readLocalTime('2026-03-29T01:15', 'Europe/London')).toEqual({ kind: 'nonexistent' })
  })

  test('the hour repeated when clocks go back has two instants, earlier first, and neither is chosen', () => {
    const reading = readLocalTime('2026-11-01T01:30', 'America/New_York')
    expect(reading).toEqual({
      kind: 'ambiguous',
      candidates: [
        { instant: new Date('2026-11-01T05:30:00Z'), offsetMinutes: -240 },
        { instant: new Date('2026-11-01T06:30:00Z'), offsetMinutes: -300 },
      ],
    })
    const london = readLocalTime('2026-10-25T01:00', 'Europe/London')
    expect(london.kind).toBe('ambiguous')
  })

  test('the minutes just outside a transition are exact again', () => {
    expect(readLocalTime('2026-11-01T00:59', 'America/New_York').kind).toBe('exact')
    expect(readLocalTime('2026-11-01T02:00', 'America/New_York').kind).toBe('exact')
    expect(readLocalTime('2026-03-08T03:00', 'America/New_York').kind).toBe('exact')
    expect(readLocalTime('2026-03-08T01:59', 'America/New_York').kind).toBe('exact')
  })

  test('half-hour shifts and far offsets are read the same way', () => {
    // Lord Howe moves by thirty minutes; Kiritimati is fourteen hours ahead and crosses the date line.
    expect(readLocalTime('2026-04-05T01:45', 'Australia/Lord_Howe').kind).toBe('ambiguous')
    expect(readLocalTime('2026-01-01T00:00', 'Pacific/Kiritimati')).toEqual({
      kind: 'exact',
      candidate: { instant: new Date('2025-12-31T10:00:00Z'), offsetMinutes: 840 },
    })
  })

  test('malformed times, impossible dates and unknown zones are invalid, not guessed', () => {
    for (const local of [
      '2026-02-30T10:00',
      '2026-10-09T24:00',
      '2026-10-09 10:00',
      '2026-10-09T10:00:00',
    ])
      expect(readLocalTime(local, 'Asia/Shanghai')).toEqual({ kind: 'invalid' })
    expect(readLocalTime('2026-10-09T10:00', 'Mars/Olympus_Mons')).toEqual({ kind: 'invalid' })
  })

  test('helpers render the wall clock and the offset of an instant', () => {
    const instant = new Date('2026-11-01T06:30:00Z')
    expect(localDateTimeAt(instant, 'America/New_York')).toBe('2026-11-01T01:30')
    expect(zoneOffsetMinutes(instant, 'America/New_York')).toBe(-300)
    expect(offsetLabel(-300)).toBe('-05:00')
    expect(offsetLabel(480)).toBe('+08:00')
    expect(offsetLabel(345)).toBe('+05:45')
  })
})
