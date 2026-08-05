import { describe, expect, it } from 'vitest'
import { moscowDayRange } from '../server/utils/moscow-day'

describe('Moscow day range', () => {
  it('converts a calendar day to exact UTC boundaries', () => {
    const range = moscowDayRange('2026-08-05')

    expect(range?.start.toISOString()).toBe('2026-08-04T21:00:00.000Z')
    expect(range?.end.toISOString()).toBe('2026-08-05T21:00:00.000Z')
  })

  it.each(['2026-02-29', '2026-13-01', '05.08.2026', '', undefined])('rejects invalid day %s', (value) => {
    expect(moscowDayRange(value)).toBeNull()
  })
})
