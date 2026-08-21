import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IDLE_LITRES_PER_HOUR,
  FUEL_SENSOR_STEP_LITRES,
  idleCost,
  isColdStart,
  measureIdleRate
} from '../shared/idle-cost'

// Sessions long enough and numerous enough that the sensor's rounding no longer
// swamps the drop: 40 sessions of half an hour burning 0.6 litres each.
function longSample(count: number, litresPerHour: number) {
  return Array.from({ length: count }, () => ({
    durationMinutes: 30,
    fuelStart: 40,
    fuelEnd: 40 - litresPerHour / 2
  }))
}

describe('measureIdleRate', () => {
  it('reads the rate off the car once the drop outgrows the rounding', () => {
    const rate = measureIdleRate(longSample(40, 0.7))
    expect(rate.source).toBe('measured')
    expect(rate.litresPerHour).toBeCloseTo(0.7)
    expect(rate.minutes).toBe(1200)
  })

  it('falls back while a handful of sessions can be explained by rounding alone', () => {
    // What the car actually had after a fortnight: 23 sessions, 129 minutes and
    // a 1.5 litre drop — three sensor steps, which the rounding of 46 readings
    // can produce on its own.
    const fortnight = measureIdleRate([
      ...Array.from({ length: 20 }, () => ({ durationMinutes: 5, fuelStart: 40, fuelEnd: 40 })),
      ...Array.from({ length: 3 }, () => ({ durationMinutes: 9.8, fuelStart: 40, fuelEnd: 39.5 }))
    ])
    expect(fortnight.source).toBe('default')
    expect(fortnight.litresPerHour).toBe(DEFAULT_IDLE_LITRES_PER_HOUR)
    // The sample is still reported so the interface can say how far off it is.
    expect(fortnight.sessions).toBe(23)
    expect(fortnight.litres).toBeCloseTo(1.5)
  })

  it('never publishes an error bar for the stand-in rate', () => {
    expect(measureIdleRate([]).uncertaintyLitresPerHour).toBeNull()
    expect(measureIdleRate(longSample(40, 0.7)).uncertaintyLitresPerHour).toBeGreaterThan(0)
  })

  it('rejects a rate no idling engine could produce', () => {
    expect(measureIdleRate(longSample(40, 8)).source).toBe('default')
    expect(measureIdleRate(longSample(40, 0.05)).source).toBe('default')
  })

  it('drops sessions a refuel landed inside', () => {
    const withPump = measureIdleRate([
      ...longSample(40, 0.7),
      { durationMinutes: 12, fuelStart: 20, fuelEnd: 50 }
    ])
    expect(withPump.sessions).toBe(40)
    expect(withPump.litresPerHour).toBeCloseTo(0.7)
  })

  it('ignores sessions without both readings or without a duration', () => {
    const partial = measureIdleRate([
      { durationMinutes: 10, fuelStart: null, fuelEnd: 39 },
      { durationMinutes: 10, fuelStart: 40, fuelEnd: null },
      { durationMinutes: null, fuelStart: 40, fuelEnd: 39 },
      { durationMinutes: 0, fuelStart: 40, fuelEnd: 39 }
    ])
    expect(partial).toMatchObject({ sessions: 0, minutes: 0, source: 'default' })
  })

  it('keeps the sensor step tied to one percent of the tank', () => {
    expect(FUEL_SENSOR_STEP_LITRES).toBe(0.5)
  })
})

describe('idleCost', () => {
  const measured = measureIdleRate(longSample(40, 0.6))

  it('prices the fuel an hour of standing burns', () => {
    const cost = idleCost({ minutes: 120, rate: measured, pricePerLitre: 60 })
    expect(cost.litres).toBeCloseTo(1.2)
    expect(cost.cost).toBeCloseTo(72)
  })

  it('still reports the litres when no receipt has priced them', () => {
    const cost = idleCost({ minutes: 120, rate: measured, pricePerLitre: null })
    expect(cost.litres).toBeCloseTo(1.2)
    expect(cost.cost).toBeNull()
    expect(cost.costUncertainty).toBeNull()
  })

  it('carries the rate uncertainty through to the roubles', () => {
    const cost = idleCost({ minutes: 120, rate: measured, pricePerLitre: 60 })
    expect(cost.litresUncertainty).toBeCloseTo(2 * measured.uncertaintyLitresPerHour!)
    expect(cost.costUncertainty).toBeCloseTo(cost.litresUncertainty! * 60)
  })

  it('leaves no error bar when the rate is a stand-in', () => {
    const guessed = idleCost({ minutes: 120, rate: measureIdleRate([]), pricePerLitre: 60 })
    expect(guessed.litres).toBeCloseTo(DEFAULT_IDLE_LITRES_PER_HOUR * 2)
    expect(guessed.litresUncertainty).toBeNull()
    expect(guessed.costUncertainty).toBeNull()
  })

  it('treats a missing or nonsensical price as no price', () => {
    expect(idleCost({ minutes: 60, rate: measured, pricePerLitre: 0 }).cost).toBeNull()
    expect(idleCost({ minutes: 60, rate: measured, pricePerLitre: Number.NaN }).cost).toBeNull()
  })

  it('never turns a negative duration into a negative bill', () => {
    expect(idleCost({ minutes: -30, rate: measured, pricePerLitre: 60 })).toMatchObject({ minutes: 0, litres: 0, cost: 0 })
  })
})

describe('isColdStart', () => {
  it('calls a genuinely cooled engine a cold start', () => {
    expect(isColdStart(24)).toBe(true)
    expect(isColdStart(23)).toBe(true)
  })

  it('does not count a restart minutes after a trip', () => {
    expect(isColdStart(88)).toBe(false)
    expect(isColdStart(70)).toBe(false)
  })

  it('stays undecided when the coolant reading is missing', () => {
    expect(isColdStart(null)).toBeNull()
    expect(isColdStart(undefined)).toBeNull()
    expect(isColdStart(Number.NaN)).toBeNull()
  })
})
