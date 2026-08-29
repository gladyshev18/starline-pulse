import { describe, expect, it } from 'vitest'
import { summariseFuelPrices } from '../shared/fuel-prices'

// Чеки, как они лежат в боевой базе: два вида топлива, две сети и один возврат
// прихода на недолитые 0,79 л.
const receipts = [
  { purchasedAt: '2026-08-11T09:41:00Z', station: 'rosneft', stationName: null, fuelType: 'АИ-95', litres: 30, pricePerLitre: 69.75, operation: 'purchase' as const },
  { purchasedAt: '2026-08-15T11:50:00Z', station: 'rosneft', stationName: null, fuelType: 'АИ-92', litres: 20, pricePerLitre: 64.25, operation: 'purchase' as const },
  { purchasedAt: '2026-08-22T15:34:00Z', station: 'lukoil', stationName: null, fuelType: 'АИ-95', litres: 24.31, pricePerLitre: 72.37, operation: 'purchase' as const },
  { purchasedAt: '2026-08-27T11:02:00Z', station: null, stationName: null, fuelType: 'АИ-95', litres: 25, pricePerLitre: 69.75, operation: 'purchase' as const },
  { purchasedAt: '2026-08-27T11:05:00Z', station: null, stationName: null, fuelType: 'АИ-95', litres: 0.79, pricePerLitre: 69.75, operation: 'refund' as const }
]

describe('summariseFuelPrices', () => {
  it('не смешивает виды топлива в один ряд', () => {
    const { byFuelType } = summariseFuelPrices(receipts)
    expect(byFuelType.map(item => item.fuelType)).toEqual(['АИ-95', 'АИ-92'])
    expect(byFuelType[0]!.points).toHaveLength(3)
  })

  it('не заводит точку на возврат: цена в нём та же, что в покупке', () => {
    const { byFuelType } = summariseFuelPrices(receipts)
    expect(byFuelType[0]!.points.filter(point => point.litres === 0.79)).toHaveLength(0)
  })

  it('меряет изменение от первого чека к последнему', () => {
    const [ai95] = summariseFuelPrices(receipts).byFuelType
    expect(ai95!.first.price).toBe(69.75)
    expect(ai95!.last.price).toBe(69.75)
    expect(ai95!.change).toBe(0)
  })

  it('молчит об изменении, когда чек всего один', () => {
    const [, ai92] = summariseFuelPrices(receipts).byFuelType
    expect(ai92!.change).toBeNull()
    expect(ai92!.changeShare).toBeNull()
  })

  it('взвешивает среднюю цену сети литрами, а не числом чеков', () => {
    const { byStation } = summariseFuelPrices([
      { purchasedAt: '2026-08-01T00:00:00Z', station: 'rosneft', stationName: null, fuelType: 'АИ-95', litres: 40, pricePerLitre: 70, operation: 'purchase' as const },
      { purchasedAt: '2026-08-02T00:00:00Z', station: 'rosneft', stationName: null, fuelType: 'АИ-95', litres: 10, pricePerLitre: 80, operation: 'purchase' as const }
    ])
    expect(byStation[0]!.averagePrice).toBeCloseTo(72, 5)
  })

  it('считает переплату только там, где один бензин брали в разных сетях', () => {
    const { overpay } = summariseFuelPrices(receipts)
    expect(overpay).toHaveLength(1)
    const [ai95] = overpay
    expect(ai95!.fuelType).toBe('АИ-95')
    expect(ai95!.cheapest.averagePrice).toBeCloseTo(69.75, 2)
    expect(ai95!.dearest.averagePrice).toBeCloseTo(72.37, 2)
    // 24,31 л Лукойла по 72,37 против 69,75 у самой дешёвой сети — 63,7 ₽.
    expect(ai95!.amount).toBeCloseTo(63.7, 1)
  })

  it('переживает месяц без единого чека', () => {
    expect(summariseFuelPrices([])).toEqual({ byFuelType: [], byStation: [], overpay: [] })
  })
})
