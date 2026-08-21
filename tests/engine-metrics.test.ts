import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { engineSessions, serviceEvents, vehicleSnapshots, vehicles } from '../db/schema'
import { engineMinutesBetween, engineSummary, oilStatus } from '../metrics/engine'

const MINUTE = 60_000
const start = new Date('2026-08-01T00:00:00.000Z')
const end = new Date('2026-09-01T00:00:00.000Z')

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicleId: vehicle!.id }
}

function counter(vehicleId: number, values: Array<{ motorMinutes: number | null, mileage?: number }>, from = start) {
  return values.map((value, index) => ({
    vehicleId,
    ts: new Date(from.getTime() + index * 5 * MINUTE),
    rawJson: '{}',
    ...value
  }))
}

describe('engineMinutesBetween', () => {
  it('adds up what the counter climbed', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 14_200 }, { motorMinutes: 14_205 }, { motorMinutes: 14_205 }, { motorMinutes: 14_212 }
      ]))
      expect(await engineMinutesBetween(database, vehicleId, start, end)).toBe(12)
    } finally {
      await database.$client.close()
    }
  })

  it('survives a counter reset instead of reporting negative time', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 14_200 }, { motorMinutes: 14_210 }, { motorMinutes: 0 }, { motorMinutes: 7 }
      ]))
      // Ten minutes before the reset, seven after; the drop itself counts as
      // nothing rather than as minus fourteen thousand.
      expect(await engineMinutesBetween(database, vehicleId, start, end)).toBe(17)
    } finally {
      await database.$client.close()
    }
  })

  it('ignores a jump too large for an engine to have run', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 100 }, { motorMinutes: 5000 }, { motorMinutes: 5010 }
      ]))
      expect(await engineMinutesBetween(database, vehicleId, start, end)).toBe(10)
    } finally {
      await database.$client.close()
    }
  })

  it('skips snapshots that never carried the counter', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: null }, { motorMinutes: 100 }, { motorMinutes: null }, { motorMinutes: 106 }
      ]))
      expect(await engineMinutesBetween(database, vehicleId, start, end)).toBe(6)
    } finally {
      await database.$client.close()
    }
  })
})

describe('engineSummary', () => {
  it('shows the engine time no session accounted for', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 1000 }, { motorMinutes: 1050 }
      ]))
      await database.insert(engineSessions).values({
        vehicleId,
        startedAt: new Date(start.getTime() + MINUTE),
        endedAt: new Date(start.getTime() + 41 * MINUTE),
        durationMinutes: 40,
        isOpen: false
      })
      expect(await engineSummary(database, vehicleId, start, end)).toMatchObject({
        counterMinutes: 50,
        sessionMinutes: 40,
        sessions: 1,
        unattributedMinutes: 10
      })
    } finally {
      await database.$client.close()
    }
  })

  it('does not report negative leftovers when rounding puts sessions ahead', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 1000 }, { motorMinutes: 1010 }
      ]))
      await database.insert(engineSessions).values({
        vehicleId, startedAt: new Date(start.getTime() + MINUTE), endedAt: new Date(start.getTime() + 12 * MINUTE),
        durationMinutes: 11, isOpen: false
      })
      expect((await engineSummary(database, vehicleId, start, end)).unattributedMinutes).toBe(0)
    } finally {
      await database.$client.close()
    }
  })
})

describe('oilStatus', () => {
  it('has nothing to count from until a change is recorded', async () => {
    const { database, vehicleId } = await setup()
    try {
      const status = await oilStatus(database, vehicleId, end)
      expect(status.service).toBeNull()
      expect(status.life.binding).toBeNull()
    } finally {
      await database.$client.close()
    }
  })

  it('counts distance, engine hours and months from the recorded change', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(serviceEvents).values({
        vehicleId, kind: 'oil', performedAt: start, mileage: 18_000, motorMinutes: 14_000
      })
      // Six hours of engine time and 200 km since.
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 14_000, mileage: 18_000 },
        { motorMinutes: 14_180, mileage: 18_100 },
        { motorMinutes: 14_360, mileage: 18_200 }
      ]))
      const status = await oilStatus(database, vehicleId, new Date(start.getTime() + 60 * 24 * 60 * MINUTE))
      expect(status.km).toBe(200)
      expect(status.motorHours).toBeCloseTo(6)
      expect(status.months).toBeCloseTo(1.97, 1)
      expect(status.kmPerHour).toBeCloseTo(33.3, 0)
      // Two months on the calendar against a twelfth of the distance interval:
      // the car sat still, so the calendar is what the service is due on.
      expect(status.life.binding?.name).toBe('months')
    } finally {
      await database.$client.close()
    }
  })

  it('lets engine hours overtake the odometer for a car stuck in traffic', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(serviceEvents).values({
        vehicleId, kind: 'oil', performedAt: start, mileage: 18_000, motorMinutes: 14_000
      })
      // Three hundred engine hours arrive an hour at a time, as they would in
      // life; a single jump of that size would be a broken counter, not driving.
      await database.insert(vehicleSnapshots).values(counter(vehicleId,
        Array.from({ length: 301 }, (_, index) => ({
          motorMinutes: 14_000 + index * 60,
          mileage: 18_000 + index * 20
        }))))
      const status = await oilStatus(database, vehicleId, new Date(start.getTime() + 150 * 24 * 60 * MINUTE))
      expect(status.motorHours).toBeCloseTo(300)
      expect(status.km).toBe(6000)
      expect(status.life.binding?.name).toBe('hours')
      expect(status.clockGap!).toBeGreaterThan(0)
    } finally {
      await database.$client.close()
    }
  })
})
