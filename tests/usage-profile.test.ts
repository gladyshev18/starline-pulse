import { describe, expect, it } from 'vitest'
import { summariseStandstill, summariseUsage, weekdayIndex } from '../shared/usage-profile'

describe('weekdayIndex', () => {
  it('переставляет воскресенье SQLite в конец недели', () => {
    expect(weekdayIndex(0)).toBe(6)
    expect(weekdayIndex(1)).toBe(0)
    expect(weekdayIndex(6)).toBe(5)
  })
})

describe('summariseUsage', () => {
  // Как в боевой базе: за август ни одной поездки раньше шести и позже
  // восемнадцати, пик в полдень.
  const august = [
    { weekday: 1, hour: 6, trips: 2, distance: 31 },
    { weekday: 2, hour: 12, trips: 17, distance: 239 },
    { weekday: 3, hour: 18, trips: 1, distance: 2 }
  ]

  it('находит границы дня, в которые машина вообще выезжает', () => {
    const profile = summariseUsage(august)
    expect(profile.fromHour).toBe(6)
    expect(profile.toHour).toBe(18)
  })

  it('называет самый плотный час и день', () => {
    const profile = summariseUsage(august)
    expect(profile.busiestHour).toBe(12)
    expect(profile.busiestWeekday).toBe(1)
    expect(profile.trips).toBe(20)
    expect(profile.distance).toBe(272)
  })

  it('не выдумывает пик там, где поездок нет', () => {
    const profile = summariseUsage([])
    expect(profile.busiestHour).toBeNull()
    expect(profile.fromHour).toBeNull()
    expect(profile.byHour).toHaveLength(24)
  })
})

describe('summariseStandstill', () => {
  it('считает средний и самый долгий простой', () => {
    const standstill = summariseStandstill({ gaps: [1, 5, 69.1], daysWithTrips: 19, daysCovered: 26 })
    expect(standstill.averageHours).toBeCloseTo(25.03, 2)
    expect(standstill.longestHours).toBeCloseTo(69.1, 2)
    expect(standstill.idleDays).toBe(7)
  })

  it('не уводит число дней без поездок в минус', () => {
    expect(summariseStandstill({ gaps: [], daysWithTrips: 5, daysCovered: 3 }).idleDays).toBe(0)
  })
})
