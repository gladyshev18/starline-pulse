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
    })).toEqual({ distance: 12.5, durationMinutes: 75, movingMinutes: 75, fuelUsed: 1.5, consumption: 12, averageSpeed: 10 })
  })

  it('measures speed over the moving time, leaving out the warm-up on the alarm', () => {
    const metrics = calculateTripMetrics({
      startedAt: '2026-08-05T09:00:00.000Z',
      endedAt: '2026-08-05T09:30:00.000Z',
      mileageStart: 100,
      mileageEnd: 115,
      distance: 15,
      fuelStart: null,
      fuelEnd: null,
      fuelUsed: null,
      armedMinutes: 10
    })

    // Тридцать минут зажигания, из них десять — автозапуск на охране: ехать на
    // охране нельзя, значит пятнадцать километров пройдены за двадцать минут.
    expect(metrics.durationMinutes).toBe(30)
    expect(metrics.movingMinutes).toBe(20)
    expect(metrics.averageSpeed).toBe(45)
  })

  it('keeps a fuel reading that dipped below zero on rounding alone', () => {
    // Шаг датчика — половина литра, и разность двух округлённых показаний вполне
    // может уйти в минус. Выбрасывать такие поездки нельзя: тогда в выборке
    // останутся только те, где округление ушло вверх.
    const metrics = calculateTripMetrics({
      startedAt: '2026-08-05T09:00:00.000Z',
      endedAt: '2026-08-05T09:10:00.000Z',
      mileageStart: 100,
      mileageEnd: 103,
      distance: 3,
      fuelStart: 30,
      fuelEnd: 30.5,
      fuelUsed: null
    })

    expect(metrics.fuelUsed).toBeCloseTo(-0.5)
    expect(metrics.consumption).toBeCloseTo(-16.667)
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
    // Литр прибыли в баке — это заправка внутри поездки, а не округление: такой
    // поездке расход не приписать вовсе.
    expect(calculateTripMetrics({
      startedAt: '2026-08-05T10:00:00.000Z',
      endedAt: null,
      mileageStart: 210,
      mileageEnd: 209,
      distance: null,
      fuelStart: 20,
      fuelEnd: 21,
      fuelUsed: null
    })).toEqual({ distance: null, durationMinutes: null, movingMinutes: null, fuelUsed: null, consumption: null, averageSpeed: null })
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
