import { describe, expect, it } from 'vitest'
import { fixedCostForRange, ownershipCost, serviceCostPerKilometre } from '../shared/ownership'

// Три обслуживания из боевой базы: 1938 км за 9948 ₽, 9114 км за 15 493 ₽ и
// 18 082 км за 17 556 ₽.
const services = [
  { performedAt: new Date('2025-05-22'), mileage: 1938, amount: 9948 },
  { performedAt: new Date('2025-12-26'), mileage: 9114, amount: 15493 },
  { performedAt: new Date('2026-07-27'), mileage: 18082, amount: 17556 }
]

describe('serviceCostPerKilometre', () => {
  it('не берёт в расчёт сумму первого обслуживания', () => {
    // Пробег до него неизвестен, и делить эти 9948 ₽ не на что.
    const cost = serviceCostPerKilometre(services)
    expect(cost.amount).toBe(33049)
    expect(cost.services).toBe(2)
    expect(cost.km).toBe(16144)
    expect(cost.costPerKm).toBeCloseTo(2.05, 2)
  })

  it('считает километры между обслуживаниями, а не весь пробег машины', () => {
    // Иначе километр дешевеет ровно оттого, что до следующего сервиса ещё не
    // доехали.
    expect(serviceCostPerKilometre(services).toMileage).toBe(18082)
  })

  it('молчит, пока обслуживание всего одно', () => {
    expect(serviceCostPerKilometre([services[0]!]).costPerKm).toBeNull()
    expect(serviceCostPerKilometre([]).costPerKm).toBeNull()
  })

  it('переживает заказ-наряд без суммы', () => {
    const cost = serviceCostPerKilometre([
      services[0]!,
      { performedAt: new Date('2025-12-26'), mileage: 9114, amount: null }
    ])
    expect(cost.costPerKm).toBeNull()
    expect(cost.km).toBe(7176)
  })

  it('не пугается обслуживаний, записанных не по порядку', () => {
    const shuffled = [services[2]!, services[0]!, services[1]!]
    expect(serviceCostPerKilometre(shuffled).costPerKm).toBeCloseTo(2.05, 2)
  })
})

describe('fixedCostForRange', () => {
  const osago = {
    label: 'ОСАГО',
    amount: 12000,
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2027-01-01T00:00:00Z')
  }

  it('отдаёт месяцу ровно те дни, которыми он пересёкся с полисом', () => {
    const august = fixedCostForRange([osago], new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'))
    expect(august).toBeCloseTo(12000 * 31 / 365, 2)
  })

  it('складывается обратно в стоимость полиса за весь его срок', () => {
    const whole = fixedCostForRange([osago], new Date('2026-01-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z'))
    expect(whole).toBeCloseTo(12000, 6)
  })

  it('не приписывает месяцу то, что кончилось до него', () => {
    expect(fixedCostForRange([osago], new Date('2027-02-01T00:00:00Z'), new Date('2027-03-01T00:00:00Z'))).toBe(0)
  })
})

describe('ownershipCost', () => {
  it('разделяет стоимость поехать и стоимость владеть', () => {
    const cost = ownershipCost({ fuelPerKm: 6.5, servicePerKm: 2.05, fixedAmount: 1019, distance: 1120 })
    expect(cost.variablePerKm).toBeCloseTo(8.55, 2)
    expect(cost.fixedPerKm).toBeCloseTo(0.91, 2)
    expect(cost.totalPerKm).toBeCloseTo(9.46, 2)
  })

  it('в месяц без пробега постоянные расходы ни на что не делятся', () => {
    const cost = ownershipCost({ fuelPerKm: null, servicePerKm: 2.05, fixedAmount: 1019, distance: 0 })
    expect(cost.fixedPerKm).toBeNull()
    expect(cost.totalPerKm).toBeCloseTo(2.05, 2)
  })

  it('обходится без слагаемых, которых ещё нет', () => {
    const cost = ownershipCost({ fuelPerKm: null, servicePerKm: null, fixedAmount: 0, distance: 500 })
    expect(cost).toMatchObject({ variablePerKm: null, fixedPerKm: null, totalPerKm: null })
  })
})
