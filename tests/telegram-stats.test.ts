import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { refuelEvents, trips, vehicleSnapshots, vehicles } from '../db/schema'
import { barChart, dayScale, sparkline } from '../shared/text-chart'
import { buildMonthStats, statsKeyboard } from '../worker/bot/stats'

describe('Text charts for a Telegram message', () => {
  it('draws a day as a block scaled against the busiest one', () => {
    expect(sparkline([0, 20, 45, 80])).toBe('·▃▅█')
  })

  it('keeps a flat month readable instead of dividing by zero', () => {
    expect(sparkline([0, 0, 0])).toBe('···')
  })

  it('puts every day number under its own column', () => {
    const scale = dayScale(31)

    expect(scale.slice(0, 1)).toBe('1')
    expect(scale.slice(4, 5)).toBe('5')
    expect(scale.slice(9, 11)).toBe('10')
    expect(scale.slice(29, 31)).toBe('30')
  })

  it('aligns labels, tracks and values into columns', () => {
    const rows = barChart([
      { label: 'Пробки', value: 18.8, note: '18,8' },
      { label: 'Трасса', value: 5.1, note: '5,1' }
    ], 10)

    expect(rows[0]).toBe('Пробки ██████████ 18,8')
    expect(rows[1]).toBe('Трасса ███░░░░░░░  5,1')
  })

  it('never leaves an empty track next to a non-zero value', () => {
    const rows = barChart([{ label: 'a', value: 100, note: '' }, { label: 'b', value: 0.4, note: '' }], 10)

    expect(rows[1]).toContain('█')
  })
})

const now = new Date('2026-08-20T09:00:00.000Z')

async function setup(withDrivers = true) {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Автомобиль' }).returning()
  const vehicleId = vehicle!.id

  const trip = (day: number, distance: number, fuelUsed: number, driver: string | null = null) => {
    const startedAt = new Date(`2026-08-${String(day).padStart(2, '0')}T09:00:00.000Z`)
    return {
      vehicleId,
      startedAt,
      endedAt: new Date(startedAt.getTime() + 60 * 60_000),
      distance,
      fuelUsed,
      driver: withDrivers ? driver : null,
      isOpen: false
    }
  }
  await database.insert(trips).values([trip(3, 20, 3.5), trip(4, 45, 4, 'Анна'), trip(12, 80, 4.5, 'Игорь')])

  await database.insert(vehicleSnapshots).values([
    // The last reading before the month starts is what the tank balance opens on.
    { vehicleId, ts: new Date('2026-07-31T20:00:00.000Z'), fuel: 40, mileage: 18000, rawJson: '{}' },
    { vehicleId, ts: new Date('2026-08-15T09:00:00.000Z'), fuel: 46, mileage: 18145, rawJson: '{}' }
  ])

  await database.insert(refuelEvents).values({
    vehicleId,
    detectedAt: new Date('2026-08-10T09:00:00.000Z'),
    litresAdded: 20,
    totalAmount: 1500,
    pricePerLitre: 75
  })

  return database
}

describe('Telegram statistics message', () => {
  it('reports the month the statistics page reports', async () => {
    const stats = await buildMonthStats(await setup(), '2026-08', now)

    expect(stats?.text).toContain('📊 <b>Статистика · Автомобиль</b>')
    expect(stats?.text).toContain('Август 2026 г. · по 20-е число')
    expect(stats?.text).toContain('🛣 Пробег: <b>145,0 км</b> · 3 поездки')
    // 40 l in the tank, 20 poured in, 46 left: fourteen litres went through the
    // engine, not the twelve the trips managed to see.
    expect(stats?.text).toContain('⛽ Израсходовано: <b>14,0 л</b>')
    expect(stats?.text).toContain('Литры — по баку: 40,0 л → 46,0 л, заправлено 20,0 л')
    expect(stats?.text).toContain('🛢 Заправки: 1 · 20,0 л')
    // Intl groups thousands with a non-breaking space in Russian, so the
    // separator is matched rather than typed.
    expect(stats?.text).toMatch(/Одометр: 18.000 → 18.145 км · \+145/)
  })

  it('draws the month as a skyline trimmed to the days that have happened', async () => {
    const stats = await buildMonthStats(await setup(), '2026-08', now)
    const chart = stats!.text.match(/<pre>([^<]+)<\/pre>/)![1]!.split('\n')

    expect(chart[0]).toBe('··▃▅·······█········')
    expect(chart[0]!.length).toBe(20)
    expect(chart[1]).toBe(dayScale(20))
    expect(stats?.text).toContain('максимум 80,0 км 12-го')
  })

  it('splits the fuel by the kind of driving each trip was', async () => {
    const stats = await buildMonthStats(await setup(), '2026-08', now)

    expect(stats?.text).toContain('Куда уходит бензин, л/100 км')
    expect(stats?.text).toContain('Пробки')
    expect(stats?.text).toContain('Трасса')
  })

  it('splits the month by who was behind the wheel', async () => {
    const stats = await buildMonthStats(await setup(), '2026-08', now)
    const drivers = stats!.text.match(/<b>За рулём, км<\/b>\n<pre>([^<]+)<\/pre>/)![1]!.split('\n')

    expect(drivers[0]).toContain('Игорь')
    expect(drivers[0]).toContain('80 км')
    expect(drivers[1]).toContain('Анна')
    // Поездка без ответа стоит последней, хотя её километры не самые маленькие.
    expect(drivers[2]).toContain('Не указан')
    expect(stats?.text).toContain('Расход, л/100 км: Игорь — 5,6 · Анна — 8,9 · не указан — 17,5')
  })

  it('leaves the driver block out until someone is named', async () => {
    const stats = await buildMonthStats(await setup(false), '2026-08', now)

    expect(stats?.text).not.toContain('За рулём')
    // Остальные разделы месяц без водителей не теряет.
    expect(stats?.text).toContain('Куда уходит бензин')
  })

  it('says so plainly when a month holds nothing', async () => {
    const stats = await buildMonthStats(await setup(), '2026-02', now)

    expect(stats?.text).toContain('За этот месяц поездок пока нет.')
    expect(stats?.text).not.toContain('<pre>')
  })

  it('rejects a month it cannot parse', async () => {
    expect(await buildMonthStats(await setup(), '2026-13', now)).toBeNull()
  })
})

describe('Month arrows under the statistics message', () => {
  it('offers both directions inside recorded history', () => {
    expect(statsKeyboard('2026-07', '2026-08').inline_keyboard).toEqual([
      [{ text: '◀ Июнь', callback_data: 'stats:2026-06' }, { text: 'Август ▶', callback_data: 'stats:2026-08' }],
      [{ text: '🔄 Текущий месяц', callback_data: 'stats:2026-08' }]
    ])
  })

  it('does not offer a month that has not started', () => {
    expect(statsKeyboard('2026-08', '2026-08').inline_keyboard).toEqual([
      [{ text: '◀ Июль', callback_data: 'stats:2026-07' }]
    ])
  })
})
