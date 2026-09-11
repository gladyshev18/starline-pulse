import { describe, expect, it } from 'vitest'
import {
  isTankSummaryUsable,
  summariseTankLegs,
  tankLegs,
  type TankRefuel
} from '../shared/tank-to-tank'

const at = (day: number) => new Date(Date.UTC(2026, 7, day, 9))

function refuel(overrides: Partial<TankRefuel> & { id: number, day: number }): TankRefuel {
  const { day, ...rest } = overrides
  return {
    detectedAt: at(day),
    mileage: null,
    fuelAfter: 51,
    percentAfter: 100,
    litresAdded: null,
    confirmed: true,
    fuelType: null,
    station: null,
    stationName: null,
    ...rest
  }
}

describe('tankLegs', () => {
  it('между двумя полными баками берёт литры прямо из чека', () => {
    const [leg] = tankLegs([
      refuel({ id: 1, day: 1, mileage: 19020, litresAdded: 20 }),
      refuel({ id: 2, day: 8, mileage: 19255, litresAdded: 24.31 })
    ])
    expect(leg!.distance).toBe(235)
    expect(leg!.litres).toBeCloseTo(24.31)
    expect(leg!.consumption).toBeCloseTo(10.34, 2)
    expect(leg!.full).toBe(true)
    expect(leg!.doubts).toEqual([])
  })

  it('поправляет разницу уровней, когда первый бак залит не до полного', () => {
    // 47,43 л после первой заправки, 51 после второй: 3,57 л из долитых уехали
    // не в двигатель, а в бак.
    const [leg] = tankLegs([
      refuel({ id: 1, day: 1, mileage: 18831, fuelAfter: 47.43, percentAfter: 93, litresAdded: 30 }),
      refuel({ id: 2, day: 5, mileage: 19020, litresAdded: 20 })
    ])
    expect(leg!.litres).toBeCloseTo(16.43, 2)
    expect(leg!.consumption).toBeCloseTo(8.69, 2)
    expect(leg!.full).toBe(false)
    expect(leg!.doubts).toContain('partial')
  })

  it('у полного бака граница ошибки уже, чем у неполного', () => {
    const full = tankLegs([
      refuel({ id: 1, day: 1, mileage: 19000, litresAdded: 24 }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: 24 })
    ])[0]!
    const partial = tankLegs([
      refuel({ id: 1, day: 1, mileage: 19000, fuelAfter: 45.9, percentAfter: 90, litresAdded: 24 }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: 29.1 })
    ])[0]!
    expect(full.litres).toBeCloseTo(partial.litres)
    expect(full.errorBound).toBeLessThan(partial.errorBound)
  })

  it('помечает заправку без чека, а не выбрасывает её', () => {
    const [leg] = tankLegs([
      refuel({ id: 1, day: 1, mileage: 19000, litresAdded: 24 }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: 24, confirmed: false })
    ])
    expect(leg!.doubts).toContain('estimated')
    expect(leg!.consumption).toBeCloseTo(9.6, 2)
  })

  it('сомневается в перегоне, который слишком короток для собственной ошибки', () => {
    const [leg] = tankLegs([
      refuel({ id: 1, day: 1, mileage: 19000, litresAdded: 24 }),
      refuel({ id: 2, day: 2, mileage: 19012, litresAdded: 1.2 })
    ])
    expect(leg!.doubts).toContain('short')
  })

  it('пропускает пару без пробега, объёма или с отрицательными литрами', () => {
    expect(tankLegs([
      refuel({ id: 1, day: 1, mileage: null, litresAdded: 24 }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: 24 })
    ])).toHaveLength(0)
    expect(tankLegs([
      refuel({ id: 1, day: 1, mileage: 19000, litresAdded: 24 }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: null })
    ])).toHaveLength(0)
    // Уровень после второй заправки выше, чем прошлый плюс залитое: соврал
    // датчик, а не двигатель.
    expect(tankLegs([
      refuel({ id: 1, day: 1, mileage: 19000, fuelAfter: 30, percentAfter: 59, litresAdded: 24 }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: 20 })
    ])).toHaveLength(0)
  })

  it('называет бензин по открывающей заправке — им и ехали', () => {
    // Литры перегона взяты из второго чека, но это мерка: в двигатель за эти
    // километры уходило то, чем бак наполнили 1-го, а 95-й Лукойла поедет
    // дальше.
    const [leg] = tankLegs([
      refuel({ id: 1, day: 1, mileage: 19000, litresAdded: 24, fuelType: 'АИ-92', station: 'rosneft' }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: 24, fuelType: 'АИ-95', station: 'lukoil' })
    ])
    expect(leg!.fuelType).toBe('АИ-92')
    expect(leg!.station).toBe('rosneft')
  })

  it('строит цепочку в хронологическом порядке, как бы ни пришли заправки', () => {
    const legs = tankLegs([
      refuel({ id: 3, day: 15, mileage: 19500, litresAdded: 21 }),
      refuel({ id: 1, day: 1, mileage: 19000, litresAdded: 24 }),
      refuel({ id: 2, day: 8, mileage: 19250, litresAdded: 24 })
    ])
    expect(legs.map(leg => [leg.fromId, leg.toId])).toEqual([[1, 2], [2, 3]])
  })
})

describe('summariseTankLegs', () => {
  const refuels = [
    refuel({ id: 1, day: 1, mileage: 19020, litresAdded: 20 }),
    refuel({ id: 2, day: 8, mileage: 19255, litresAdded: 24.31 }),
    refuel({ id: 3, day: 13, mileage: 19525, litresAdded: 24.21 }),
    refuel({ id: 4, day: 17, mileage: 19765, litresAdded: 21.2 })
  ]

  it('складывает километры и литры, а не средние', () => {
    const summary = summariseTankLegs(tankLegs(refuels))
    expect(summary.legs).toBe(3)
    expect(summary.fullLegs).toBe(3)
    expect(summary.distance).toBe(745)
    expect(summary.litres).toBeCloseTo(69.72, 2)
    expect(summary.consumption).toBeCloseTo(9.36, 2)
    // Сумма трёх перегонов точнее каждого из них по отдельности.
    expect(summary.errorBound!).toBeLessThan(Math.min(...tankLegs(refuels).map(leg => leg.errorBound)))
  })

  it('делит перегон между месяцами по одометру', () => {
    const legs = tankLegs(refuels)
    // Окно обрывается ровно посередине последнего перегона: 19525 → 19645 — это
    // половина его 240 километров, значит и половина его литров.
    const summary = summariseTankLegs(legs, { startMileage: 19255, endMileage: 19645 })
    expect(summary.distance).toBeCloseTo(390)
    expect(summary.litres).toBeCloseTo(24.21 + 21.2 / 2, 2)
    expect(summary.coverage).toBeCloseTo(1)
  })

  it('считает долю пробега, которую заправки так и не накрыли', () => {
    // Окно шире цепочки: до первой заправки проехали 300 км, о которых перегоны
    // не знают ничего.
    const summary = summariseTankLegs(tankLegs(refuels), { startMileage: 18720, endMileage: 19765 })
    expect(summary.distance).toBe(745)
    expect(summary.coverage).toBeCloseTo(745 / 1045, 3)
    expect(isTankSummaryUsable(summary)).toBe(true)
  })

  it('отказывается отвечать за окно, накрытое меньше чем наполовину', () => {
    const summary = summariseTankLegs(tankLegs(refuels), { startMileage: 17000, endMileage: 19765 })
    expect(summary.consumption).not.toBeNull()
    expect(isTankSummaryUsable(summary)).toBe(false)
  })

  it('не подставляет всю историю месяцу, у которого нет одометра', () => {
    const summary = summariseTankLegs(tankLegs(refuels), { startMileage: null, endMileage: null })
    expect(summary.legs).toBe(0)
    expect(summary.consumption).toBeNull()
    expect(isTankSummaryUsable(summary)).toBe(false)
  })

  it('на пустой цепочке не придумывает расход', () => {
    const summary = summariseTankLegs([])
    expect(summary.consumption).toBeNull()
    expect(summary.legs).toBe(0)
    expect(isTankSummaryUsable(summary)).toBe(false)
  })
})
