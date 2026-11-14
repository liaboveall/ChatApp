/** One formatter per time zone: building one costs far more than using it, and a tool reads hundreds of rows at a time. */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timezone, formatter)
  }
  return formatter
}

/** Source timestamps are rendered by the server so models do not have to apply timezone offsets. */
export function agentSourceTime(time: Date, timezone: string): string {
  const parts = formatterFor(timezone).formatToParts(time)
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')} (${timezone})`
}
