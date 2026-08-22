import { describe, expect, it } from 'vitest'
import { hasNamedDriver, summariseByDriver } from '../shared/drivers'

const row = (driver: string | null, distance: number, fuelUsed = 0, trips = 1, minutes = 30) =>
  ({ driver, trips, distance, fuelUsed, minutes })

describe('Разбивка поездок по водителям', () => {
  it('ставит того, кто наездил больше, выше', () => {
    const rows = summariseByDriver([row('Анна', 40), row('Игорь', 50)])

    expect(rows.map(item => item.driver)).toEqual(['Игорь', 'Анна'])
  })

  it('уводит поездки без ответа вниз, даже если их больше всех', () => {
    const rows = summariseByDriver([row(null, 500), row('Игорь', 50)])

    expect(rows.map(item => item.driver)).toEqual(['Игорь', null])
  })

  it('сводит одно и то же имя в одну строку', () => {
    const rows = summariseByDriver([row('Игорь', 30, 3), row(' Игорь ', 20, 2)])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.distance).toBe(50)
    expect(rows[0]!.trips).toBe(2)
    expect(rows[0]!.consumption).toBe(10)
  })

  it('считает пустое имя тем же, что и отсутствие ответа', () => {
    const rows = summariseByDriver([row('', 10), row(null, 10)])

    expect(rows).toHaveLength(1)
    expect(rows[0]!.driver).toBeNull()
    expect(rows[0]!.distance).toBe(20)
  })

  it('делит пробег на доли, которые вместе дают целое', () => {
    const rows = summariseByDriver([row('Игорь', 75), row('Анна', 25)])

    expect(rows[0]!.share).toBe(0.75)
    expect(rows.reduce((sum, item) => sum + item.share, 0)).toBe(1)
  })

  it('не выдумывает расход там, где литров нет', () => {
    expect(summariseByDriver([row('Игорь', 40)])[0]!.consumption).toBeNull()
    expect(summariseByDriver([row('Игорь', 0, 2)])[0]!.consumption).toBeNull()
  })

  it('отличает разбивку от одной строки «не указан»', () => {
    expect(hasNamedDriver(summariseByDriver([row(null, 10)]))).toBe(false)
    expect(hasNamedDriver(summariseByDriver([row(null, 10), row('Игорь', 1)]))).toBe(true)
    expect(hasNamedDriver(summariseByDriver([]))).toBe(false)
  })
})
