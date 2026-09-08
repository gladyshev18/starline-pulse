import { describe, expect, it } from 'vitest'
import { compareYears, monthRecords, projectYear, type YearMonth } from '../shared/yearly'

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
