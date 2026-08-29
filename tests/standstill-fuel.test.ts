import { describe, expect, it } from 'vitest'
import { measureStandstillFuel } from '../shared/standstill-fuel'

// Восемнадцать стоянок дольше шести часов из боевой базы за август: десять без
// изменений, семь по одной ступеньке датчика вниз, одна — две ступеньки.
const august = [
  { hours: 64.3, delta: 0.51 }, { hours: 22.8, delta: 1.02 }, { hours: 38.6, delta: 0.51 },
  { hours: 28.6, delta: 0.51 }, { hours: 18.5, delta: 0.51 }, { hours: 16.2, delta: 0.51 },
  { hours: 19.7, delta: 0 }, { hours: 25.4, delta: 0 }, { hours: 22, delta: 0 },
  { hours: 68.7, delta: 0 }, { hours: 22.5, delta: 0 }, { hours: 17.9, delta: 0.51 },
  { hours: 21.7, delta: 0 }, { hours: 39.5, delta: 0.51 }, { hours: 19, delta: 0 },
  { hours: 18.7, delta: 0 }, { hours: 23.8, delta: 0 }, { hours: 20.4, delta: 0 }
]

describe('measureStandstillFuel', () => {
  it('считает стороны, а не литры', () => {
    const measured = measureStandstillFuel(august)
    expect(measured.samples).toBe(18)
    expect(measured.drops).toBe(8)
    expect(measured.rises).toBe(0)
    expect(measured.unchanged).toBe(10)
  })

  it('объявляет убыль систематической, когда роста не случилось ни разу', () => {
    const measured = measureStandstillFuel(august)
    expect(measured.probability).toBeCloseTo(0.0039, 4)
    expect(measured.systematic).toBe(true)
    expect(measured.total).toBeCloseTo(4.59, 2)
    expect(measured.average).toBeCloseTo(0.255, 3)
  })

  it('молчит, когда падения и рост идут вперемешку', () => {
    const noise = [
      { hours: 12, delta: 0.51 }, { hours: 12, delta: -0.51 }, { hours: 12, delta: 0.51 },
      { hours: 12, delta: -0.51 }, { hours: 12, delta: 0 }, { hours: 12, delta: 0.51 }
    ]
    const measured = measureStandstillFuel(noise)
    expect(measured.drops).toBe(3)
    expect(measured.rises).toBe(2)
    expect(measured.systematic).toBe(false)
  })

  it('не верит трём падениям подряд, хотя монета и даёт им 0,125', () => {
    const few = [{ hours: 12, delta: 0.51 }, { hours: 12, delta: 0.51 }, { hours: 12, delta: 0.51 }]
    expect(measureStandstillFuel(few).systematic).toBe(false)
  })

  it('выбрасывает короткие простои: уровню там не на что отвечать', () => {
    const measured = measureStandstillFuel([{ hours: 1, delta: 0.51 }, { hours: 20, delta: 0.51 }])
    expect(measured.samples).toBe(1)
  })

  it('переживает месяц без единой стоянки', () => {
    const measured = measureStandstillFuel([])
    expect(measured).toMatchObject({ samples: 0, average: null, perHour: null, systematic: false })
  })
})
