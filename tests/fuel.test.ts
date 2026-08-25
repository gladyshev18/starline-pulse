import { describe, expect, it } from 'vitest'
import { FUEL_TANK_CAPACITY_LITRES, fuelBalance, fuelFromPercent, fuelToFull } from '../shared/fuel'

describe('fuelBalance', () => {
  const august = { tankStart: 37, tankEnd: 38.5, refuelled: 50, refuelsWithoutVolume: 0, tripsFuelUsed: 40 }

  it('counts the fuel the trip log never attributed to a trip', () => {
    expect(fuelBalance(august)).toMatchObject({ fuelUsed: 48.5, source: 'balance' })
  })

  it('does not treat fuel still sitting in the tank as burned', () => {
    const untouched = fuelBalance({ ...august, tankStart: 20, tankEnd: 70, tripsFuelUsed: 0 })
    expect(untouched.fuelUsed).toBe(0)
  })

  it('keeps the trip total when a refuel of unknown size would inflate it', () => {
    const unknown = fuelBalance({ ...august, refuelsWithoutVolume: 1 })
    expect(unknown).toMatchObject({ fuelUsed: 40, source: 'trips' })
  })

  it('keeps the trip total when the tank level is missing at either end', () => {
    expect(fuelBalance({ ...august, tankStart: null })).toMatchObject({ fuelUsed: 40, source: 'trips' })
    expect(fuelBalance({ ...august, tankEnd: null })).toMatchObject({ fuelUsed: 40, source: 'trips' })
  })

  it('never reports a negative amount when the tank ends fuller than it can explain', () => {
    expect(fuelBalance({ ...august, tankStart: 10, tankEnd: 45, refuelled: 20 }).fuelUsed).toBe(0)
  })
})

describe('fuelFromPercent', () => {
  it('keeps the fraction the API loses by flooring the same percentage', () => {
    expect(fuelFromPercent(77)).toBeCloseTo(39.27)
    expect(fuelFromPercent(32)).toBeCloseTo(16.32)
    expect(fuelFromPercent(100)).toBe(51)
  })

  it('measures a drop at the sensor step instead of whole litres', () => {
    const burned = fuelFromPercent(60)! - fuelFromPercent(53)!
    expect(burned).toBeCloseTo(3.57)
    expect(Math.floor(60 * 0.51) - Math.floor(53 * 0.51)).toBe(3)
  })

  it('clamps readings outside the tank range', () => {
    expect(fuelFromPercent(101)).toBe(51)
    expect(fuelFromPercent(-1)).toBe(0)
  })

  it('returns null when the percentage is unknown', () => {
    expect(fuelFromPercent(null)).toBeNull()
    expect(fuelFromPercent(Number.NaN)).toBeNull()
  })
})

describe('fuelToFull', () => {
  it('calculates how many litres are needed for a 51 litre tank', () => {
    expect(FUEL_TANK_CAPACITY_LITRES).toBe(51)
    expect(fuelToFull(18.4)).toBeCloseTo(32.6)
  })

  it('does not return a negative amount for a full tank', () => {
    expect(fuelToFull(51)).toBe(0)
    expect(fuelToFull(53)).toBe(0)
  })

  it('returns null when the fuel level is unknown', () => {
    expect(fuelToFull(null)).toBeNull()
    expect(fuelToFull(Number.NaN)).toBeNull()
  })
})
