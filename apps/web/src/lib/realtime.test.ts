import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { backoffDelay, RealtimeClient, serverNow, useRealtime } from './realtime.ts'

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 0
  sent: string[] = []
  closedBy: number | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(code?: number): void {
    this.closedBy = code
    this.readyState = 3
  }
  /** The server accepts and greets. */
  hello(serverTime = new Date(Date.now() + 5_000).toISOString(), heartbeatMs = 25_000): void {
    this.readyState = 1
    this.onmessage?.({
      data: JSON.stringify({
        v: 1,
        type: 'hello',
        data: {
          connectionId: '0198d0c0-0000-7000-8000-000000000001',
          userId: '0198d0c0-0000-7000-8000-000000000002',
          authEpoch: 0,
          restoreEpoch: 'r',
          serverTime,
          heartbeatMs,
        },
      }),
    })
  }
  reply(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  endWith(code: number): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const last = (): FakeSocket => {
  const socket = FakeSocket.instances.at(-1)
  if (!socket) throw new Error('no socket was opened')
  return socket
}

function makeClient(options: { hidden?: boolean; focusSupported?: boolean } = {}) {
  const onSessionLost = vi.fn()
  const client = new RealtimeClient({
    url: 'ws://test/ws',
    onSessionLost,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    random: () => 0.5, // jitter factor exactly 1.0
    isHidden: () => options.hidden ?? false,
    focusSupported: options.focusSupported,
  })
  return { client, onSessionLost }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  useRealtime.setState({
    status: 'idle',
    lastCloseCode: null,
    clockOffsetMs: 0,
    connectionId: null,
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('backoffDelay', () => {
  test('doubles from one second to a ceiling of thirty, with ±20% jitter', () => {
    const middle = () => 0.5
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelay(attempt, middle))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
    ])
    expect(backoffDelay(2, () => 0)).toBe(3200)
    expect(backoffDelay(2, () => 1)).toBe(4800)
  })
})

describe('connection lifecycle', () => {
  test('connects, takes the clock offset from hello and reports open', () => {
    const { client } = makeClient()
    client.start()
    expect(useRealtime.getState().status).toBe('connecting')
    last().hello(new Date(Date.now() + 5_000).toISOString())
    const state = useRealtime.getState()
    expect(state.status).toBe('open')
    expect(state.connectionId).toBe('0198d0c0-0000-7000-8000-000000000001')
    expect(Math.abs(state.clockOffsetMs - 5_000)).toBeLessThan(50)
    expect(Math.abs(serverNow() - (Date.now() + 5_000))).toBeLessThan(50)
  })

  test('start is idempotent: one socket, however often it is called', () => {
    const { client } = makeClient()
    client.start()
    client.start()
    expect(FakeSocket.instances).toHaveLength(1)
  })

  test('ignores binary frames, malformed JSON and unknown message types', () => {
    const { client } = makeClient()
    client.start()
    last().onmessage?.({ data: new ArrayBuffer(4) })
    last().onmessage?.({ data: '{not json' })
    last().reply({ v: 1, type: 'something.new', data: {} })
    expect(useRealtime.getState().status).toBe('connecting')
    last().hello()
    expect(useRealtime.getState().status).toBe('open')
  })

  test('stop closes the socket, cancels retries and stays down', () => {
    const { client } = makeClient()
    client.start()
    last().hello()
    client.stop()
    expect(last().closedBy).toBe(1000)
    expect(useRealtime.getState().status).toBe('idle')
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('close codes (docs/05 section 4.1)', () => {
  test('4401: no reconnect, the session is reported lost', () => {
    const { client, onSessionLost } = makeClient()
    client.start()
    last().hello()
    last().endWith(4401)
    expect(onSessionLost).toHaveBeenCalledTimes(1)
    expect(useRealtime.getState().status).toBe('stopped')
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  test('4403: no reconnect and no session-lost report', () => {
    const { client, onSessionLost } = makeClient()
    client.start()
    last().endWith(4403)
    expect(onSessionLost).not.toHaveBeenCalled()
    expect(useRealtime.getState().status).toBe('stopped')
    vi.advanceTimersByTime(120_000)
    expect(FakeSocket.instances).toHaveLength(1)
  })

  test('4408 reconnects at once', () => {
    const { client } = makeClient()
    client.start()
    last().hello()
    last().endWith(4408)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  test('4409 reconnects with back-off in the foreground and stays quiet in the background', () => {
    const foreground = makeClient()
    foreground.client.start()
    last().hello()
    last().endWith(4409)
    vi.advanceTimersByTime(1_000)
    expect(FakeSocket.instances).toHaveLength(2)

    FakeSocket.instances = []
    const background = makeClient({ hidden: true })
    background.client.start()
    last().hello()
    last().endWith(4409)
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(useRealtime.getState().status).toBe('idle')
  })

  test('1012, 1013, 4429 and a dropped network back off 1, 2, 4, 8 seconds', () => {
    const { client } = makeClient()
    client.start()
    const expected = [1000, 2000, 4000, 8000]
    for (const [index, wait] of expected.entries()) {
      last().endWith([1012, 1013, 4429, 1006][index] ?? 1006)
      expect(useRealtime.getState().status).toBe('reconnecting')
      vi.advanceTimersByTime(wait - 1)
      expect(FakeSocket.instances).toHaveLength(index + 1)
      vi.advanceTimersByTime(1)
      expect(FakeSocket.instances).toHaveLength(index + 2)
    }
  })

  test('a successful hello resets the back-off', () => {
    const { client } = makeClient()
    client.start()
    last().endWith(1006)
    vi.advanceTimersByTime(1_000)
    last().endWith(1006)
    vi.advanceTimersByTime(2_000)
    last().hello()
    last().endWith(1006)
    vi.advanceTimersByTime(999)
    expect(FakeSocket.instances).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(4)
  })
})

describe('heartbeat', () => {
  test('pings every heartbeatMs and a pong keeps the connection', () => {
    const { client } = makeClient()
    client.start()
    last().hello(undefined, 10_000)
    const pings = () =>
      last()
        .sent.map((frame) => JSON.parse(frame).type as string)
        .filter((type) => type === 'ping')
    vi.advanceTimersByTime(10_000)
    expect(pings()).toHaveLength(1)
    last().reply({ v: 1, type: 'pong', data: { serverTime: new Date().toISOString() } })
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(pings()).toHaveLength(2)
  })

  test('no pong within ten seconds: the connection is considered dead and replaced', () => {
    const { client } = makeClient()
    client.start()
    last().hello(undefined, 10_000)
    vi.advanceTimersByTime(10_000 + 10_000)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(2)
  })
})

describe('focus', () => {
  test('is tracked always, and sent unless it is turned off', () => {
    const quiet = makeClient({ focusSupported: false })
    quiet.client.start()
    last().hello()
    quiet.client.setFocus({ conversationId: 'c1', foreground: false })
    expect(quiet.client.focus).toEqual({ conversationId: 'c1', foreground: false })
    expect(last().sent).toEqual([])

    FakeSocket.instances = []
    const loud = makeClient()
    loud.client.start()
    last().hello()
    last().sent.length = 0
    loud.client.setFocus({ conversationId: 'c2' })
    expect(JSON.parse(last().sent[0] ?? '{}')).toMatchObject({
      type: 'focus',
      data: { conversationId: 'c2', foreground: true },
    })
  })

  test('the current focus is sent again after every hello, because the server forgets it with the connection', () => {
    const { client } = makeClient()
    client.start()
    last().hello()
    client.setFocus({ conversationId: 'c3', foreground: true })
    last().endWith(1006)
    vi.advanceTimersByTime(1000)
    last().hello()
    const frames = last().sent.map((text) => JSON.parse(text) as { type: string; data: unknown })
    expect(frames.at(-1)).toMatchObject({
      type: 'focus',
      data: { conversationId: 'c3', foreground: true },
    })
  })
})

describe('events and signals', () => {
  const typing = {
    v: 1,
    type: 'typing',
    topic: 'conv:0198d0c0-0000-7000-8000-0000000000aa',
    data: {
      conversationId: '0198d0c0-0000-7000-8000-0000000000aa',
      userId: '0198d0c0-0000-7000-8000-0000000000bb',
      state: 'start',
      expiresInMs: 5000,
    },
  }

  test('frames other than hello, pong and error go to onEvent; malformed ones and unknown types do not', () => {
    const onEvent = vi.fn()
    const client = new RealtimeClient({
      url: 'ws://test/ws',
      onSessionLost: vi.fn(),
      onEvent,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 0.5,
      isHidden: () => false,
    })
    client.start()
    last().hello()
    last().reply(typing)
    last().reply({ v: 1, type: 'something.new', data: {} })
    last().reply({ v: 1, type: 'typing', data: { conversationId: 'not-a-uuid' } })
    expect(onEvent).toHaveBeenCalledTimes(1)
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ type: 'typing' })
  })

  test('onHello fires for every hello, not for other frames', () => {
    const onHello = vi.fn()
    const client = new RealtimeClient({
      url: 'ws://test/ws',
      onSessionLost: vi.fn(),
      onHello,
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
      random: () => 0.5,
      isHidden: () => false,
    })
    client.start()
    last().hello()
    last().reply(typing)
    expect(onHello).toHaveBeenCalledTimes(1)
    last().endWith(1006)
    vi.advanceTimersByTime(1000)
    last().hello()
    expect(onHello).toHaveBeenCalledTimes(2)
  })

  test('send goes out only while the connection is open and is never queued', () => {
    const { client } = makeClient()
    expect(client.send({ v: 1, type: 'ping', data: {} })).toBe(false)
    client.start()
    expect(client.send({ v: 1, type: 'ping', data: {} })).toBe(false)
    last().hello()
    last().sent.length = 0
    expect(client.send({ v: 1, type: 'presence.activity', data: { state: 'idle' } })).toBe(true)
    expect(last().sent).toHaveLength(1)
    last().endWith(1006)
    expect(client.send({ v: 1, type: 'ping', data: {} })).toBe(false)
    vi.advanceTimersByTime(1000)
    last().hello()
    expect(last().sent.some((text) => text.includes('presence.activity'))).toBe(false)
  })
})
