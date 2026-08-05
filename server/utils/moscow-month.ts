const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

export function currentMoscowMonth(now = new Date()) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

export function moscowMonthRange(value: unknown, now = new Date()) {
  if (value != null && (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value))) return null
  const month = typeof value === 'string' ? value : currentMoscowMonth(now)
  const [year, monthNumber] = month.split('-').map(Number)

  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) return null

  const startUtc = Date.UTC(year, monthNumber - 1, 1) - MOSCOW_OFFSET_MS
  const endUtc = Date.UTC(year, monthNumber, 1) - MOSCOW_OFFSET_MS

  return {
    month,
    start: new Date(startUtc),
    end: new Date(endUtc),
    days: Math.round((endUtc - startUtc) / 86_400_000)
  }
}
