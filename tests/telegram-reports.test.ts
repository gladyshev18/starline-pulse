import { migrate } from 'drizzle-orm/libsql/migrator'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { trips, vehicles } from '../db/schema'
import { normalizeTelegramProxyUrl, normalizeTelegramUsername } from '../worker/config'
import { buildReport, nextReportRun, reportRange } from '../worker/bot/reports'

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

describe('Telegram proxy URL', () => {
  it.each([
    'http://127.0.0.1:8080',
    'https://user:password@proxy.example.com:8443',
    'socks://127.0.0.1:1080',
    'socks5://user:password@127.0.0.1:1080'
  ])('accepts %s', (value) => {
    expect(normalizeTelegramProxyUrl(value)).toBe(value)
  })

  it.each(['ftp://proxy.example.com', 'proxy.example.com:8080', 'not a url'])('rejects %s', (value) => {
    expect(() => normalizeTelegramProxyUrl(value)).toThrow('TELEGRAM_PROXY_URL')
  })

  it('allows proxy to be disabled', () => {
    expect(normalizeTelegramProxyUrl('  ')).toBe('')
  })
})

describe('Telegram report schedule in Moscow time', () => {
  const wednesdayAfternoon = new Date('2026-08-05T13:00:00.000Z') // 16:00 MSK

  it('covers the current Moscow day up to now', () => {
    const range = reportRange('daily', wednesdayAfternoon)
    expect(range.start.toISOString()).toBe('2026-08-04T21:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-08-05T13:00:00.000Z')
    expect(nextReportRun('daily', wednesdayAfternoon).toISOString()).toBe('2026-08-05T18:00:00.000Z')
  })

  it('uses the previous Monday-to-Sunday week', () => {
    const range = reportRange('weekly', wednesdayAfternoon)
    expect(range.start.toISOString()).toBe('2026-07-26T21:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-08-02T21:00:00.000Z')
    expect(nextReportRun('weekly', wednesdayAfternoon).toISOString()).toBe('2026-08-10T18:00:00.000Z')
  })

  it('uses the previous calendar month', () => {
    const range = reportRange('monthly', wednesdayAfternoon)
    expect(range.start.toISOString()).toBe('2026-06-30T21:00:00.000Z')
    expect(range.end.toISOString()).toBe('2026-07-31T21:00:00.000Z')
    expect(nextReportRun('monthly', wednesdayAfternoon).toISOString()).toBe('2026-09-01T18:00:00.000Z')
  })

  it('moves to tomorrow once 21:00 MSK has passed', () => {
    expect(nextReportRun('daily', new Date('2026-08-05T19:00:00.000Z')).toISOString()).toBe('2026-08-06T18:00:00.000Z')
  })
})

describe('Telegram report driver breakdown', () => {
  const evening = new Date('2026-08-05T18:00:00.000Z') // 21:00 MSK

  it('splits the day by driver and keeps unanswered trips last', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Tiggo' }).returning()
    await database.insert(trips).values([
      // Игорь: две поездки, суммарно длиннее.
      { vehicleId: vehicle.id, startedAt: new Date('2026-08-05T05:00:00.000Z'), endedAt: new Date('2026-08-05T05:30:00.000Z'), distance: 30, fuelUsed: 3, driver: 'Игорь', isOpen: false },
      { vehicleId: vehicle.id, startedAt: new Date('2026-08-05T07:00:00.000Z'), endedAt: new Date('2026-08-05T07:30:00.000Z'), distance: 20, fuelUsed: 2, driver: 'Игорь', isOpen: false },
      { vehicleId: vehicle.id, startedAt: new Date('2026-08-05T09:00:00.000Z'), endedAt: new Date('2026-08-05T09:30:00.000Z'), distance: 40, fuelUsed: 4, driver: 'Анна', isOpen: false },
      { vehicleId: vehicle.id, startedAt: new Date('2026-08-05T11:00:00.000Z'), endedAt: new Date('2026-08-05T11:30:00.000Z'), distance: 10, fuelUsed: 1, driver: null, isOpen: false },
      // Вчерашняя поездка в сегодняшний отчёт попасть не должна.
      { vehicleId: vehicle.id, startedAt: new Date('2026-08-04T05:00:00.000Z'), endedAt: new Date('2026-08-04T05:30:00.000Z'), distance: 100, fuelUsed: 9, driver: 'Пётр', isOpen: false }
    ])

    try {
      const report = await buildReport(database, 'daily', evening)
      expect(report).toContain('• 4 поездки · 100,0 км')
      expect(report).toContain('• Игорь: 50,0 км · 2 поездки · 1 ч · 5,0 л · 10,0 л/100 км')
      expect(report).toContain('• Анна: 40,0 км · 1 поездка · 30 мин · 4,0 л · 10,0 л/100 км')
      expect(report).toContain('• Не указан: 10,0 км · 1 поездка · 30 мин · 1,0 л · 10,0 л/100 км')
      expect(report).not.toContain('Пётр')
      expect(report.indexOf('Игорь')).toBeLessThan(report.indexOf('Анна'))
      expect(report.indexOf('Анна')).toBeLessThan(report.indexOf('Не указан'))
    } finally {
      await database.$client.close()
    }
  })

  it('leaves the driver block out when there were no trips', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    await database.insert(vehicles).values({ deviceId: '42', alias: 'Tiggo' })

    try {
      await expect(buildReport(database, 'daily', evening)).resolves.not.toContain('За рулём')
    } finally {
      await database.$client.close()
    }
  })
})
