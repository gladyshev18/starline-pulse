import { describe, expect, it } from 'vitest'
import { measureDriftTrend } from '../shared/sensor-drift'
import { BASE_CELSIUS, summariseSeasonality, type SeasonMonth } from '../shared/seasonality'

function month(name: string, celsius: number | null, consumption: number | null, distance = 1000): SeasonMonth {
  return {
    month: name,
    celsius,
    consumption,
    distance,
    fuelUsed: consumption == null ? 0 : consumption * distance / 100,
    pricePerLitre: 70
  }
}

describe('summariseSeasonality', () => {
  it('находит, на сколько литров на сотню дорожает каждые десять градусов холода', () => {
    const season = summariseSeasonality([
      month('2026-01', -10, 11),
      month('2026-03', 0, 10),
      month('2026-05', 10, 9),
      month('2026-07', 20, 8)
    ])
    expect(season.months).toBe(4)
    expect(season.litresPerTenDegrees).toBeCloseTo(1)
    expect(season.coldest).toBe(-10)
    expect(season.warmest).toBe(20)
  })

  it('раскладывает надбавку по холодным месяцам в литры и рубли', () => {
    const season = summariseSeasonality([
      month('2026-01', -10, 11),
      month('2026-03', 0, 10),
      month('2026-05', 10, 9),
      month('2026-07', 20, 8)
    ])
    const january = season.premium.find(item => item.month === '2026-01')!
    // От базовых пятнадцати градусов до минус десяти — двадцать пять градусов и
    // два с половиной литра на сотню.
    expect(january.extraConsumption).toBeCloseTo((BASE_CELSIUS - (-10)) / 10)
    expect(january.extraLitres).toBeCloseTo(2.5 * 1000 / 100)
    expect(january.extraCost).toBeCloseTo(25 * 70)
    // Июль теплее базы — надбавки у него нет вовсе.
    expect(season.premium.some(item => item.month === '2026-07')).toBe(false)
    expect(season.extraCost).toBeGreaterThan(0)
  })

  it('молчит, пока месяцы отличаются не холодом, а чем угодно ещё', () => {
    const season = summariseSeasonality([
      month('2026-01', -5, 9),
      month('2026-02', 0, 11),
      month('2026-03', 5, 9.5),
      month('2026-04', 12, 10.5)
    ])
    expect(season.litresPerTenDegrees).toBeNull()
    expect(season.premium).toEqual([])
    expect(season.extraCost).toBeNull()
    // Сама прямая при этом посчитана: показать её можно, выводы по ней — нет.
    expect(season.fit).not.toBeNull()
  })

  it('пропускает месяцы без погоды и без расхода', () => {
    const season = summariseSeasonality([
      month('2026-01', null, 11),
      month('2026-02', 5, null),
      month('2026-03', 10, 9)
    ])
    expect(season.months).toBe(1)
    expect(season.fit).toBeNull()
  })
})

describe('measureDriftTrend', () => {
  it('видит, как датчик расходится с чеками со временем', () => {
    const trend = measureDriftTrend([
      { at: new Date('2026-01-01T10:00:00.000Z'), sensorLitres: 40, receiptLitres: 40, percentAfter: 80 },
      { at: new Date('2026-02-01T10:00:00.000Z'), sensorLitres: 41, receiptLitres: 40, percentAfter: 80 },
      { at: new Date('2026-03-01T10:00:00.000Z'), sensorLitres: 42, receiptLitres: 40, percentAfter: 80 },
      { at: new Date('2026-04-01T10:00:00.000Z'), sensorLitres: 43, receiptLitres: 40, percentAfter: 80 }
    ])
    expect(trend.points).toHaveLength(4)
    expect(trend.perMonth).toBeCloseTo(1, 1)
    expect(trend.days).toBeCloseTo(90, 0)
  })

  it('не выдаёт наклон, когда разница просто скачет', () => {
    const trend = measureDriftTrend([
      { at: new Date('2026-01-01T10:00:00.000Z'), sensorLitres: 41, receiptLitres: 40, percentAfter: 80 },
      { at: new Date('2026-02-01T10:00:00.000Z'), sensorLitres: 39.5, receiptLitres: 40, percentAfter: 80 },
      { at: new Date('2026-03-01T10:00:00.000Z'), sensorLitres: 40.8, receiptLitres: 40, percentAfter: 80 },
      { at: new Date('2026-04-01T10:00:00.000Z'), sensorLitres: 39.8, receiptLitres: 40, percentAfter: 80 }
    ])
    expect(trend.perMonth).toBeNull()
  })

  it('выбрасывает заправки до полного бака — там датчик упирается в потолок', () => {
    const trend = measureDriftTrend([
      { at: new Date('2026-01-01T10:00:00.000Z'), sensorLitres: 40, receiptLitres: 42, percentAfter: 100 },
      { at: new Date('2026-02-01T10:00:00.000Z'), sensorLitres: 41, receiptLitres: 40, percentAfter: 80 }
    ])
    expect(trend.points).toHaveLength(1)
  })
})
