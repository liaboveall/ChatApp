import { expect, test } from 'bun:test'
import { benchmarkRoomPlan } from './benchmark.ts'

test('full load uses 200 rooms, 20/100-person groups and 500-person channels reachable by every account', () => {
  const rooms = benchmarkRoomPlan('full')
  expect(rooms).toHaveLength(200)
  expect(rooms[0]?.kind).toBe('channel')
  expect(rooms[0]?.members).toHaveLength(500)
  for (const room of rooms) {
    const size = { small: 20, medium: 100, large: 500 }[room.tier]
    expect(room.members).toHaveLength(size)
    expect(new Set(room.members).size).toBe(size)
    expect(room.kind).toBe(room.tier === 'large' ? 'channel' : 'group')
    expect(room.members.every((member) => member >= 0 && member < 1000)).toBe(true)
  }
  for (const tier of ['small', 'medium', 'large'] as const) {
    const reachable = new Set(
      rooms.filter((room) => room.tier === tier).flatMap((room) => room.members),
    )
    expect(reachable.size).toBe(1000)
  }
})
