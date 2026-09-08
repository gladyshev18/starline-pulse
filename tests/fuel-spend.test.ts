import { describe, expect, it } from 'vitest'
import { summariseFuelSpend } from '../shared/fuel-spend'

describe('summariseFuelSpend', () => {
  it('оставляет месяц без чеков без суммы вовсе', () => {
    const spend = summariseFuelSpend([
      { litresAdded: 30, totalAmount: null },
      { litresAdded: 25, totalAmount: null }
    ])
    // Ноль рублей читался бы как месяц, в котором не заправлялись.
    expect(spend.amount).toBeNull()
    expect(spend.refuels).toBe(0)
    expect(spend.unknown).toBe(2)
    expect(spend.total).toBe(2)
    expect(spend.pricePerLitre).toBeNull()
  })

  it('делит сумму только на литры оплаченных заправок', () => {
    const spend = summariseFuelSpend([
      { litresAdded: 30, totalAmount: 1800 },
      { litresAdded: 20, totalAmount: 1300 },
      // Заправка без чека и в рубли, и в литры знаменателя не попадает — иначе
      // цена литра вышла бы ниже любой реальной.
      { litresAdded: 40, totalAmount: null }
    ])
    expect(spend.amount).toBe(3100)
    expect(spend.litres).toBe(50)
    expect(spend.pricePerLitre).toBe(62)
    expect(spend.refuels).toBe(2)
    expect(spend.unknown).toBe(1)
  })

  it('не делит сумму, когда объём заправки неизвестен', () => {
    const spend = summariseFuelSpend([{ litresAdded: null, totalAmount: 1500 }])
    expect(spend.amount).toBe(1500)
    expect(spend.pricePerLitre).toBeNull()
  })
})
