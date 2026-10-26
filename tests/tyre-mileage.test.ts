import { migrate } from 'drizzle-orm/libsql/migrator'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { serviceDocuments, serviceEvents, vehicles, vehicleSnapshots } from '../db/schema'
import { ownershipSummary } from '../metrics/ownership'
import { tyreMileage, tyreSeasonLabel, type TyreChange } from '../shared/tyre-mileage'
import { recordTyreChange, tyreNoticeKeyboard } from '../worker/bot/tyre-watch'

function change(id: number, performedAt: string, season: 'winter' | 'summer', mileage: number | null, amount: number | null = null): TyreChange {
  return { id, performedAt: new Date(performedAt), season, mileage, amount }
}

describe('mileage by tyre season', () => {
  const history = [
    change(1, '2025-04-20T09:00:00.000Z', 'summer', 40_000, 3_200),
    change(2, '2025-11-02T09:00:00.000Z', 'winter', 46_500, 3_500),
    change(3, '2026-04-18T09:00:00.000Z', 'summer', 52_000)
  ]

  it('counts each stretch from one change to the next, and the last one up to the odometer', () => {
    const result = tyreMileage(history, 55_100)
    expect(result.segments.map(item => item.km)).toEqual([6_500, 5_500, 3_100])
    expect(result.segments.map(item => item.current)).toEqual([false, false, true])
    expect(result.segments.at(-1)?.to).toBeNull()
  })

  it('adds the stretches of each season across the years', () => {
    const result = tyreMileage(history, 55_100)
    expect(result.totals.summer).toEqual({ km: 9_600, segments: 2 })
    expect(result.totals.winter).toEqual({ km: 5_500, segments: 1 })
  })

  it('does not depend on the order the changes arrive in', () => {
    const result = tyreMileage([...history].reverse(), 55_100)
    expect(result.segments.map(item => item.id)).toEqual([1, 2, 3])
  })

  it('sums only the fittings whose price is known', () => {
    const result = tyreMileage(history, 55_100)
    expect(result.spent).toBe(6_700)
    expect(result.priced).toBe(2)
    expect(result.changes).toBe(3)
    expect(result.segments.map(item => item.amount)).toEqual([3_200, 3_500, null])
  })

  it('knows nothing about the time before the first change', () => {
    const result = tyreMileage([change(1, '2026-04-18T09:00:00.000Z', 'summer', 52_000)], 52_900)
    expect(result.segments).toHaveLength(1)
    expect(result.totals.winter.km).toBe(0)
    expect(result.totals.summer.km).toBe(900)
  })

  it('leaves a stretch without an odometer reading out instead of guessing', () => {
    const result = tyreMileage([
      change(1, '2025-11-02T09:00:00.000Z', 'winter', null),
      change(2, '2026-04-18T09:00:00.000Z', 'summer', 52_000)
    ], null)
    expect(result.segments.map(item => item.km)).toEqual([null, null])
    expect(result.totals.winter).toEqual({ km: 0, segments: 0 })
  })

  it('refuses a negative stretch rather than subtracting it from the total', () => {
    const result = tyreMileage([
      change(1, '2026-04-18T09:00:00.000Z', 'summer', 52_000),
      change(2, '2026-04-19T09:00:00.000Z', 'winter', 51_000)
    ], 51_500)
    expect(result.segments[0]!.km).toBeNull()
    expect(result.totals.summer.km).toBe(0)
  })

  it('is empty without changes', () => {
    const result = tyreMileage([], 55_000)
    expect(result.segments).toEqual([])
    expect(result.spent).toBe(0)
    expect(result.changes).toBe(0)
  })
})

describe('season labels', () => {
  it('names a winter by the year it began in, wherever in it the change fell', () => {
    expect(tyreSeasonLabel('winter', new Date('2025-11-02T09:00:00.000Z'))).toBe('Зима 2025/26')
    expect(tyreSeasonLabel('winter', new Date('2026-01-20T09:00:00.000Z'))).toBe('Зима 2025/26')
  })

  it('reads the month in Moscow, not on the server', () => {
    expect(tyreSeasonLabel('winter', new Date('2025-12-31T22:00:00.000Z'))).toBe('Зима 2025/26')
    expect(tyreSeasonLabel('summer', new Date('2026-04-18T09:00:00.000Z'))).toBe('Лето 2026')
  })
})

async function seed() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicleId: vehicle!.id }
}

describe('recording a tyre change from the bot', () => {
  const now = new Date('2026-10-26T09:00:00.000Z')

  it('takes the odometer and engine hours as they stand', async () => {
    const { database, vehicleId } = await seed()
    await database.insert(vehicleSnapshots).values({
      vehicleId, ts: new Date('2026-10-26T08:00:00.000Z'), mileage: 57_300, motorMinutes: 9_000, rawJson: '{}'
    })

    const result = await recordTyreChange(database, 'winter', now)
    expect(result.status).toBe('recorded')
    const [saved] = await database.select().from(serviceEvents)
    expect(saved).toMatchObject({ kind: 'tyres', season: 'winter', mileage: 57_300, amount: null })
    expect(saved!.performedAt).toEqual(now)
  })

  it('does not write the same change twice when the button is pressed again', async () => {
    const { database } = await seed()
    expect((await recordTyreChange(database, 'winter', now)).status).toBe('recorded')
    expect((await recordTyreChange(database, 'winter', new Date(now.getTime() + 60_000))).status).toBe('duplicate')
    expect(await database.select().from(serviceEvents)).toHaveLength(1)
  })

  it('lets the opposite change through: that is a different fitting', async () => {
    const { database } = await seed()
    await recordTyreChange(database, 'winter', now)
    expect((await recordTyreChange(database, 'summer', new Date(now.getTime() + 60_000))).status).toBe('recorded')
  })

  it('has nothing to write without a car', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    expect((await recordTyreChange(database, 'winter', now)).status).toBe('no-vehicle')
  })
})

describe('the button under the tyre notice', () => {
  it('is offered once the message says to change, not when it only says the night is cold', () => {
    expect(tyreNoticeKeyboard({ season: 'winter', status: 'edge' })).toBeNull()
    for (const status of ['soon', 'now', 'late'] as const) {
      expect(tyreNoticeKeyboard({ season: 'winter', status })).not.toBeNull()
    }
  })

  it('says which tyres it records', () => {
    const keyboard = tyreNoticeKeyboard({ season: 'summer', status: 'now' })!
    const button = keyboard.inline_keyboard[0]![0]! as { text: string, callback_data: string }
    expect(button.callback_data).toBe('tyre:changed:summer')
    expect(button.text).toContain('летнюю')
  })
})

describe('the cost of a kilometre', () => {
  it('ignores tyre fittings, which would otherwise move the oil figure', async () => {
    const { database, vehicleId } = await seed()
    const [first, second, tyres] = await database.insert(serviceEvents).values([
      { vehicleId, kind: 'oil', performedAt: new Date('2026-01-10T09:00:00.000Z'), mileage: 40_000 },
      { vehicleId, kind: 'oil', performedAt: new Date('2026-09-10T09:00:00.000Z'), mileage: 50_000 },
      { vehicleId, kind: 'tyres', season: 'winter', performedAt: new Date('2026-10-20T09:00:00.000Z'), mileage: 51_000, amount: 4_000 }
    ]).returning()
    expect(first).toBeDefined()
    await database.insert(serviceDocuments).values({
      serviceEventId: second!.id, kind: 'act', receivedAt: new Date('2026-09-11T09:00:00.000Z'), totalAmount: 10_000
    })
    await database.insert(serviceDocuments).values({
      serviceEventId: tyres!.id, kind: 'act', receivedAt: new Date('2026-10-21T09:00:00.000Z'), totalAmount: 4_000
    })

    const summary = await ownershipSummary(
      database, vehicleId, new Date('2026-10-01T00:00:00.000Z'), new Date('2026-11-01T00:00:00.000Z'),
      { fuelPerKm: 10, distance: 500 }
    )
    expect(summary.service.km).toBe(10_000)
    expect(summary.service.amount).toBe(10_000)
    expect(summary.service.services).toBe(1)
  })
})
