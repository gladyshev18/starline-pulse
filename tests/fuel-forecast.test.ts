import { describe, expect, it } from 'vitest'
import { forecastRange, percentile } from '../shared/fuel-forecast'

// Суточный пробег за август по дням, когда машина выезжала: от 13 до 130,6 км.
const daily = [13, 15, 21.4, 23, 26, 26.5, 31.7, 52.7, 53.1, 53.9, 54.7, 58, 60.7, 62.3, 69.2, 118, 118, 125.2, 130.6]
const trips = [2.5, 3.1, 3.6, 4.4, 5.5, 7.2, 9.4, 10, 11.4, 13, 25.5, 31.7, 90]

describe('percentile', () => {
  it('берёт середину между соседями, когда точного места нет', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25)
    expect(percentile([10, 20, 30], 0.5)).toBe(20)
    expect(percentile([], 0.5)).toBeNull()
  })
})

describe('forecastRange', () => {
  const full = { litres: 41, consumption: 10, dailyDistances: daily, tripDistances: trips }

  it('километры считает прямо: они от привычек не зависят', () => {
    expect(forecastRange(full).km).toBeCloseTo(410, 5)
  })

  it('вместо среднего срока даёт три: тихо, обычно, активно', () => {
    const { days } = forecastRange(full)
    // Медиана дня — 53,9 км, нижний квартиль 26,25, верхний 65,75.
    expect(days!.typical).toBeCloseTo(7.6, 1)
    expect(days!.quiet).toBeCloseTo(15.6, 1)
    expect(days!.busy).toBeCloseTo(6.2, 1)
    // Тихий день всегда даёт больший срок, чем активный: иначе местами
    // перепутаны квартили.
    expect(days!.quiet).toBeGreaterThan(days!.busy)
  })

  it('переводит запас в поездки — единицу, в которой человек и планирует', () => {
    const { trips: forecast } = forecastRange(full)
    expect(forecast!.typical).toBeCloseTo(9.4, 1)
    expect(forecast!.typicalCount).toBeCloseTo(43.6, 1)
    // Дальняя поездка — девяностый перцентиль, 30,5 км: таких выйдет тринадцать.
    expect(forecast!.long).toBeCloseTo(30.5, 1)
    expect(forecast!.longCount).toBeCloseTo(13.5, 1)
  })

  it('молчит о днях, пока история короче недели', () => {
    const short = forecastRange({ ...full, dailyDistances: [50, 60, 70] })
    expect(short.km).toBeCloseTo(410, 5)
    expect(short.days).toBeNull()
  })

  it('молчит обо всём, когда расход неизвестен', () => {
    expect(forecastRange({ ...full, consumption: null })).toEqual({ km: null, days: null, trips: null })
    expect(forecastRange({ ...full, litres: 0 }).km).toBeNull()
  })
})
