import { describe, expect, it } from 'vitest'
import { average, linearFit, median, predict } from '../shared/regression'

describe('linearFit', () => {
  it('находит прямую и объявляет её значимой, когда точки на ней лежат', () => {
    const fit = linearFit([
      { x: 0, y: 10 },
      { x: 10, y: 8 },
      { x: 20, y: 6 },
      { x: 30, y: 4 }
    ])!
    expect(fit.slope).toBeCloseTo(-0.2)
    expect(fit.intercept).toBeCloseTo(10)
    expect(fit.r2).toBeCloseTo(1)
    expect(fit.significant).toBe(true)
    expect(predict(fit, 40)).toBeCloseTo(2)
  })

  it('не объявляет значимым наклон, который меньше собственного шума', () => {
    const fit = linearFit([
      { x: 0, y: 5 },
      { x: 1, y: 9 },
      { x: 2, y: 4 },
      { x: 3, y: 8 },
      { x: 4, y: 5 },
      { x: 5, y: 9 }
    ])!
    expect(fit.significant).toBe(false)
    expect(fit.r2).toBeLessThan(0.3)
  })

  it('отказывается считать по двум точкам и по вертикали', () => {
    expect(linearFit([{ x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull()
    expect(linearFit([{ x: 5, y: 1 }, { x: 5, y: 2 }, { x: 5, y: 3 }])).toBeNull()
  })
})

describe('average и median', () => {
  it('считают среднее с его ошибкой', () => {
    const result = average([10, 12, 14])!
    expect(result.mean).toBeCloseTo(12)
    expect(result.error).toBeCloseTo(2 / Math.sqrt(3))
    expect(result.samples).toBe(3)
  })

  it('на одном значении ошибки нет', () => {
    expect(average([7])).toEqual({ mean: 7, error: null, samples: 1 })
    expect(average([])).toBeNull()
  })

  it('берёт медиану чётного ряда как середину между соседями', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([])).toBeNull()
  })
})
