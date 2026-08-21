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
  // Five-minute snapshots; the session covers the first two of them, so only the
  // engine time reported after it ended fell outside every session.
  const session = (vehicleId: number, minutes: number, extra: Record<string, unknown> = {}) => ({
    vehicleId,
    startedAt: start,
    endedAt: new Date(start.getTime() + minutes * MINUTE),
    durationMinutes: minutes,
    isOpen: false,
    ...extra
  })

  it('counts a warm-up the poller slept through as engine time nobody saw', async () => {
    const { database, vehicleId } = await setup()
    try {
      // The engine ran ten minutes between the third and fourth snapshot without
      // the odometer moving: a start and a stop that both fell between polls.
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 1000, mileage: 500 }, { motorMinutes: 1005, mileage: 500 },
        { motorMinutes: 1005, mileage: 500 }, { motorMinutes: 1015, mileage: 500 }
      ]))
      await database.insert(engineSessions).values(session(vehicleId, 5))
      expect(await engineSummary(database, vehicleId, start, end)).toMatchObject({
        counterMinutes: 15,
        sessionMinutes: 5,
        untrackedIdleMinutes: 10,
        untrackedMovingMinutes: 0
      })
    } finally {
      await database.$client.close()
    }
  })

  it('calls the same stretch a trip when the odometer moved over it', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 1000, mileage: 500 }, { motorMinutes: 1005, mileage: 500 },
        { motorMinutes: 1005, mileage: 500 }, { motorMinutes: 1015, mileage: 504 }
      ]))
      await database.insert(engineSessions).values(session(vehicleId, 5))
      const summary = await engineSummary(database, vehicleId, start, end)
      expect(summary).toMatchObject({ untrackedIdleMinutes: 0, untrackedMovingMinutes: 10 })
      expect(summary.untrackedTrips).toHaveLength(1)
      expect(summary.untrackedTrips[0]).toMatchObject({ minutes: 10, distance: 4 })
    } finally {
      await database.$client.close()
    }
  })

  // Silence is not proof the car stood still, and the standing figure is what
  // the overview bills fuel against.
  it('treats a silent odometer as movement rather than as idling', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 1000, mileage: 500 }, { motorMinutes: 1005, mileage: 500 },
        { motorMinutes: 1005, mileage: 500 }, { motorMinutes: 1015 }
      ]))
      await database.insert(engineSessions).values(session(vehicleId, 5))
      const summary = await engineSummary(database, vehicleId, start, end)
      expect(summary).toMatchObject({ untrackedIdleMinutes: 0, untrackedMovingMinutes: 10 })
      expect(summary.untrackedTrips[0]).toMatchObject({ distance: null })
    } finally {
      await database.$client.close()
    }
  })

  // The counter ticks in whole minutes and the poller sees each ignition edge a
  // little late, so it routinely reports more than a session's own stopwatch.
  // That difference belongs to the session, not to a warm-up nobody saw.
  it('leaves the counter running ahead of a session inside that session', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 1000, mileage: 500 }, { motorMinutes: 1010, mileage: 500 }
      ]))
      await database.insert(engineSessions).values(session(vehicleId, 5))
      expect(await engineSummary(database, vehicleId, start, end)).toMatchObject({
        counterMinutes: 10,
        sessionMinutes: 5,
        untrackedIdleMinutes: 0,
        untrackedMovingMinutes: 0
      })
    } finally {
      await database.$client.close()
    }
  })

  it('counts a session still running and one straddling the boundary by their share of the window', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(vehicleSnapshots).values(counter(vehicleId, [
        { motorMinutes: 1000, mileage: 500 }, { motorMinutes: 1010, mileage: 500 }
      ]))
      await database.insert(engineSessions).values([
        // Started ten minutes before the window and ended four minutes into it.
        {
          vehicleId,
          startedAt: new Date(start.getTime() - 10 * MINUTE),
          endedAt: new Date(start.getTime() + 4 * MINUTE),
          durationMinutes: 14,
          isOpen: false
        },
        // Still running: no stored duration to fall back on.
        { vehicleId, startedAt: new Date(start.getTime() + 5 * MINUTE), isOpen: true }
      ])
      const windowEnd = new Date(start.getTime() + 9 * MINUTE)
      expect(await engineSummary(database, vehicleId, start, windowEnd)).toMatchObject({
        sessionMinutes: 8,
        untrackedIdleMinutes: 0,
        untrackedMovingMinutes: 0
      })
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
