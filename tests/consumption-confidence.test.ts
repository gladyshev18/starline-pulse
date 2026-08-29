import { describe, expect, it } from 'vitest'
import {
  assessConsumption,
  consumptionErrorBound,
  doubtsAbout,
  MIN_BUCKET_SAMPLES
} from '../shared/consumption-confidence'

describe('consumptionErrorBound', () => {
  it('падает обратно расстоянию: шаг датчика один и тот же на любой поездке', () => {
    expect(consumptionErrorBound(3.6)).toBeCloseTo(14.2, 1)
    expect(consumptionErrorBound(31.7)).toBeCloseTo(1.6, 1)
    expect(consumptionErrorBound(0)).toBeNull()
    expect(consumptionErrorBound(null)).toBeNull()
  })
})

describe('doubtsAbout', () => {
  it('снимает доверие с поездки, где одна ступенька датчика решает всё', () => {
    // Поездка 49 от 22 августа: 3,6 км и 1,02 л дают 28 л/100 км. Столько
    // машина не ест — просто датчик дважды щёлкнул на трёх километрах.
    expect(doubtsAbout({ distance: 3.6, fuelUsed: 1.02, durationMinutes: 36 })).toEqual(['short', 'crawl'])
  })

  it('не трогает поездку, у которой километров хватает', () => {
    // Те же 14 августа: 31,7 км за 33 минуты, 12,9 л/100 км. Граница ошибки —
    // полтора литра на сотню, и она ничего здесь не решает.
    expect(doubtsAbout({ distance: 31.7, fuelUsed: 4.08, durationMinutes: 32.8 })).toEqual([])
  })

  it('отмечает стояние отдельно от короткой дистанции', () => {
    // Двадцать километров ползком: расстояния датчику хватает, но такой расход
    // описывает пробку, а не дорогу.
    expect(doubtsAbout({ distance: 20, fuelUsed: 3, durationMinutes: 120 })).toEqual(['crawl'])
  })

  it('считает нулевой расход таким же неизмеренным, как и завышенный', () => {
    expect(doubtsAbout({ distance: 2, fuelUsed: 0, durationMinutes: 4 })).toContain('short')
  })
})

describe('assessConsumption', () => {
  const city = (id: number, consumption: number) => ({
    id,
    distance: 30,
    fuelUsed: consumption * 30 / 100,
    durationMinutes: 45
  })

  it('меряет отклонение от медианы своей корзины, а не от общего среднего', () => {
    const trips = [...Array(MIN_BUCKET_SAMPLES).keys()].map(index => city(index + 1, 9 + index * 0.1))
    const quality = assessConsumption([...trips, city(99, 20)])
    const outlier = quality.find(item => item.id === 99)!
    expect(outlier.deviation).toBeGreaterThan(10)
    expect(outlier.outlier).toBe(true)
    expect(quality.filter(item => item.outlier)).toHaveLength(1)
  })

  it('молчит, пока корзина не набрала достаточно поездок', () => {
    const quality = assessConsumption([city(1, 9), city(2, 9.2), city(3, 20)])
    expect(quality.every(item => !item.outlier)).toBe(true)
    expect(quality.every(item => item.deviation == null)).toBe(true)
  })

  it('не берёт в медиану поездки, чей расход не измерен', () => {
    // Иначе корзину задаёт округление датчика: короткие поездки дают то 0, то
    // 28 л/100 км, и медиана поедет за ними.
    const noisy = { id: 100, distance: 2, fuelUsed: 1.02, durationMinutes: 6 }
    const trips = [...Array(MIN_BUCKET_SAMPLES).keys()].map(index => city(index + 1, 9 + index * 0.1))
    const quality = assessConsumption([...trips, noisy])
    expect(quality.find(item => item.id === 100)!.deviation).toBeNull()
    expect(quality.find(item => item.id === 1)!.deviation).toBeCloseTo(-0.2, 5)
  })

  it('не объявляет выбросом то, что укладывается в разброс корзины', () => {
    const spread = [8, 9, 10, 11, 12, 13].map((value, index) => city(index + 1, value))
    const quality = assessConsumption(spread)
    expect(quality.every(item => !item.outlier)).toBe(true)
  })
})
