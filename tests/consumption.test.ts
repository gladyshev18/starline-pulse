import { describe, expect, it } from 'vitest'
import { averageSpeed, bucketForSpeed, costPerKilometre, movingMinutes, summariseBySpeed, tripCost } from '../shared/consumption'

describe('averageSpeed', () => {
  it('is distance over time, because nothing else in the data is', () => {
    expect(averageSpeed({ distance: 30, fuelUsed: 2, durationMinutes: 30 })).toBe(60)
  })

  it('has no answer for a trip that stood still or was never timed', () => {
    expect(averageSpeed({ distance: 0, fuelUsed: 1, durationMinutes: 20 })).toBeNull()
    expect(averageSpeed({ distance: 10, fuelUsed: 1, durationMinutes: 0 })).toBeNull()
    expect(averageSpeed({ distance: 10, fuelUsed: 1, durationMinutes: null })).toBeNull()
  })

  it('leaves out the minutes the engine ran on the alarm', () => {
    // Прогрев по автозапуску — единственный отрезок внутри поездки, про который
    // данные точно говорят, что машина стояла: на охране ехать нельзя.
    expect(averageSpeed({ distance: 30, fuelUsed: 2, durationMinutes: 40, armedMinutes: 10 })).toBe(60)
    expect(averageSpeed({ distance: 30, fuelUsed: 2, durationMinutes: 30, armedMinutes: null })).toBe(60)
  })

  it('has no answer for a trip that was warming up the whole time', () => {
    expect(averageSpeed({ distance: 5, fuelUsed: 1, durationMinutes: 20, armedMinutes: 20 })).toBeNull()
  })
})

describe('movingMinutes', () => {
  it('never goes below zero when the armed minutes overrun the trip', () => {
    expect(movingMinutes({ distance: 1, fuelUsed: 0, durationMinutes: 5, armedMinutes: 9 })).toBe(0)
  })
})

describe('bucketForSpeed', () => {
  it.each([
    [10, 'jam'],
    [24.9, 'jam'],
    [25, 'city'],
    [44.9, 'city'],
    [45, 'mixed'],
    [69.9, 'mixed'],
    [70, 'highway'],
    [130, 'highway']
  ])('puts %s km/h in %s', (speed, name) => {
    expect(bucketForSpeed(speed)?.name).toBe(name)
  })

  it('refuses to classify a speed it does not have', () => {
    expect(bucketForSpeed(null)).toBeNull()
    expect(bucketForSpeed(0)).toBeNull()
    expect(bucketForSpeed(Number.NaN)).toBeNull()
  })
})

describe('summariseBySpeed', () => {
  const trips = [
    // Two crawls: 24 km burning 4.5 l between them.
    { distance: 10, fuelUsed: 2, durationMinutes: 40 },
    { distance: 14, fuelUsed: 2.5, durationMinutes: 45 },
    // One motorway run.
    { distance: 100, fuelUsed: 5, durationMinutes: 70 }
  ]

  it('divides the sums, not the trips', () => {
    const buckets = summariseBySpeed(trips)
    const jam = buckets.find(item => item.name === 'jam')!
    expect(jam).toMatchObject({ trips: 2, distance: 24, fuelUsed: 4.5 })
    expect(jam.consumption).toBeCloseTo(18.75)
    expect(buckets.find(item => item.name === 'highway')!.consumption).toBeCloseTo(5)
  })

  it('keeps every bucket so an empty one stays visible', () => {
    const buckets = summariseBySpeed(trips)
    expect(buckets).toHaveLength(4)
    expect(buckets.find(item => item.name === 'city')).toMatchObject({ trips: 0, consumption: null })
  })

  it('carries an error bar that grows with the number of trips, not their length', () => {
    const buckets = summariseBySpeed(trips)
    // Литр каждой поездки — разность двух показаний с шагом 0,5 л, то есть
    // 0,5/√12·√2 ≈ 0,204 л на поездку. На двух поездках это 0,289 л, и на 24 км
    // выходит 1,2 л/100 км — против 18,75 л/100 км самой оценки.
    expect(buckets.find(item => item.name === 'jam')!.consumptionUncertainty).toBeCloseTo(1.2, 1)
    // Сотня километров одной поездкой размывает ту же ошибку куда сильнее.
    expect(buckets.find(item => item.name === 'highway')!.consumptionUncertainty).toBeCloseTo(0.2, 1)
    expect(buckets.find(item => item.name === 'city')!.consumptionUncertainty).toBeNull()
  })

  it('keeps a trip whose fuel reading dipped below zero on rounding', () => {
    // Такая поездка попадает в сумму со своим минусом. Выбросить её значило бы
    // оставить в корзине только те поездки, где округление ушло вверх.
    const buckets = summariseBySpeed([
      ...trips,
      { distance: 4, fuelUsed: -0.5, durationMinutes: 20 }
    ])
    const jam = buckets.find(item => item.name === 'jam')!
    expect(jam).toMatchObject({ trips: 3, distance: 28 })
    expect(jam.fuelUsed).toBeCloseTo(4)
  })

  it('leaves out trips with nothing to divide', () => {
    const buckets = summariseBySpeed([
      ...trips,
      { distance: 20, fuelUsed: null, durationMinutes: 30 },
      { distance: null, fuelUsed: 2, durationMinutes: 30 },
      { distance: 20, fuelUsed: 2, durationMinutes: null }
    ])
    expect(buckets.reduce((sum, item) => sum + item.trips, 0)).toBe(3)
  })
})

describe('tripCost', () => {
  it('prices a trip by the kilometre of its month', () => {
    expect(tripCost(23, 6.36)).toBeCloseTo(146.28, 2)
  })

  it('has no answer without a distance or a price', () => {
    expect(tripCost(null, 6.36)).toBeNull()
    expect(tripCost(23, null)).toBeNull()
    expect(tripCost(0, 6.36)).toBeNull()
    expect(tripCost(23, 0)).toBeNull()
  })

  it('sums back to what the month burned', () => {
    // Ради этого стоимость и считается через километр, а не через литры самой
    // поездки: у половины поездок расход тонет в округлении датчика, а в сумме
    // деньги обязаны сойтись с баком.
    const distances = [23, 117, 5, 2, 0.5]
    const monthDistance = distances.reduce((sum, value) => sum + value, 0)
    const monthFuel = 61.31
    const price = 69.12
    const perKm = costPerKilometre(monthFuel, monthDistance, price)!
    const total = distances.reduce((sum, distance) => sum + (tripCost(distance, perKm) ?? 0), 0)
    expect(total).toBeCloseTo(monthFuel * price, 6)
  })
})

describe('costPerKilometre', () => {
  it('prices the litres the balance says were burned', () => {
    expect(costPerKilometre(44.5, 612, 67.55)).toBeCloseTo(4.91, 2)
  })

  it('says nothing when a piece is missing', () => {
    expect(costPerKilometre(null, 612, 67.55)).toBeNull()
    expect(costPerKilometre(44.5, null, 67.55)).toBeNull()
    expect(costPerKilometre(44.5, 612, null)).toBeNull()
    expect(costPerKilometre(44.5, 0, 67.55)).toBeNull()
  })
})
