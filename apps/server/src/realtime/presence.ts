/**
 * Who is online (docs/03 section 5.6, docs/01 section 4.7, D-131). The state lives in Valkey, per connection, and is
 * summed per person: any active connection makes them `online`, connections that are all idle or in the background make
 * them `away`, none make them `offline`. Closing one of two tabs therefore changes nothing (L-18).
 *
 * Layout (all keys under one prefix that carries the environment):
 *   {prefix}:u:{userId}   HASH  c:{connection} = "active|idle" "|" expiryMs      one field per live connection
 *                               f:{connection} = conversationId "|" foreground   what the connection is looking at
 *                               s              = the last status that was announced
 *   {prefix}:x            ZSET  member "{userId}|{connection}", score expiryMs    for the sweeper
 *
 * Every change runs in one Lua script, so the sum and the "did it change" decision are atomic. A connection that dies
 * without closing (a crashed process) simply stops renewing; the sweeper removes it after its expiry and the person goes
 * offline then. Time is passed in by the caller so tests use the injected clock.
 */
import type { PresenceStatus } from '@chatapp/contracts'
import type { Valkey } from '../lib/valkey.ts'

/** A connection that has not been renewed (every 25 s by the heartbeat) for this long is dead. */
export const PRESENCE_TTL_MS = 90_000
/** The per-person hash outlives its connections a little, so a forgotten one cannot linger. */
const KEY_TTL_SECONDS = 180

export type PresenceChange = { previous: PresenceStatus; current: PresenceStatus }
export type PresenceConnection = { userId: string; connectionId: string }
export type Focus = { conversationId: string | null; foreground: boolean }

export interface PresenceStore {
  /** A new connection, active until it says otherwise. */
  connect(connection: PresenceConnection, now: number): Promise<PresenceChange>
  /** Heartbeat: keeps the connection alive without changing its state. */
  renew(connection: PresenceConnection, now: number): Promise<PresenceChange>
  setActivity(
    connection: PresenceConnection,
    state: 'active' | 'idle',
    now: number,
  ): Promise<PresenceChange>
  setFocus(connection: PresenceConnection, focus: Focus): Promise<void>
  disconnect(connection: PresenceConnection, now: number): Promise<PresenceChange>
  /** Current status of each person, summed from their live connections (no announcement state involved). */
  statuses(userIds: readonly string[], now: number): Promise<Map<string, PresenceStatus>>
  /** Removes connections that expired; returns the people whose status changed because of it. */
  sweep(now: number, limit?: number): Promise<Array<PresenceChange & { userId: string }>>
}

const COMMON = `
local function aggregate(key, now)
  local all = redis.call('HGETALL', key)
  local status = 'offline'
  for i = 1, #all, 2 do
    if string.sub(all[i], 1, 2) == 'c:' then
      local value = all[i + 1]
      local sep = string.find(value, '|', 1, true)
      local state = string.sub(value, 1, sep - 1)
      local expiry = tonumber(string.sub(value, sep + 1))
      if expiry > now then
        if state == 'active' then
          status = 'online'
        elseif status == 'offline' then
          status = 'away'
        end
      end
    end
  end
  return status
end
local function settle(key, now)
  local current = aggregate(key, now)
  local previous = redis.call('HGET', key, 's')
  if not previous then previous = 'offline' end
  if current == 'offline' then
    redis.call('HDEL', key, 's')
  else
    redis.call('HSET', key, 's', current)
  end
  return {previous, current}
end
`

const UPSERT = `${COMMON}
local now = tonumber(ARGV[1])
local field = 'c:' .. ARGV[2]
local state = ARGV[3]
if state == '' then
  local current = redis.call('HGET', KEYS[1], field)
  if current then
    state = string.sub(current, 1, string.find(current, '|', 1, true) - 1)
  else
    state = 'active'
  end
end
redis.call('HSET', KEYS[1], field, state .. '|' .. ARGV[4])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[5])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
return settle(KEYS[1], now)
`

const REMOVE = `${COMMON}
redis.call('HDEL', KEYS[1], 'c:' .. ARGV[2], 'f:' .. ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
return settle(KEYS[1], tonumber(ARGV[1]))
`

/** Like REMOVE, but only when the connection really is past its expiry (it may have been renewed since it was listed). */
const REMOVE_IF_EXPIRED = `${COMMON}
local value = redis.call('HGET', KEYS[1], 'c:' .. ARGV[2])
if value then
  local expiry = tonumber(string.sub(value, string.find(value, '|', 1, true) + 1))
  if expiry > tonumber(ARGV[1]) then
    return {'keep', 'keep'}
  end
end
redis.call('HDEL', KEYS[1], 'c:' .. ARGV[2], 'f:' .. ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
return settle(KEYS[1], tonumber(ARGV[1]))
`

function parseChange(reply: unknown): PresenceChange {
  const [previous, current] = reply as [PresenceStatus, PresenceStatus]
  return { previous, current }
}

/** The same sum the scripts make, for reading many people at once without touching their announcement state. */
function sumConnections(fields: Record<string, string>, now: number): PresenceStatus {
  let status: PresenceStatus = 'offline'
  for (const [field, value] of Object.entries(fields)) {
    if (!field.startsWith('c:')) continue
    const [state, expiry] = value.split('|')
    if (Number(expiry) <= now) continue
    if (state === 'active') return 'online'
    status = 'away'
  }
  return status
}

export function createPresenceStore(valkey: Valkey, prefix: string): PresenceStore {
  const userKey = (userId: string) => `${prefix}:u:${userId}`
  const expiryKey = `${prefix}:x`
  const member = (c: PresenceConnection) => `${c.userId}|${c.connectionId}`

  const upsert = async (
    c: PresenceConnection,
    state: string,
    now: number,
  ): Promise<PresenceChange> =>
    parseChange(
      await valkey.eval(
        UPSERT,
        2,
        userKey(c.userId),
        expiryKey,
        String(now),
        c.connectionId,
        state,
        String(now + PRESENCE_TTL_MS),
        member(c),
        String(KEY_TTL_SECONDS),
      ),
    )

  return {
    connect: (c, now) => upsert(c, 'active', now),
    renew: (c, now) => upsert(c, '', now),
    setActivity: (c, state, now) => upsert(c, state, now),
    async setFocus(c, focus) {
      const key = userKey(c.userId)
      if (focus.conversationId === null) {
        await valkey.hdel(key, `f:${c.connectionId}`)
      } else {
        await valkey.hset(
          key,
          `f:${c.connectionId}`,
          `${focus.conversationId}|${focus.foreground ? 1 : 0}`,
        )
        await valkey.expire(key, KEY_TTL_SECONDS)
      }
    },
    async disconnect(c, now) {
      return parseChange(
        await valkey.eval(
          REMOVE,
          2,
          userKey(c.userId),
          expiryKey,
          String(now),
          c.connectionId,
          member(c),
        ),
      )
    },
    async statuses(userIds, now) {
      const pipeline = valkey.pipeline()
      for (const id of userIds) pipeline.hgetall(userKey(id))
      const replies = (await pipeline.exec()) ?? []
      const result = new Map<string, PresenceStatus>()
      userIds.forEach((id, index) => {
        const fields = (replies[index]?.[1] ?? {}) as Record<string, string>
        result.set(id, sumConnections(fields, now))
      })
      return result
    },
    async sweep(now, limit = 200) {
      const expired = await valkey.zrangebyscore(expiryKey, '-inf', now, 'LIMIT', 0, limit)
      const changes: Array<PresenceChange & { userId: string }> = []
      for (const entry of expired) {
        const [userId, connectionId] = entry.split('|')
        if (!userId || !connectionId) {
          await valkey.zrem(expiryKey, entry)
          continue
        }
        const reply = (await valkey.eval(
          REMOVE_IF_EXPIRED,
          2,
          userKey(userId),
          expiryKey,
          String(now),
          connectionId,
          entry,
        )) as [string, string]
        if (reply[0] === 'keep') continue
        const change = parseChange(reply)
        if (change.previous !== change.current) changes.push({ userId, ...change })
      }
      return changes
    },
  }
}
