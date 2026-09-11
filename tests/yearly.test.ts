import { describe, expect, it } from 'vitest'
import { compareYears, monthRecords, projectYear, yearPace, type YearMonth } from '../shared/yearly'

const now = new Date('2026-03-16T12:00:00.000Z')

function month(name: string, distance: number, extra: Partial<YearMonth> = {}): YearMonth {
  return {
    month: name,
    distance,
    trips: 20,
    fuelUsed: distance * 0.09,
    consumption: 9,
    spend: distance * 6,
    costPerKm: 6,
    pricePerLitre: 66,
    ...extra
  }
}

describe('projectYear', () => {
  it('переносит средний день на остаток года', () => {
    const projection = projectYear([
      month('2026-01', 1000),
      month('2026-02', 900),
      month('2026-03', 500)
    ], now)!

    expect(projection.year).toBe('2026')
    expect(projection.distance).toBe(2400)
    // С первого января по шестнадцатое марта — семьдесят четыре дня из
    // трёхсот шестидесяти пяти.
    expect(projection.daysGone).toBeCloseTo(74.4, 0)
    expect(projection.perDay).toBeCloseTo(2400 / projection.daysGone)
    expect(projection.projectedDistance).toBeCloseTo(projection.perDay * projection.daysTotal)
    expect(projection.projectedSpend).toBeCloseTo(2400 * 6 / projection.daysGone * projection.daysTotal)
  })

  it('считает год от первого месяца наблюдений, а не от января', () => {
    const projection = projectYear([month('2026-02', 1000), month('2026-03', 500)], now)!
    // Февраль и половина марта — сорок с небольшим дней, а не семьдесят четыре.
    expect(projection.daysGone).toBeLessThan(50)
    expect(projection.daysTotal).toBeCloseTo(334, 0)
  })

  it('без единого месяца этого года прогноза не даёт', () => {
    expect(projectYear([month('2025-11', 1000)], now)).toBeNull()
  })
})

describe('compareYears', () => {
  it('сравнивает год к году по одним и тем же месяцам', () => {
    const comparison = compareYears([
      month('2025-01', 800),
      month('2025-02', 700),
      month('2025-03', 900),
      // Апрель прошлого года в сравнение не идёт: в этом году он ещё не наступил.
      month('2025-04', 1200),
      month('2026-01', 1000),
      month('2026-02', 900),
      month('2026-03', 500)
    ], now)!

    expect(comparison.months).toBe(3)
    expect(comparison.previousDistance).toBe(2400)
    expect(comparison.current.distance).toBe(2400)
    expect(comparison.distanceShare).toBeCloseTo(0)
  })

  it('без прошлого года молчит', () => {
    expect(compareYears([month('2026-01', 1000), month('2026-02', 900)], now)).toBeNull()
  })
})

describe('monthRecords', () => {
  it('называет рекорды только среди законченных месяцев', () => {
    const records = monthRecords([
      month('2026-01', 1000, { consumption: 10.5, costPerKm: 7 }),
      month('2026-02', 1800, { consumption: 8.4, costPerKm: 5.4 }),
      // Текущий месяц не кончился и в рекорды не идёт, хотя он и самый
      // «спокойный» по километрам.
      month('2026-03', 200, { consumption: 12, costPerKm: 9 })
    ], now)

    expect(records.busiest).toMatchObject({ month: '2026-02', value: 1800 })
    expect(records.quietest).toMatchObject({ month: '2026-01', value: 1000 })
    expect(records.thriftiest).toMatchObject({ month: '2026-02' })
    expect(records.thirstiest).toMatchObject({ month: '2026-01' })
    expect(records.dearestKm).toMatchObject({ month: '2026-01', value: 7 })
    expect(records.cheapestKm).toMatchObject({ month: '2026-02', value: 5.4 })
  })

  it('на одном прожитом месяце рекордов не бывает', () => {
    const records = monthRecords([month('2026-02', 1800), month('2026-03', 200)], now)
    expect(records.busiest).toBeNull()
    expect(records.thriftiest).toBeNull()
  })
})

describe('yearPace', () => {
  const months = [month('2026-01', 1000), month('2026-02', 900), month('2026-03', 500)]

  it('ведёт накопленный итог до текущего месяца и прогноз после него', () => {
    const pace = yearPace(months, now)!

    expect(pace.points).toHaveLength(12)
    expect(pace.points.map(point => point.month).at(-1)).toBe('2026-12')
    // Факт кончается на текущем месяце, дальше его нет.
    expect(pace.points[2]).toMatchObject({ month: '2026-03', distance: 2400 })
    expect(pace.points[1]!.distance).toBe(1900)
    expect(pace.points[3]!.distance).toBeNull()

    // Пунктир начинается от последней известной точки, чтобы линия не рвалась.
    expect(pace.points[1]!.projectedDistance).toBeNull()
    expect(pace.points[2]!.projectedDistance).toBe(2400)
    expect(pace.points.at(-1)!.projectedDistance).toBeCloseTo(projectYear(months, now)!.projectedDistance, 6)
    expect(pace.points.at(-1)!.projectedSpend).toBeCloseTo(projectYear(months, now)!.projectedSpend!, 6)
  })

  it('сохраняет прогноз, каким он выходил в конце каждого прожитого месяца', () => {
    const pace = yearPace(months, now)!

    // Январь: тысяча километров за тридцать один день, перенесённая на год.
    expect(pace.points[0]!.forecast).toBeCloseTo(1000 / 31 * pace.daysTotal, 6)
    // Последнее обещание — то же самое число, что стоит на карточке года.
    expect(pace.points[2]!.forecast).toBeCloseTo(projectYear(months, now)!.projectedDistance, 6)
    // У месяцев, которые ещё не наступили, обещания нет.
    expect(pace.points[3]!.forecast).toBeNull()
  })

  it('бросает рубли, как только у месяца потерялись чеки', () => {
    const pace = yearPace([
      month('2026-01', 1000),
      month('2026-02', 900, { spend: null, refuels: 2 }),
      month('2026-03', 500)
    ], now)!

    expect(pace.points[0]!.spend).toBe(6000)
    expect(pace.points[1]!.spend).toBeNull()
    expect(pace.points[2]!.spend).toBeNull()
    expect(pace.points.at(-1)!.projectedSpend).toBeNull()
  })

  it('месяц без единой заправки стоит ноль и счёт не рвёт', () => {
    const pace = yearPace([
      month('2026-01', 1000),
      month('2026-02', 120, { spend: null, refuels: 0 }),
      month('2026-03', 500)
    ], now)!

    expect(pace.points[1]!.spend).toBe(6000)
    expect(pace.points[2]!.spend).toBe(6000 + 3000)
    expect(pace.points.at(-1)!.projectedSpend).toBeGreaterThan(9000)
  })

  it('считает год от первого месяца наблюдений', () => {
    const pace = yearPace([month('2026-02', 1000), month('2026-03', 500)], now)!

    expect(pace.points[0]!.month).toBe('2026-02')
    expect(pace.points).toHaveLength(11)
    expect(pace.daysTotal).toBeCloseTo(334, 0)
  })

  it('без единого месяца этого года молчит', () => {
    expect(yearPace([month('2025-11', 1000)], now)).toBeNull()
  })
})
