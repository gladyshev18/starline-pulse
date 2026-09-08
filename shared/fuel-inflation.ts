import { currentMoscowMonth, shiftMonth } from './moscow-month'
import { linearFit, predict, type Fit } from './regression'

// Своя инфляция бензина: не та, что объявляют, а та, что видно по собственным
// чекам. Вопрос, на который она отвечает, ровно один — на сколько процентов в
// месяц дорожает литр именно там, где эта машина заправляется.
//
// Считается по логарифму цены, а не по самой цене: дорожание идёт процентами от
// текущей цены, и прямая в логарифме — это как раз постоянный процент. Заодно
// пропадает соблазн сложить рубли за прошлый год с рублями за этот.
//
// Топливо не смешивается. АИ-92 и АИ-95 отличаются на несколько рублей всегда,
// и общий ряд показывал бы не подорожание, а то, чем заправились в этот раз.

const DAY_MS = 24 * 60 * 60_000
const MONTH_DAYS = 30.437

export interface InflationFill {
  at: Date
  fuelType: string | null
  litres: number | null
  pricePerLitre: number | null
  operation: 'purchase' | 'refund'
}

export interface InflationMonth {
  month: string
  // Средняя цена месяца, взвешенная литрами.
  price: number
  litres: number
  fills: number
}

export interface YearOverYear {
  month: string
  price: number
  previousMonth: string
  previousPrice: number
  change: number
  share: number
}

export interface FuelInflation {
  fuelType: string
  fills: number
  months: InflationMonth[]
  first: InflationMonth
  last: InflationMonth
  // Прямая по логарифму цены: наклон — доля в день.
  fit: Fit | null
  // Темп, который можно произнести: процентов в месяц и во что это выливается
  // за год, если так и пойдёт дальше.
  monthlyRate: number | null
  yearlyRate: number | null
  // Тот же месяц год назад — единственное честное сравнение, в котором нет
  // сезонности. Появится, когда наберётся год наблюдений.
  yearOverYear: YearOverYear | null
  // Цена через полгода и год, если темп сохранится. Только по значимому темпу:
  // прямая, проведённая сквозь шум, обещала бы будущее, которого в данных нет.
  forecast: Array<{ month: string, price: number }>
  days: number
}

export interface FuelInflationSummary {
  byFuelType: FuelInflation[]
  // Топливо, которого куплено больше всех: о нём и говорит страница, когда
  // места на все ряды нет.
  main: FuelInflation | null
}

function monthlyPrices(fills: Array<{ at: Date, litres: number, price: number }>): InflationMonth[] {
  const months = new Map<string, { litres: number, amount: number, fills: number }>()
  for (const fill of fills) {
    const month = currentMoscowMonth(fill.at)
    const bucket = months.get(month) ?? { litres: 0, amount: 0, fills: 0 }
    bucket.litres += fill.litres
    bucket.amount += fill.litres * fill.price
    bucket.fills++
    months.set(month, bucket)
  }
  return [...months.entries()]
    .map(([month, value]) => ({
      month,
      price: value.litres > 0 ? value.amount / value.litres : 0,
      litres: value.litres,
      fills: value.fills
    }))
    .filter(item => item.price > 0)
    .sort((left, right) => left.month.localeCompare(right.month))
}

export function summariseInflation(fills: InflationFill[]): FuelInflationSummary {
  const byType = new Map<string, Array<{ at: Date, litres: number, price: number }>>()
  for (const fill of fills) {
    if (fill.operation === 'refund') continue
    const fuelType = fill.fuelType?.trim()
    if (!fuelType || fill.pricePerLitre == null || !(fill.pricePerLitre > 0)) continue
    const at = new Date(fill.at)
    if (!Number.isFinite(at.getTime())) continue
    // Литры нужны только как вес средней цены месяца; чек без объёма всё равно
    // знает, почём был литр, и в ряд попадает с весом одной заправки.
    byType.set(fuelType, [...(byType.get(fuelType) ?? []), { at, litres: fill.litres ?? 1, price: fill.pricePerLitre }])
  }

  const byFuelType = [...byType.entries()].map(([fuelType, rows]): FuelInflation => {
    const sorted = [...rows].sort((left, right) => left.at.getTime() - right.at.getTime())
    const months = monthlyPrices(sorted)
    const from = sorted[0]!.at.getTime()
    // Точки — сами чеки, а не месячные средние: месяцев за первый год всего
    // десяток, и темп по ним не посчитать вовсе, пока их меньше трёх.
    const fit = linearFit(sorted.map(row => ({
      x: (row.at.getTime() - from) / DAY_MS,
      y: Math.log(row.price)
    })))
    const monthlyRate = fit?.significant ? Math.exp(fit.slope * MONTH_DAYS) - 1 : null
    const last = months.at(-1)!
    const lastAt = sorted.at(-1)!.at

    const yearAgo = shiftMonth(last.month, -12)
    const previous = months.find(item => item.month === yearAgo)

    return {
      fuelType,
      fills: sorted.length,
      months,
      first: months[0]!,
      last,
      fit,
      monthlyRate,
      yearlyRate: monthlyRate == null ? null : (1 + monthlyRate) ** 12 - 1,
      yearOverYear: previous
        ? {
            month: last.month,
            price: last.price,
            previousMonth: previous.month,
            previousPrice: previous.price,
            change: last.price - previous.price,
            share: previous.price > 0 ? last.price / previous.price - 1 : 0
          }
        : null,
      forecast: fit?.significant
        ? [6, 12].map(ahead => ({
            month: shiftMonth(last.month, ahead),
            price: Math.exp(predict(fit, (lastAt.getTime() - from) / DAY_MS + ahead * MONTH_DAYS))
          }))
        : [],
      days: (sorted.at(-1)!.at.getTime() - from) / DAY_MS
    }
  }).sort((left, right) => right.fills - left.fills)

  return { byFuelType, main: byFuelType[0] ?? null }
}
