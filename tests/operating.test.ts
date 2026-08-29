import { describe, expect, it } from 'vitest'
import { operatingBand, operatingDeviation, operatingRates } from '../shared/operating'

// Четыре недели августа как они есть в боевой базе: километры и моточасы
// сложены из приращений одометра и счётчика сигнализации.
const august = [
  { bucket: '2026-31', from: '2026-08-04', to: '2026-08-10', km: 206, motorMinutes: 264 },
  { bucket: '2026-32', from: '2026-08-11', to: '2026-08-17', km: 371, motorMinutes: 510 },
  { bucket: '2026-33', from: '2026-08-18', to: '2026-08-24', km: 136, motorMinutes: 378 },
  { bucket: '2026-34', from: '2026-08-25', to: '2026-08-31', km: 407, motorMinutes: 522 }
]

describe('operatingRates', () => {
  it('делит километры на часы работы двигателя, а не на время в пути', () => {
    const rates = operatingRates(august)
    expect(rates.map(item => Math.round(item.kmPerHour!))).toEqual([47, 44, 22, 47])
  })

  it('отказывается делить, когда двигатель работал меньше часа', () => {
    const [rate] = operatingRates([{ bucket: 'w', from: 'd', to: 'd', km: 12, motorMinutes: 25 }])
    expect(rate!.kmPerHour).toBeNull()
    expect(rate!.band).toBeNull()
  })
})

describe('operatingBand', () => {
  it('называет режим теми же числами, что и цеховые оценки ресурса масла', () => {
    expect(operatingBand(15)!.name).toBe('idle')
    expect(operatingBand(35)!.name).toBe('city')
    expect(operatingBand(47)!.name).toBe('mixed')
    expect(operatingBand(75)!.name).toBe('highway')
    expect(operatingBand(null)).toBeNull()
  })
})

describe('operatingDeviation', () => {
  it('сравнивает неделю с остальными, а не со средним, куда входит сама', () => {
    const rates = operatingRates(august)
    const week33 = rates.find(item => item.bucket === '2026-33')!
    // 22 км на моточас против 45 по остальным трём неделям: двигатель работал
    // столько же, а машина проехала втрое меньше.
    expect(operatingDeviation(rates, week33)).toBeCloseTo(-0.53, 2)
  })

  it('взвешивает недели моточасами: неделя с одним выездом не ровня месяцу', () => {
    const rates = operatingRates([
      { bucket: 'a', from: 'd', to: 'd', km: 400, motorMinutes: 600 },
      { bucket: 'b', from: 'd', to: 'd', km: 5, motorMinutes: 60 },
      { bucket: 'c', from: 'd', to: 'd', km: 400, motorMinutes: 600 }
    ])
    expect(operatingDeviation(rates, rates[1]!)).toBeCloseTo(-0.875, 3)
  })

  it('не с чем сравнивать — нет и отклонения', () => {
    const rates = operatingRates([august[0]!])
    expect(operatingDeviation(rates, rates[0]!)).toBeNull()
  })
})
