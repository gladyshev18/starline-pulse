const MOSCOW_OFFSET_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000

export function moscowDayRange(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  const calendarDate = new Date(Date.UTC(year!, month! - 1, day!))
  if (calendarDate.toISOString().slice(0, 10) !== value) return null

  const start = new Date(calendarDate.getTime() - MOSCOW_OFFSET_MS)
  return { day: value, start, end: new Date(start.getTime() + DAY_MS) }
}
