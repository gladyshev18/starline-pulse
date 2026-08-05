import { describe, expect, it } from 'vitest'
import { normalizeTelegramUsername } from '../worker/config'
import { completedReportRange, nextReportRun } from '../worker/bot/reports'

describe('Telegram username normalization', () => {
  it.each([
    [' @Gladyshev ', '@gladyshev'],
    ['family_user', '@family_user'],
    ['@User1', '@user1']
  ])('normalizes %s', (value, expected) => {
    expect(normalizeTelegramUsername(value)).toBe(expected)
  })

  it.each(['@a', '@bad-name', '@привет', '', undefined])('rejects invalid username %s', (value) => {
    expect(normalizeTelegramUsername(value)).toBeNull()
  })
})

describe('Telegram report schedule in Moscow time', () => {
  const wednesdayAfterReport = new Date('2026-08-05T07:00:00.000Z') // 10:00 MSK

  it('uses the previous completed Moscow day', () => {
    const range = completedReportRange('daily', wednesdayAfterReport)
    expect(range.start.toISOString()).toBe('2026-08-03T21:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-08-04T21:00:00.000Z')
    expect(nextReportRun('daily', wednesdayAfterReport).toISOString()).toBe('2026-08-06T06:00:00.000Z')
  })

  it('uses the previous Monday-to-Sunday week', () => {
    const range = completedReportRange('weekly', wednesdayAfterReport)
    expect(range.start.toISOString()).toBe('2026-07-26T21:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-08-02T21:00:00.000Z')
    expect(nextReportRun('weekly', wednesdayAfterReport).toISOString()).toBe('2026-08-10T06:00:00.000Z')
  })

  it('uses the previous calendar month', () => {
    const range = completedReportRange('monthly', wednesdayAfterReport)
    expect(range.start.toISOString()).toBe('2026-06-30T21:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-07-31T21:00:00.000Z')
    expect(nextReportRun('monthly', wednesdayAfterReport).toISOString()).toBe('2026-09-01T06:00:00.000Z')
  })

  it('keeps today when 09:00 MSK has not arrived yet', () => {
    expect(nextReportRun('daily', new Date('2026-08-05T05:00:00.000Z')).toISOString()).toBe('2026-08-05T06:00:00.000Z')
  })
})
