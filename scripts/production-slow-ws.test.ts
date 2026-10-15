import { expect, test } from 'bun:test'
import { clientFrame, serverFrame } from './production-slow-ws.ts'

test('partial, masked, fragmented and oversized server frames cannot bypass bounded reads', () => {
  expect(serverFrame(Buffer.from([0x81]))).toBeNull()
  expect(serverFrame(Buffer.from([0x81, 4, 1, 2]))).toBeNull()
  expect(serverFrame(Buffer.from([0x81, 2, 123, 125]))).toMatchObject({
    opcode: 1,
    consumed: 4,
    payload: Buffer.from('{}'),
  })
  for (const bytes of [
    [0x81, 0x80],
    [1, 0],
    [0xc1, 0],
    [0x89, 126, 0, 126],
    [0x81, 126, 0, 1],
  ])
    expect(() => serverFrame(Buffer.from(bytes))).toThrow()
  const oversized = Buffer.alloc(10)
  oversized[0] = 0x81
  oversized[1] = 127
  oversized.writeBigUInt64BE(65537n, 2)
  expect(() => serverFrame(oversized)).toThrow()
})
test('client pings and control replies always use masking and a bounded payload', () => {
  const payload = Buffer.from('hello'),
    frame = clientFrame(1, payload)
  expect(frame[1]).toBe(0x80 | payload.length)
  const decoded = Buffer.from(
    Array.from(payload, (_, i) => (frame[i + 6] ?? 0) ^ (frame[2 + (i % 4)] ?? 0)),
  )
  expect(decoded).toEqual(payload)
  expect(() => clientFrame(1, new Uint8Array(126))).toThrow()
  expect(() => clientFrame(2, payload)).toThrow()
})
