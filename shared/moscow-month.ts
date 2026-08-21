const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

export interface MoscowMonthRange {
  month: string
  start: Date
  end: Date
  days: number
}

export function currentMoscowMonth(now = new Date()) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

export function moscowMonthRange(value: unknown, now = new Date()): MoscowMonthRange | null {
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

export function shiftMonth(month: string, amount: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + amount, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

// The date is built at UTC midnight, so the formatter has to read it in UTC too:
// anywhere west of Greenwich the first of the month would otherwise be shown as
// the last day of the one before it.
export function monthTitle(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const title = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year!, monthNumber! - 1, 1)))
  return title[0]!.toUpperCase() + title.slice(1)
}

// Ordered so that a three-letter stem is enough: «мар» is tried before the «ма»
// that has to cover both «май» and «мая».
const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

function monthOf(year: number, monthNumber: number) {
  if (monthNumber < 1 || monthNumber > 12 || year < 2000 || year > 2100) return null
  return `${year}-${String(monthNumber).padStart(2, '0')}`
}

// A month named without a year means the nearest one already behind us: asking in
// August for «декабрь» is asking about last December, not about a month that has
// not happened yet.
function nearestPast(monthNumber: number, now: Date) {
  const current = currentMoscowMonth(now)
  const year = Number(current.split('-')[0])
  const candidate = monthOf(year, monthNumber)
  if (!candidate) return null
  return candidate <= current ? candidate : monthOf(year - 1, monthNumber)
}

// What a person types into a chat: «2026-07», «07.2026», «7», «июль»,
// «июль 2025», «прошлый», «текущий».
export function parseMonthInput(value: string, now = new Date()): string | null {
  const input = value.trim().toLowerCase().replaceAll('ё', 'е')
  if (!input) return currentMoscowMonth(now)
  if (/^(этот|текущ|сейчас|сегодня)/.test(input)) return currentMoscowMonth(now)
  if (/^прошл/.test(input)) return shiftMonth(currentMoscowMonth(now), -1)

  const isoLike = input.match(/^(\d{4})[-. /](\d{1,2})$/)
  if (isoLike) return monthOf(Number(isoLike[1]), Number(isoLike[2]))

  const reversed = input.match(/^(\d{1,2})[-. /](\d{4})$/)
  if (reversed) return monthOf(Number(reversed[2]), Number(reversed[1]))

  const bare = input.match(/^(\d{1,2})$/)
  if (bare) return nearestPast(Number(bare[1]), now)

  const named = input.match(/^([а-я]{3,})(?:\s+(\d{4}))?$/)
  if (!named) return null
  const index = MONTH_STEMS.findIndex(stem => named[1]!.startsWith(stem))
  if (index < 0) return null
  return named[2] ? monthOf(Number(named[2]), index + 1) : nearestPast(index + 1, now)
}
