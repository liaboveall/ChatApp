import { expect, test } from 'bun:test'
import { agentSourceTime } from './agent-source-time.ts'

test('source local time is converted once while the original UTC instant stays unchanged', () => {
  const time = new Date('2026-06-23T01:32:00.000Z')
  expect(agentSourceTime(time, 'Asia/Singapore')).toBe('2026-06-23 09:32:00 (Asia/Singapore)')
  expect(agentSourceTime(time, 'UTC')).toBe('2026-06-23 01:32:00 (UTC)')
  expect(time.toISOString()).toBe('2026-06-23T01:32:00.000Z')
})

test('source timezone conversion handles a local year boundary without interpreting the event date in the body', () => {
  expect(agentSourceTime(new Date('2026-12-31T12:30:00.000Z'), 'Pacific/Kiritimati')).toBe(
    '2027-01-01 02:30:00 (Pacific/Kiritimati)',
  )
})
