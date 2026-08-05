import { describe, expect, it } from 'vitest'
import { calculateTripMetrics } from '../shared/trip-metrics'

describe('trip metrics', () => {
  it('calculates duration and average fuel consumption for a completed trip', () => {
    expect(calculateTripMetrics({
      startedAt: new Date('2026-08-05T09:00:00.000Z'),
      endedAt: new Date('2026-08-05T10:15:00.000Z'),
      mileageStart: 100,
      mileageEnd: 112.5,
      distance: 12.5,
      fuelStart: 30,
      fuelEnd: 28.5,
      fuelUsed: 1.5
    })).toEqual({ distance: 12.5, durationMinutes: 75, fuelUsed: 1.5, consumption: 12, averageSpeed: 10 })
  })

  it('uses odometer and fuel readings when stored totals are missing', () => {
    const metrics = calculateTripMetrics({
      startedAt: '2026-08-05T09:00:00.000Z',
      endedAt: '2026-08-05T09:30:00.000Z',
      mileageStart: 200,
      mileageEnd: 210,
      distance: null,
      fuelStart: 25,
      fuelEnd: 24.2,
      fuelUsed: null
    })

    expect(metrics).toMatchObject({ distance: 10, durationMinutes: 30 })
    expect(metrics.fuelUsed).toBeCloseTo(0.8)
    expect(metrics.consumption).toBeCloseTo(8)
    expect(metrics.averageSpeed).toBeCloseTo(20)
  })

  it('does not calculate metrics from incomplete or decreasing readings', () => {
    expect(calculateTripMetrics({
      startedAt: '2026-08-05T10:00:00.000Z',
      endedAt: null,
      mileageStart: 210,
      mileageEnd: 209,
      distance: null,
      fuelStart: 20,
      fuelEnd: 21,
      fuelUsed: null
    })).toEqual({ distance: null, durationMinutes: null, fuelUsed: null, consumption: null, averageSpeed: null })
  })

  it('does not calculate average speed for a trip with zero duration', () => {
    expect(calculateTripMetrics({
      startedAt: '2026-08-05T10:00:00.000Z',
      endedAt: '2026-08-05T10:00:00.000Z',
      mileageStart: null,
      mileageEnd: null,
      distance: 1,
      fuelStart: null,
      fuelEnd: null,
      fuelUsed: null
    }).averageSpeed).toBeNull()
  })
})
