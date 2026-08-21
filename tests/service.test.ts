import { describe, expect, it } from 'vitest'
import {
  OIL_EQUIVALENT_SPEED_KMH,
  OIL_INTERVAL_KM,
  OIL_INTERVAL_MONTHS,
  OIL_INTERVAL_MOTOR_HOURS,
  kmPerMotorHour,
  oilClockGap,
  oilLife
} from '../shared/service'

describe('oil intervals', () => {
  // The engine-hour figure comes from what oil lasts, not from dividing the
  // distance interval: synthetic holds 250-300 engine-hours in ordinary use and
  // 200-250 in hard use, and this car lives in the hard-use band.
  it('takes the engine-hour interval from the oil, not from the odometer', () => {
    expect(OIL_INTERVAL_KM).toBe(10_000)
    expect(OIL_INTERVAL_MOTOR_HOURS).toBe(250)
    expect(OIL_INTERVAL_MONTHS).toBe(12)
  })

  it('exposes the speed at which the two intervals expire together', () => {
    expect(OIL_EQUIVALENT_SPEED_KMH).toBe(40)
  })
})

describe('oilLife', () => {
  it('is due on whichever clock runs out first', () => {
    // Six thousand kilometres is well inside the interval, but the engine ran
    // 225 hours to cover them: this car crawls, and the oil is nearly spent.
    const crawling = oilLife({ km: 6000, motorHours: 225, months: 5 })
    expect(crawling.binding?.name).toBe('hours')
    expect(crawling.share).toBeCloseTo(0.9)
    expect(crawling.overdue).toBe(false)
  })

  it('leaves the distance in charge for a car that lives on the motorway', () => {
    const motorway = oilLife({ km: 9000, motorHours: 120, months: 4 })
    expect(motorway.binding?.name).toBe('km')
    expect(motorway.share).toBeCloseTo(0.9)
  })

  it('lets the calendar win for a car that barely moves', () => {
    const parked = oilLife({ km: 900, motorHours: 40, months: 11 })
    expect(parked.binding?.name).toBe('months')
  })

  it('reports an overdue service and never a negative remainder', () => {
    const late = oilLife({ km: 13_000, motorHours: 200, months: 8 })
    expect(late.overdue).toBe(true)
    expect(late.binding?.name).toBe('km')
    expect(late.binding?.remaining).toBe(0)
  })

  it('works from whichever clocks are known', () => {
    const partial = oilLife({ km: null, motorHours: null, months: 6 })
    expect(partial.clocks).toHaveLength(1)
    expect(partial.binding?.name).toBe('months')

    const nothing = oilLife({ km: null, motorHours: null, months: null })
    expect(nothing.clocks).toHaveLength(0)
    expect(nothing.binding).toBeNull()
    expect(nothing.share).toBeNull()
    expect(nothing.overdue).toBe(false)
  })
})

describe('oilClockGap', () => {
  it('is positive when engine hours run ahead of the odometer', () => {
    expect(oilClockGap(oilLife({ km: 6000, motorHours: 300, months: 5 }))!).toBeGreaterThan(0)
  })

  it('is negative for a car that covers ground fast', () => {
    expect(oilClockGap(oilLife({ km: 9000, motorHours: 120, months: 4 }))!).toBeLessThan(0)
  })

  it('has nothing to compare when a clock is missing', () => {
    expect(oilClockGap(oilLife({ km: 9000, motorHours: null, months: 4 }))).toBeNull()
  })
})

describe('kmPerMotorHour', () => {
  it('shows the traffic the car actually sits in', () => {
    expect(kmPerMotorHour(612, 14.58)).toBeCloseTo(42, 0)
  })

  it('refuses to divide by an engine that has not run', () => {
    expect(kmPerMotorHour(100, 0)).toBeNull()
    expect(kmPerMotorHour(null, 10)).toBeNull()
    expect(kmPerMotorHour(100, null)).toBeNull()
  })
})
