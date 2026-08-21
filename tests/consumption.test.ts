import { describe, expect, it } from 'vitest'
import { averageSpeed, bucketForSpeed, costPerKilometre, summariseBySpeed } from '../shared/consumption'

describe('averageSpeed', () => {
  it('is distance over time, because nothing else in the data is', () => {
    expect(averageSpeed({ distance: 30, fuelUsed: 2, durationMinutes: 30 })).toBe(60)
  })

  it('has no answer for a trip that stood still or was never timed', () => {
    expect(averageSpeed({ distance: 0, fuelUsed: 1, durationMinutes: 20 })).toBeNull()
    expect(averageSpeed({ distance: 10, fuelUsed: 1, durationMinutes: 0 })).toBeNull()
    expect(averageSpeed({ distance: 10, fuelUsed: 1, durationMinutes: null })).toBeNull()
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
