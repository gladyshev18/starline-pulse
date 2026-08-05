import { describe, expect, it } from 'vitest'
import { currentMoscowMonth, moscowMonthRange } from '../server/utils/moscow-month'

describe('Moscow month range', () => {
  it('converts a calendar month to exact UTC boundaries', () => {
    const range = moscowMonthRange('2026-08')

    expect(range?.start.toISOString()).toBe('2026-07-31T21:00:00.000Z')
    expect(range?.end.toISOString()).toBe('2026-08-31T21:00:00.000Z')
    expect(range?.days).toBe(31)
  })

  it('uses Moscow time when determining the current month', () => {
    expect(currentMoscowMonth(new Date('2026-07-31T22:30:00.000Z'))).toBe('2026-08')
  })

  it.each(['2026-00', '2026-13', '08.2026', ''])('rejects invalid month %s', (value) => {
    expect(moscowMonthRange(value)).toBeNull()
  })
})
