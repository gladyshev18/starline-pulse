import { resolve } from 'node:path'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { describe, expect, it } from 'vitest'
import { createDatabase } from '../db/client'
import { engineSessions, refuelEvents, vehicleSnapshots, vehicles } from '../db/schema'
import { idleSummary, resolveFuelPrice } from '../metrics/idle'
import { DEFAULT_IDLE_LITRES_PER_HOUR } from '../shared/idle-cost'

const MINUTE = 60_000
const start = new Date('2026-08-01T00:00:00.000Z')
const end = new Date('2026-09-01T00:00:00.000Z')

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicleId: vehicle!.id }
}

type SessionOverrides = Partial<typeof engineSessions.$inferInsert>

function session(vehicleId: number, day: number, minutes: number, overrides: SessionOverrides = {}) {
  const startedAt = new Date(start.getTime() + day * 24 * 60 * MINUTE)
  return {
    vehicleId,
    startedAt,
    endedAt: new Date(startedAt.getTime() + minutes * MINUTE),
    durationMinutes: minutes,
    distance: 0,
    isStationary: true,
    isOpen: false,
    engineTempStart: 88,
    ...overrides
  }
}

// Enough half-hour sessions at a steady 0.7 l/h that the total drop outgrows the
// rounding of the readings it was measured from.
function measuredHistory(vehicleId: number) {
  return Array.from({ length: 40 }, (_, index) => session(vehicleId, index % 28, 30, {
    fuelStart: 40,
    fuelEnd: 39.65
  }))
}

// Polls run every 30 seconds while the engine is on, which is what the armed
// minutes are summed from.
function polls(vehicleId: number, from: Date, steps: Array<{ ignition: boolean, armed: boolean | null }>) {
  return steps.map((step, index) => ({
    vehicleId,
    ts: new Date(from.getTime() + index * 30_000),
    rawJson: '{}',
    ...step
  }))
}

describe('armed idle inside a session that moved', () => {
  const departure = new Date(start.getTime() + 24 * 60 * MINUTE)

  it('counts the warm-up a remote start left under alarm', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([
        session(vehicleId, 1, 20, { isStationary: false, distance: 12 })
      ])
      // Ten polls armed, then the driver walks out, disarms and drives off.
      await database.insert(vehicleSnapshots).values(polls(vehicleId, departure, [
        ...Array.from({ length: 11 }, () => ({ ignition: true, armed: true })),
        ...Array.from({ length: 10 }, () => ({ ignition: true, armed: false }))
      ]))
      const summary = await idleSummary(database, vehicleId, start, end)
      // Ten thirty-second intervals armed at both ends; the one where the alarm
      // went off is dropped.
      expect(summary.armedMinutes).toBeCloseTo(5)
      expect(summary.stationaryMinutes).toBe(0)
      expect(summary.minutes).toBeCloseTo(5)
    } finally {
      await database.$client.close()
    }
  })

  it('does not bill a stationary session twice for being armed', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([session(vehicleId, 1, 20)])
      await database.insert(vehicleSnapshots).values(polls(vehicleId, departure,
        Array.from({ length: 21 }, () => ({ ignition: true, armed: true }))))
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary.armedMinutes).toBe(0)
      expect(summary.stationaryMinutes).toBe(20)
      expect(summary.minutes).toBe(20)
    } finally {
      await database.$client.close()
    }
  })

  it('ignores armed polls with the engine off', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([
        session(vehicleId, 1, 20, { isStationary: false, distance: 12 })
      ])
      await database.insert(vehicleSnapshots).values(polls(vehicleId, departure,
        Array.from({ length: 21 }, () => ({ ignition: false, armed: true }))))
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary.armedMinutes).toBe(0)
    } finally {
      await database.$client.close()
    }
  })

  it('does not stretch a warm-up across a gap where the worker was down', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([
        session(vehicleId, 1, 600, { isStationary: false, distance: 12 })
      ])
      await database.insert(vehicleSnapshots).values([
        { vehicleId, ts: departure, rawJson: '{}', ignition: true, armed: true },
        // Two hours later: the poll never ran, the engine did not idle through it.
        { vehicleId, ts: new Date(departure.getTime() + 120 * MINUTE), rawJson: '{}', ignition: true, armed: true },
        { vehicleId, ts: new Date(departure.getTime() + 120.5 * MINUTE), rawJson: '{}', ignition: true, armed: false }
      ])
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary.armedMinutes).toBeCloseTo(5)
    } finally {
      await database.$client.close()
    }
  })
})

describe('idleSummary', () => {
  it('counts only closed stationary sessions inside the period', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([
        session(vehicleId, 2, 10),
        session(vehicleId, 3, 20),
        // Moved, so its minutes belong to the trip and not to standing still.
        session(vehicleId, 4, 45, { isStationary: false, distance: 12 }),
        // Still running: its duration is not final yet.
        session(vehicleId, 5, 15, { isOpen: true, endedAt: null }),
        // Last month.
        session(vehicleId, -10, 60)
      ])
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary.sessions).toBe(2)
      expect(summary.minutes).toBe(30)
    } finally {
      await database.$client.close()
    }
  })

  it('splits the time by how cold the engine was, keeping unread sessions in the total', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([
        session(vehicleId, 1, 12, { engineTempStart: 24 }),
        session(vehicleId, 2, 8, { engineTempStart: 58 }),
        session(vehicleId, 3, 20, { engineTempStart: 88 }),
        session(vehicleId, 4, 5, { engineTempStart: null })
      ])
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary).toMatchObject({
        minutes: 45,
        coldSessions: 2,
        coldMinutes: 20,
        warmSessions: 1,
        warmMinutes: 20,
        unknownMinutes: 5
      })
    } finally {
      await database.$client.close()
    }
  })

  it('measures the burn rate over the whole history, not just the period shown', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values(measuredHistory(vehicleId))
      // One short session is all this period holds; on its own it could never
      // outweigh the sensor's rounding.
      const july = await idleSummary(database, vehicleId, new Date('2026-07-01T00:00:00.000Z'), start)
      expect(july.minutes).toBe(0)
      expect(july.rate.source).toBe('measured')
      expect(july.rate.litresPerHour).toBeCloseTo(0.7)
    } finally {
      await database.$client.close()
    }
  })

  it('falls back to the stand-in rate while the car has barely idled', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([session(vehicleId, 1, 20, { fuelStart: 40, fuelEnd: 39.5 })])
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary.rate.source).toBe('default')
      expect(summary.litres).toBeCloseTo(20 / 60 * DEFAULT_IDLE_LITRES_PER_HOUR)
      expect(summary.litresUncertainty).toBeNull()
    } finally {
      await database.$client.close()
    }
  })

  it('prices the idling and reports what the price came from', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values(measuredHistory(vehicleId))
      await database.insert(refuelEvents).values({
        vehicleId,
        detectedAt: new Date('2026-08-10T10:00:00.000Z'),
        litresAdded: 30,
        totalAmount: 2100,
        pricePerLitre: 70
      })
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary.priceSource).toBe('period')
      expect(summary.pricePerLitre).toBeCloseTo(70)
      expect(summary.cost).toBeCloseTo(summary.litres * 70)
      expect(summary.costUncertainty).toBeCloseTo(summary.litresUncertainty! * 70)
    } finally {
      await database.$client.close()
    }
  })

  it('leaves the cost unknown until a receipt has priced a refuel', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(engineSessions).values([session(vehicleId, 1, 30)])
      await database.insert(refuelEvents).values({
        vehicleId,
        detectedAt: new Date('2026-08-10T10:00:00.000Z'),
        litresAdded: 30
      })
      const summary = await idleSummary(database, vehicleId, start, end)
      expect(summary.pricePerLitre).toBeNull()
      expect(summary.cost).toBeNull()
      expect(summary.litres).toBeGreaterThan(0)
    } finally {
      await database.$client.close()
    }
  })
})

describe('resolveFuelPrice', () => {
  it('divides what the period cost by what it bought', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(refuelEvents).values([
        { vehicleId, detectedAt: new Date('2026-08-05T10:00:00.000Z'), litresAdded: 20, totalAmount: 1200 },
        { vehicleId, detectedAt: new Date('2026-08-20T10:00:00.000Z'), litresAdded: 30, totalAmount: 2100 }
      ])
      const price = await resolveFuelPrice(database, vehicleId, start, end)
      expect(price.priceSource).toBe('period')
      expect(price.pricePerLitre).toBeCloseTo(3300 / 50)
    } finally {
      await database.$client.close()
    }
  })

  it('reaches back to the last known price for a period without refuels', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(refuelEvents).values([
        { vehicleId, detectedAt: new Date('2026-06-05T10:00:00.000Z'), litresAdded: 20, totalAmount: 1200, pricePerLitre: 60 },
        { vehicleId, detectedAt: new Date('2026-07-05T10:00:00.000Z'), litresAdded: 20, totalAmount: 1300, pricePerLitre: 65 }
      ])
      const price = await resolveFuelPrice(database, vehicleId, start, end)
      expect(price.priceSource).toBe('latest')
      expect(price.pricePerLitre).toBe(65)
    } finally {
      await database.$client.close()
    }
  })

  it('ignores a refuel whose volume never got a price', async () => {
    const { database, vehicleId } = await setup()
    try {
      await database.insert(refuelEvents).values({
        vehicleId, detectedAt: new Date('2026-08-05T10:00:00.000Z'), litresAdded: 20
      })
      expect(await resolveFuelPrice(database, vehicleId, start, end)).toMatchObject({ pricePerLitre: null, priceSource: null })
    } finally {
      await database.$client.close()
    }
  })
})
