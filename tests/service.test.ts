import { describe, expect, it } from 'vitest'
import {
  OIL_EQUIVALENT_SPEED_KMH,
  OIL_INTERVAL_DAYS,
  OIL_INTERVAL_KM,
  OIL_INTERVAL_MONTHS,
  OIL_INTERVAL_MOTOR_HOURS,
  OIL_KM_PER_DAY,
  OIL_MOTOR_HOURS_PER_DAY,
  kmPerMotorHour,
  oilClockGap,
  oilLife,
  oilPace,
  oilPaceExcess
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

describe('daily norms', () => {
  it('spreads each interval over the calendar year it is meant to last', () => {
    expect(OIL_INTERVAL_DAYS).toBeCloseTo(365.24, 1)
    expect(OIL_KM_PER_DAY).toBeCloseTo(27.4, 1)
    expect(OIL_MOTOR_HOURS_PER_DAY).toBeCloseTo(0.68, 2)
  })
})

describe('oilPace', () => {
  const now = new Date('2026-09-03T12:00:00Z')

  it('measures the daily pace against the norm the interval implies', () => {
    // 4000 км за 100 дней — сорок в сутки при норме двадцать семь.
    const pace = oilPace(oilLife({ km: 4000, motorHours: 100, months: 100 / 30.437 }), 100, now)!
    const km = pace.clocks.find(item => item.name === 'km')!
    expect(km.perDay).toBeCloseTo(40)
    expect(km.normPerDay).toBeCloseTo(OIL_KM_PER_DAY)
    expect(km.ratio).toBeCloseTo(40 / OIL_KM_PER_DAY, 3)
  })

  // «На сколько пробег обгоняет время» и «на сколько темп выше нормы» — одно и
  // то же число, и это должно оставаться правдой, а не совпадением.
  it('reads the same whether you compare paces or shares of the interval', () => {
    const life = oilLife({ km: 4000, motorHours: 100, months: 100 / 30.437 })
    const pace = oilPace(life, 100, now)!
    const kmShare = life.clocks.find(item => item.name === 'km')!.share
    const monthShare = life.clocks.find(item => item.name === 'months')!.share
    expect(oilPaceExcess(pace, 'km')!).toBeCloseTo(kmShare / monthShare - 1, 6)
  })

  it('leaves the calendar exactly on its own norm', () => {
    const pace = oilPace(oilLife({ km: 4000, motorHours: 100, months: 100 / 30.437 }), 100, now)!
    expect(pace.clocks.find(item => item.name === 'months')!.ratio).toBeCloseTo(1, 6)
    expect(oilPaceExcess(pace, 'months')!).toBeCloseTo(0, 6)
  })

  it('projects the date on whichever clock runs out first at this pace', () => {
    // Сорок километров в сутки: шесть тысяч остатка — сто пятьдесят дней, и это
    // раньше, чем истечёт год.
    const pace = oilPace(oilLife({ km: 4000, motorHours: 100, months: 100 / 30.437 }), 100, now)!
    expect(pace.binding?.name).toBe('km')
    expect(pace.daysLeft).toBeCloseTo(150, 0)
    expect(pace.dueAt!.getTime()).toBeCloseTo(now.getTime() + 150 * 24 * 60 * 60_000, -7)
  })

  // Дальше всех прошла та шкала, что ближе к концу сегодня; кончится первой —
  // та, что быстрее идёт. Это разные шкалы, и прогноз обязан брать вторую.
  it('does not confuse the clock that is furthest along with the one that will finish first', () => {
    const life = oilLife({ km: 2000, motorHours: 60, months: 10 })
    expect(life.binding?.name).toBe('months')
    const pace = oilPace(life, 10 * 30.437, now)!
    expect(pace.binding?.name).toBe('months')

    // Та же машина, но за те же десять месяцев проехавшая девять тысяч: остаток
    // километров теперь кончится намного раньше календаря.
    const busy = oilPace(oilLife({ km: 9000, motorHours: 200, months: 10 }), 10 * 30.437, now)!
    expect(busy.binding?.name).toBe('km')
  })

  it('says how much may be driven per day to reach the calendar date', () => {
    const pace = oilPace(oilLife({ km: 4000, motorHours: 100, months: 100 / 30.437 }), 100, now)!
    const km = pace.clocks.find(item => item.name === 'km')!
    expect(km.allowancePerDay).toBeCloseTo(6000 / (OIL_INTERVAL_DAYS - 100), 3)
    // Ехать можно вчетверо меньше, чем сейчас, — потому и запись к сроку.
    expect(km.allowancePerDay!).toBeLessThan(km.perDay)
  })

  it('has no allowance and no distance forecast for a car standing still past its date', () => {
    const pace = oilPace(oilLife({ km: 500, motorHours: 20, months: 14 }), 14 * 30.437, now)!
    expect(pace.clocks.find(item => item.name === 'km')!.allowancePerDay).toBeNull()
    // Календарь уже вышел, и он же держит прогноз на сегодня.
    expect(pace.daysLeft).toBe(0)
  })

  it('refuses to extrapolate from the first hours after a service', () => {
    expect(oilPace(oilLife({ km: 40, motorHours: 1, months: 0 }), 0.08, now)).toBeNull()
    expect(oilPace(oilLife({ km: null, motorHours: null, months: null }), 30, now)).toBeNull()
  })

  it('never promises a date for a clock that is not moving', () => {
    const parked = oilPace(oilLife({ km: 0, motorHours: 0, months: 3 }), 3 * 30.437, now)!
    expect(parked.clocks.find(item => item.name === 'km')!.daysLeft).toBeNull()
    // Календарь идёт всегда, поэтому именно он и остаётся прогнозом.
    expect(parked.binding?.name).toBe('months')
  })
})
