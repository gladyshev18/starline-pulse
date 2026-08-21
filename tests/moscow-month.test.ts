import { describe, expect, it } from 'vitest'
import { currentMoscowMonth, monthTitle, moscowMonthRange, parseMonthInput, shiftMonth } from '../shared/moscow-month'

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

describe('Month arithmetic and titles', () => {
  it.each([
    ['2026-08', 1, '2026-09'],
    ['2026-12', 1, '2027-01'],
    ['2026-01', -1, '2025-12']
  ])('shifts %s by %i', (month, amount, expected) => {
    expect(shiftMonth(month, amount)).toBe(expected)
  })

  it('capitalizes the Russian month name', () => {
    expect(monthTitle('2026-08')).toBe('Август 2026 г.')
  })
})

describe('Month typed into the chat', () => {
  // A Wednesday in August, so a month named without a year has both a past and a
  // future reading available.
  const now = new Date('2026-08-05T13:00:00.000Z')

  it.each([
    ['2026-07', '2026-07'],
    ['2026.07', '2026-07'],
    ['07.2026', '2026-07'],
    ['7/2026', '2026-07'],
    ['июль', '2026-07'],
    ['Июля', '2026-07'],
    ['июнь 2025', '2025-06'],
    ['март', '2026-03'],
    ['мая', '2026-05'],
    ['ноябрь', '2025-11'],
    ['7', '2026-07'],
    ['12', '2025-12'],
    ['прошлый', '2026-07'],
    ['текущий', '2026-08'],
    ['', '2026-08']
  ])('reads %s as %s', (input, expected) => {
    expect(parseMonthInput(input, now)).toBe(expected)
  })

  it.each(['13', '0', 'дурь', '2026', '2026-13', 'ма'])('rejects %s', (input) => {
    expect(parseMonthInput(input, now)).toBeNull()
  })
})
