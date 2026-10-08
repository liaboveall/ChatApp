/**
 * Reading a wall-clock time in an IANA zone (docs/01 section 4.3, docs/06 section 4.2, AT-37). A local time can name one
 * instant, two (the repeated hour when clocks go back) or none (the skipped hour when they go forward); this module never
 * guesses between two and never moves a skipped time, so the caller can ask the person.
 */

export type ZonedInstant = { instant: Date; offsetMinutes: number }
export type LocalTimeReading =
  | { kind: 'exact'; candidate: ZonedInstant }
  | { kind: 'ambiguous'; candidates: [ZonedInstant, ZonedInstant] }
  | { kind: 'nonexistent' }
  | { kind: 'invalid' }

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, found)
  }
  return found
}

function wallClock(instant: number, timeZone: string): { local: string; asUtc: number } {
  const parts = formatter(timeZone).formatToParts(new Date(instant))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? Number.NaN)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  )
  return { local: formatLocal(asUtc), asUtc }
}

function formatLocal(asUtc: number): string {
  return new Date(asUtc).toISOString().slice(0, 16)
}

/** Minutes the zone is ahead of UTC at this instant (east positive, so Asia/Shanghai is +480). */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const second = Math.floor(instant.getTime() / 1000) * 1000
  return Math.round((wallClock(second, timeZone).asUtc - second) / 60_000)
}

/** `YYYY-MM-DDTHH:mm` as the wall clock of `timeZone` shows it at `instant`. */
export function localDateTimeAt(instant: Date, timeZone: string): string {
  return wallClock(instant.getTime(), timeZone).local
}

/**
 * Every instant whose wall clock in `timeZone` reads `local` (minute precision). Offsets are sampled a day either side,
 * which covers every transition a single local time can be close to.
 */
export function readLocalTime(local: string, timeZone: string): LocalTimeReading {
  const match = LOCAL.exec(local)
  if (!match) return { kind: 'invalid' }
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number]
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  // Rejects 2026-02-30 and 24:00: the parsed fields must survive a round trip.
  if (formatLocal(asUtc) !== local) return { kind: 'invalid' }
  try {
    formatter(timeZone)
  } catch {
    return { kind: 'invalid' }
  }
  const offsets = new Set<number>()
  for (const shift of [-36, -24, -12, -6, 0, 6, 12, 24, 36])
    offsets.add(zoneOffsetMinutes(new Date(asUtc + shift * 3_600_000), timeZone))
  const found = new Map<number, ZonedInstant>()
  for (const offsetMinutes of offsets) {
    const instant = asUtc - offsetMinutes * 60_000
    if (wallClock(instant, timeZone).local === local)
      found.set(instant, { instant: new Date(instant), offsetMinutes })
  }
  const candidates = [...found.values()].sort((a, b) => a.instant.getTime() - b.instant.getTime())
  const [first, second] = candidates
  if (!first) return { kind: 'nonexistent' }
  if (!second) return { kind: 'exact', candidate: first }
  return { kind: 'ambiguous', candidates: [first, second] }
}

/** `+08:00` style label for an offset in minutes. */
export function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+'
  const total = Math.abs(offsetMinutes)
  return `${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
