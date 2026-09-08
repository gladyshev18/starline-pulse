// Год целиком: чем этот год отличается от прошлого, к чему он придёт к
// декабрю и что за всё время оказалось рекордом.
//
// Помесячный график показывает форму, но не отвечает на два вопроса, которые
// задаёшь ему первыми: «мы едем больше, чем год назад?» и «во что этот год
// обойдётся, если так и пойдёт». Оба требуют не картинки, а арифметики.

import { currentMoscowMonth, moscowMonthRange } from './moscow-month'

const DAY_MS = 24 * 60 * 60_000

export interface YearMonth {
  month: string
  distance: number
  trips: number
  fuelUsed: number
  consumption: number | null
  spend: number | null
  costPerKm: number | null
  pricePerLitre: number | null
}

export interface YearTotals {
  year: string
  months: number
  distance: number
  trips: number
  fuelUsed: number
  spend: number | null
  // Месяцы, у которых сумма по чекам вообще есть: год, где половина заправок
  // без чека, нельзя сравнивать с полным по деньгам.
  spentMonths: number
}

export interface YearProjection {
  year: string
  daysGone: number
  daysTotal: number
  distance: number
  spend: number | null
  // Куда год придёт к декабрю, если ездить так же, как ездили.
  projectedDistance: number
  projectedSpend: number | null
  perDay: number
}

export interface YearComparison {
  current: YearTotals
  previous: YearTotals
  // Сравниваются только те месяцы прошлого года, что уже прожиты в этом:
  // одиннадцать месяцев против двенадцати выглядели бы падением на ровном месте.
  months: number
  previousDistance: number
  distanceShare: number | null
}

function totalsFor(months: YearMonth[], year: string, only?: Set<string>): YearTotals {
  const rows = months.filter(month => month.month.startsWith(`${year}-`) && (!only || only.has(month.month.slice(5))))
  const spent = rows.filter(month => month.spend != null)
  return {
    year,
    months: rows.length,
    distance: rows.reduce((sum, month) => sum + month.distance, 0),
    trips: rows.reduce((sum, month) => sum + month.trips, 0),
    fuelUsed: rows.reduce((sum, month) => sum + month.fuelUsed, 0),
    spend: spent.length ? spent.reduce((sum, month) => sum + month.spend!, 0) : null,
    spentMonths: spent.length
  }
}

// Год к году по одним и тем же месяцам. Пока прошлого года в данных нет, ответ
// честно пустой: сравнивать август с июлем — это не «год к году».
export function compareYears(months: YearMonth[], now = new Date()): YearComparison | null {
  const year = currentMoscowMonth(now).slice(0, 4)
  const previousYear = String(Number(year) - 1)
  const lived = new Set(months.filter(month => month.month.startsWith(`${year}-`)).map(month => month.month.slice(5)))
  if (!lived.size) return null

  const previous = totalsFor(months, previousYear, lived)
  if (!previous.months) return null

  const current = totalsFor(months, year, lived)
  return {
    current,
    previous,
    months: previous.months,
    previousDistance: previous.distance,
    distanceShare: previous.distance > 0 ? current.distance / previous.distance - 1 : null
  }
}

// Прогноз до конца года — простой перенос среднего дня на оставшиеся дни. Ничего
// умнее данные не поддерживают: сезонность в них есть, но чтобы её учесть, нужен
// хотя бы один прожитый год.
export function projectYear(months: YearMonth[], now = new Date()): YearProjection | null {
  const currentMonth = currentMoscowMonth(now)
  const year = currentMonth.slice(0, 4)
  const totals = totalsFor(months, year)
  if (!totals.months) return null

  // Год считается от первого месяца, о котором есть данные, а не от января:
  // машина, за которой следят с августа, иначе получила бы «прогноз» из
  // семи пустых месяцев.
  const first = months.find(month => month.month.startsWith(`${year}-`))!.month
  const from = moscowMonthRange(first)!.start
  const yearEnd = moscowMonthRange(`${year}-12`)!.end
  const daysGone = Math.max(1, (now.getTime() - from.getTime()) / DAY_MS)
  const daysTotal = Math.max(daysGone, (yearEnd.getTime() - from.getTime()) / DAY_MS)
  const perDay = totals.distance / daysGone

  return {
    year,
    daysGone,
    daysTotal,
    distance: totals.distance,
    spend: totals.spend,
    projectedDistance: perDay * daysTotal,
    projectedSpend: totals.spend == null ? null : totals.spend / daysGone * daysTotal,
    perDay
  }
}

export interface MonthRecord {
  month: string
  value: number
}

export interface MonthRecords {
  // Самый ездовой месяц и самый спокойный — по километрам.
  busiest: MonthRecord | null
  quietest: MonthRecord | null
  // Самый экономичный и самый прожорливый — по расходу на сотню.
  thriftiest: MonthRecord | null
  thirstiest: MonthRecord | null
  // Самый дорогой километр — по топливной части.
  dearestKm: MonthRecord | null
  cheapestKm: MonthRecord | null
}

// Месяц, который ещё идёт, в рекорды не берётся: он всегда самый спокойный
// просто потому, что не кончился.
function completed(months: YearMonth[], now: Date) {
  const currentMonth = currentMoscowMonth(now)
  return months.filter(month => month.month < currentMonth && month.distance > 0)
}

function pick(months: YearMonth[], value: (month: YearMonth) => number | null, best: (a: number, b: number) => boolean) {
  let found: MonthRecord | null = null
  for (const month of months) {
    const current = value(month)
    if (current == null || !Number.isFinite(current)) continue
    if (!found || best(current, found.value)) found = { month: month.month, value: current }
  }
  return found
}

export function monthRecords(months: YearMonth[], now = new Date()): MonthRecords {
  const rows = completed(months, now)
  // На одном прожитом месяце рекордов не бывает: он же и лучший, и худший.
  if (rows.length < 2) {
    return { busiest: null, quietest: null, thriftiest: null, thirstiest: null, dearestKm: null, cheapestKm: null }
  }
  const more = (a: number, b: number) => a > b
  const less = (a: number, b: number) => a < b
  return {
    busiest: pick(rows, month => month.distance, more),
    quietest: pick(rows, month => month.distance, less),
    thriftiest: pick(rows, month => month.consumption, less),
    thirstiest: pick(rows, month => month.consumption, more),
    dearestKm: pick(rows, month => month.costPerKm, more),
    cheapestKm: pick(rows, month => month.costPerKm, less)
  }
}
