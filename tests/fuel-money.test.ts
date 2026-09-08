import { describe, expect, it } from 'vitest'
import { summariseInflation, type InflationFill } from '../shared/fuel-inflation'
import { summariseOverpay, type OverpayFill } from '../shared/fuel-overpay'
import { summariseCoverage } from '../shared/receipt-coverage'

function fill(at: string, station: string, price: number, litres = 40): OverpayFill {
  return {
    at: new Date(at),
    station,
    stationName: station === 'lukoil' ? 'Лукойл' : 'Роснефть',
    fuelType: 'АИ-95',
    litres,
    pricePerLitre: price,
    operation: 'purchase'
  }
}

describe('summariseOverpay', () => {
  it('считает переплату против самой дешёвой сети, известной на день заправки', () => {
    const overpay = summariseOverpay([
      fill('2026-01-05T10:00:00.000Z', 'rosneft', 60),
      fill('2026-01-15T10:00:00.000Z', 'lukoil', 63),
      fill('2026-01-25T10:00:00.000Z', 'lukoil', 63)
    ])

    // Первая заправка сравнивать себя ещё не с чем: другой сети в тот день не
    // знали.
    expect(overpay.skipped).toBe(1)
    expect(overpay.fills).toBe(2)
    expect(overpay.amount).toBeCloseTo(3 * 40 * 2)
    expect(overpay.share).toBeCloseTo(240 / (63 * 80))
    expect(overpay.points.at(-1)!.cumulative).toBeCloseTo(240)
    expect(overpay.points[0]!.benchmarkStation).toBe('rosneft')
  })

  it('заправке на самой дешёвой сети переплату не приписывает', () => {
    const overpay = summariseOverpay([
      fill('2026-01-05T10:00:00.000Z', 'lukoil', 66),
      fill('2026-01-10T10:00:00.000Z', 'rosneft', 60),
      fill('2026-01-20T10:00:00.000Z', 'rosneft', 60)
    ])
    expect(overpay.amount).toBe(0)
    expect(overpay.byStation.find(item => item.station === 'rosneft')!.amount).toBe(0)
  })

  it('не сравнивает с ценой, которой полтора месяца', () => {
    const overpay = summariseOverpay([
      fill('2026-01-05T10:00:00.000Z', 'rosneft', 60),
      // Через два месяца цена «Роснефти» уже ничего не говорит о сегодняшнем дне.
      fill('2026-03-10T10:00:00.000Z', 'lukoil', 70)
    ])
    expect(overpay.skipped).toBe(2)
    expect(overpay.amount).toBe(0)
  })

  it('не считает переплатой разные виды топлива', () => {
    const overpay = summariseOverpay([
      { ...fill('2026-01-05T10:00:00.000Z', 'rosneft', 55), fuelType: 'АИ-92' },
      fill('2026-01-10T10:00:00.000Z', 'lukoil', 66)
    ])
    expect(overpay.amount).toBe(0)
    expect(overpay.skipped).toBe(2)
  })
})

function priced(at: string, price: number, litres = 40): InflationFill {
  return { at: new Date(at), fuelType: 'АИ-95', litres, pricePerLitre: price, operation: 'purchase' }
}

describe('summariseInflation', () => {
  it('называет темп подорожания в процентах за месяц', () => {
    // Ровно процент в месяц: цена умножается на 1,01 каждые тридцать дней.
    const rate = 1.01
    const fills = Array.from({ length: 8 }, (_, index) => priced(
      new Date(Date.UTC(2026, 0, 5) + index * 30.437 * 24 * 3600e3).toISOString(),
      60 * rate ** index
    ))

    const { main } = summariseInflation(fills)
    expect(main!.fuelType).toBe('АИ-95')
    expect(main!.monthlyRate).toBeCloseTo(0.01, 3)
    expect(main!.yearlyRate).toBeCloseTo(1.01 ** 12 - 1, 2)
    expect(main!.forecast).toHaveLength(2)
    expect(main!.forecast[1]!.price).toBeCloseTo(main!.last.price * 1.01 ** 12, 0)
  })

  it('молчит о темпе, когда цена скачет без направления', () => {
    const { main } = summariseInflation([
      priced('2026-01-05T10:00:00.000Z', 62),
      priced('2026-02-05T10:00:00.000Z', 59),
      priced('2026-03-05T10:00:00.000Z', 63),
      priced('2026-04-05T10:00:00.000Z', 60)
    ])
    expect(main!.monthlyRate).toBeNull()
    expect(main!.forecast).toEqual([])
    expect(main!.months).toHaveLength(4)
  })

  it('сравнивает с тем же месяцем год назад, когда год уже прожит', () => {
    const { main } = summariseInflation([
      priced('2025-03-05T10:00:00.000Z', 60),
      priced('2025-09-05T10:00:00.000Z', 64),
      priced('2026-03-05T10:00:00.000Z', 69)
    ])
    expect(main!.yearOverYear).toMatchObject({ month: '2026-03', previousMonth: '2025-03' })
    expect(main!.yearOverYear!.share).toBeCloseTo(69 / 60 - 1)
  })

  it('не смешивает АИ-92 с АИ-95', () => {
    const { byFuelType } = summariseInflation([
      priced('2026-01-05T10:00:00.000Z', 66),
      { ...priced('2026-01-10T10:00:00.000Z', 57), fuelType: 'АИ-92' }
    ])
    expect(byFuelType.map(item => item.fuelType).sort()).toEqual(['АИ-92', 'АИ-95'])
  })

  it('средняя цена месяца взвешена литрами', () => {
    const { main } = summariseInflation([
      priced('2026-01-05T10:00:00.000Z', 60, 40),
      priced('2026-01-25T10:00:00.000Z', 70, 10)
    ])
    expect(main!.months[0]!.price).toBeCloseTo((60 * 40 + 70 * 10) / 50)
  })
})

describe('summariseCoverage', () => {
  it('считает долю литров, за которыми стоит чек, и оценивает пропущенные рубли', () => {
    const coverage = summariseCoverage([
      { litresAdded: 40, sensorLitresAdded: 38, totalAmount: 2800 },
      { litresAdded: null, sensorLitresAdded: 20, totalAmount: null }
    ])
    expect(coverage.refuels).toBe(2)
    expect(coverage.covered).toBe(1)
    expect(coverage.litres).toBe(60)
    expect(coverage.litresCovered).toBe(40)
    expect(coverage.share).toBeCloseTo(40 / 60)
    expect(coverage.pricePerLitre).toBeCloseTo(70)
    expect(coverage.missingAmount).toBeCloseTo(20 * 70)
  })

  it('без единого чека берёт цену со стороны, а не выдумывает свою', () => {
    const coverage = summariseCoverage([{ litresAdded: null, sensorLitresAdded: 30, totalAmount: null }], 65)
    expect(coverage.share).toBe(0)
    expect(coverage.missingAmount).toBeCloseTo(30 * 65)
    expect(summariseCoverage([{ litresAdded: null, sensorLitresAdded: 30, totalAmount: null }]).missingAmount).toBeNull()
  })

  it('на месяце без заправок ничего не делит', () => {
    const coverage = summariseCoverage([])
    expect(coverage.share).toBeNull()
    expect(coverage.missingAmount).toBeNull()
  })
})
