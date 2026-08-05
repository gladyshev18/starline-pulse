import { describe, expect, it } from 'vitest'
import { hasMileageIncreased } from '../worker/starline/trips'

describe('trip detection by odometer', () => {
  it('starts a trip only when mileage increases', () => {
    expect(hasMileageIncreased(18_590, 18_591)).toBe(true)
    expect(hasMileageIncreased(18_590, 18_590)).toBe(false)
    expect(hasMileageIncreased(18_590, 18_589)).toBe(false)
  })

  it('does not infer a trip when either mileage value is unavailable', () => {
    expect(hasMileageIncreased(null, 18_591)).toBe(false)
    expect(hasMileageIncreased(18_590, null)).toBe(false)
  })
})
