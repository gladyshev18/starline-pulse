// Год целиком: чем этот год отличается от прошлого, к чему он придёт к
// декабрю и что за всё время оказалось рекордом.
//
// Помесячный график показывает форму, но не отвечает на два вопроса, которые
// задаёшь ему первыми: «мы едем больше, чем год назад?» и «во что этот год
// обойдётся, если так и пойдёт». Оба требуют не картинки, а арифметики.

import { currentMoscowMonth, moscowMonthRange, shiftMonth } from './moscow-month'

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
  // Сколько заправок было за месяц — вместе с теми, у которых чека нет. Месяц
  // без заправок и месяц, чеки от которого потерялись, приходят с одинаково
  // пустой суммой, а значат разное.
  refuels?: number
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

export interface YearPacePoint {
  month: string
  // Накоплено с начала наблюдений года к концу месяца. У месяцев, которые ещё
  // не наступили, факта нет и быть не может.
  distance: number | null
  spend: number | null
  // Та же величина по прогнозу — но по прогнозу, который об этом месяце ещё не
  // знал: средний день считается по данным до месяца, а не вместе с ним. Иначе
  // прогноз подгонялся бы под тот самый факт, с которым его сравнивают, и
  // расхождение всегда выходило бы нулевым. У первого месяца прогноза нет:
  // предсказывать его нечем.
  projectedDistance: number | null
  projectedSpend: number | null
  // Куда год обещал прийти к декабрю по данным на конец этого месяца. Тот же
  // перенос среднего дня, что и в projectYear, но сделанный тогда: без
  // сохранённого обещания сравнивать прогноз с действительностью нечем.
  forecast: number | null
}

export interface YearPaceMiss {
  // По скольким месяцам посчитан промах.
  months: number
  // На сколько прогноз ошибался в среднем — по модулю: промахи вверх и вниз
  // гасили бы друг друга и складывались в обманчивую точность.
  share: number
  // Промах последнего месяца отдельно: среднее по году полезно, но вопрос
  // «а сейчас-то как» задают чаще.
  last: number
}

export interface YearPace {
  year: string
  currentMonth: string
  points: YearPacePoint[]
  perDay: number
  daysGone: number
  daysTotal: number
  miss: YearPaceMiss | null
}

// Год одной картинкой: две линии от одного начала к декабрю — накопленный
// пробег и прогноз. Прогноз на каждый месяц посчитан по данным, которые были до
// этого месяца, поэтому линии и расходятся: расстояние между ними — это то, на
// сколько прогноз промахнулся, а не ноль по построению.
export function yearPace(months: YearMonth[], now = new Date()): YearPace | null {
  const currentMonth = currentMoscowMonth(now)
  const year = currentMonth.slice(0, 4)
  const lived = months
    .filter(month => month.month.startsWith(`${year}-`) && month.month <= currentMonth)
    .sort((left, right) => left.month.localeCompare(right.month))
  if (!lived.length) return null

  // Год начинается там же, где и в прогнозе: с первого месяца, о котором есть
  // данные. Иначе январь–июль пустых месяцев тянули бы средний день вниз.
  const from = moscowMonthRange(lived[0]!.month)!.start
  const december = `${year}-12`
  const yearEnd = moscowMonthRange(december)!.end
  const daysTotal = Math.max(1, (yearEnd.getTime() - from.getTime()) / DAY_MS)
  const daysTo = (at: Date) => Math.max(1, (Math.min(at.getTime(), now.getTime()) - from.getTime()) / DAY_MS)
  // Сколько дней года прожито к концу месяца. Текущий месяц обрезан сегодняшним
  // днём: сравнивать половину месяца факта с целым месяцем прогноза нечестно —
  // прогноз всегда выигрывал бы этот разрыв.
  const daysAt = (month: string) => {
    const end = moscowMonthRange(month)!.end
    return month <= currentMonth ? daysTo(end) : Math.max(1, (end.getTime() - from.getTime()) / DAY_MS)
  }

  const facts: Array<{ month: string, days: number, distance: number, spend: number | null, forecast: number }> = []
  let distance = 0
  // Рубли складываются, пока каждый месяц знает свою сумму. Месяц, в который
  // ни разу не заправлялись, стоил ноль и счёт не рвёт; месяц с заправками без
  // чека — рвёт, и дальше накопленной суммы просто нет.
  let spend: number | null = 0

  for (const month of lived) {
    distance += month.distance
    const cost = month.spend ?? (month.refuels === 0 ? 0 : null)
    spend = spend == null || cost == null ? null : spend + cost
    const days = daysAt(month.month)
    facts.push({ month: month.month, days, distance, spend, forecast: distance / days * daysTotal })
  }

  const daysGone = daysTo(now)
  const perDay = distance / daysGone
  const spendPerDay = spend == null ? null : spend / daysGone

  const points: YearPacePoint[] = facts.map((fact, index) => {
    // Прогноз пересчитывается каждый раз заново и по всем данным сразу — но по
    // тем, что были до этого месяца.
    const prior = facts[index - 1]
    return {
      month: fact.month,
      distance: fact.distance,
      spend: fact.spend,
      forecast: fact.forecast,
      projectedDistance: prior ? prior.distance / prior.days * fact.days : null,
      projectedSpend: prior?.spend == null ? null : prior.spend / prior.days * fact.days
    }
  })

  // Месяцам, которые ещё не наступили, «данные до месяца» — это всё, что есть
  // на сегодня. Поэтому дальше линия идёт сегодняшним средним днём и приходит
  // ровно в то число, что стоит на карточке года.
  for (let month = shiftMonth(currentMonth, 1); month <= december; month = shiftMonth(month, 1)) {
    const days = daysAt(month)
    points.push({
      month,
      distance: null,
      spend: null,
      projectedDistance: perDay * days,
      projectedSpend: spendPerDay == null ? null : spendPerDay * days,
      forecast: null
    })
  }

  // Промах считается только там, где есть обе величины: и предсказание, и то,
  // что вышло на самом деле.
  const missed = points.filter(point => point.distance && point.projectedDistance != null)
  const shares = missed.map(point => Math.abs(point.projectedDistance! - point.distance!) / point.distance!)
  const miss = shares.length
    ? { months: shares.length, share: shares.reduce((sum, value) => sum + value, 0) / shares.length, last: shares.at(-1)! }
    : null

  return { year, currentMonth, points, perDay, daysGone, daysTotal, miss }
}
