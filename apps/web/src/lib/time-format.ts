/**
 * Times as the person reads them: always in their effective time zone (the one in their account, which already follows
 * the browser when "follow the browser" is on, D-118) and their language. The date arithmetic works on calendar days in
 * that zone, never on 24-hour steps, so a day with a clock change is still one day.
 */

const usable = new Map<string, string | undefined>()

/**
 * A zone name the runtime accepts, or undefined (the browser's own zone) for anything it does not. Asking the runtime builds a
 * formatter, which is slow, and a timeline asks for every message: the answer is remembered.
 */
export function usableTimeZone(timeZone: string | undefined): string | undefined {
  if (timeZone === undefined || timeZone === '') return undefined
  if (usable.has(timeZone)) return usable.get(timeZone)
  let answer: string | undefined
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0)
    answer = timeZone
  } catch {
    answer = undefined
  }
  usable.set(timeZone, answer)
  return answer
}

type Parts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  let formatter = formatters.get(key)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(key, formatter)
  }
  return formatter
}

/** The calendar fields of an instant in a zone. */
export function partsOf(instant: number | string | Date, timeZone?: string): Parts {
  const out: Record<string, number> = {}
  for (const part of partsFormatter(usableTimeZone(timeZone)).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value)
  }
  return {
    year: out.year ?? 1970,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  }
}

/** Day numbers already worked out, by zone and instant: a window of two thousand messages needs them on every change. */
const days = new Map<string, number>()
const DAYS_KEPT = 20_000

/** The number of the calendar day (days since 1970-01-01 as that zone counts them). */
export function dayNumber(instant: number | string | Date, timeZone?: string): number {
  const key = typeof instant === 'string' ? `${timeZone ?? ''}|${instant}` : undefined
  if (key !== undefined) {
    const known = days.get(key)
    if (known !== undefined) return known
  }
  const { year, month, day } = partsOf(instant, timeZone)
  const number = Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
  if (key !== undefined) {
    if (days.size >= DAYS_KEPT) days.clear()
    days.set(key, number)
  }
  return number
}

/** Whether two instants fall on different calendar days in the zone. */
export const differentDay = (
  a: number | string | Date,
  b: number | string | Date,
  timeZone?: string,
): boolean => dayNumber(a, timeZone) !== dayNumber(b, timeZone)

function clock(instant: number | string | Date, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: usableTimeZone(timeZone),
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(instant))
}

export type DayWords = { yesterday: string }

/**
 * The label of a time separator in the timeline: today shows the time, yesterday "Yesterday 14:05", this year "Oct 3,
 * 14:05", earlier years the year as well.
 */
export function separatorLabel(
  instant: string,
  now: number,
  locale: string,
  words: DayWords,
  timeZone?: string,
): string {
  const zone = usableTimeZone(timeZone)
  const days = dayNumber(now, zone) - dayNumber(instant, zone)
  const time = clock(instant, locale, zone)
  if (days === 0) return time
  if (days === 1) return `${words.yesterday} ${time}`
  const sameYear = partsOf(instant, zone).year === partsOf(now, zone).year
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  }).format(new Date(instant))
  return `${date} ${time}`
}

/** The time shown in a sidebar row: the time today, "Yesterday", the weekday this week, otherwise month/day. */
export function listTime(
  instant: string,
  now: number,
  locale: string,
  words: DayWords,
  timeZone?: string,
): string {
  const zone = usableTimeZone(timeZone)
  const days = dayNumber(now, zone) - dayNumber(instant, zone)
  if (days <= 0) return clock(instant, locale, zone)
  if (days === 1) return words.yesterday
  if (days < 7) {
    return new Intl.DateTimeFormat(locale, { timeZone: zone, weekday: 'short' }).format(
      new Date(instant),
    )
  }
  const sameYear = partsOf(instant, zone).year === partsOf(now, zone).year
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    month: 'numeric',
    day: 'numeric',
    year: sameYear ? undefined : '2-digit',
  }).format(new Date(instant))
}

/** The exact time shown beside a bubble on hover: date, hours, minutes and seconds. */
export function exactTime(instant: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: usableTimeZone(timeZone),
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(instant))
}

/** A date and time for sentences ("joined at …"): short date and the clock time. */
export function dateTime(instant: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: usableTimeZone(timeZone),
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(instant))
}

/** "3 minutes ago", "yesterday": for last-seen times. `now` and `instant` are milliseconds or ISO strings. */
export function relativeTime(instant: string | number, now: number, locale: string): string {
  const diff = (typeof instant === 'number' ? instant : Date.parse(instant)) - now
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round(diff / 60_000)
  if (Math.abs(minutes) < 1) return formatter.format(0, 'minute')
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  return formatter.format(Math.round(hours / 24), 'day')
}
