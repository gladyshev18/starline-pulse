import { describe, expect, it } from 'vitest'
import { FUEL_TANK_CAPACITY_LITRES, fuelToFull } from '../shared/fuel'

describe('fuelToFull', () => {
  it('calculates how many litres are needed for a 50 litre tank', () => {
    expect(FUEL_TANK_CAPACITY_LITRES).toBe(50)
    expect(fuelToFull(18.4)).toBeCloseTo(31.6)
  })

  it('does not return a negative amount for a full tank', () => {
    expect(fuelToFull(50)).toBe(0)
    expect(fuelToFull(52)).toBe(0)
  })

  it('returns null when the fuel level is unknown', () => {
    expect(fuelToFull(null)).toBeNull()
    expect(fuelToFull(Number.NaN)).toBeNull()
  })
})
