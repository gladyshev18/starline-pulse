import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { resolve } from 'node:path'
import { createDatabase } from '../db/client'
import { engineSessions, refuelEvents, vehicles, vehicleSnapshots } from '../db/schema'
import { aggregateSnapshot, isRefuelIncrease } from '../worker/starline/aggregates'

describe('StarLine snapshot aggregation', () => {
  it('detects a refuel by litres or fuel percentage', () => {
    expect(isRefuelIncrease(3, 4, true)).toBe(true)
    expect(isRefuelIncrease(2, 5, true)).toBe(true)
  })

  it('ignores sensor noise and litre changes from different sources', () => {
    expect(isRefuelIncrease(2.9, 4.9, true)).toBe(false)
    expect(isRefuelIncrease(8, null, false)).toBe(false)
  })

  it('builds an engine session and refuel event from consecutive snapshots', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const base = new Date('2026-08-05T09:00:00.000Z')
    const snapshot = async (minute: number, values: { ignition: boolean, mileage: number, fuel: number, fuelPercent: number }) => {
      const ts = new Date(base.getTime() + minute * 60_000)
      const [row] = await database.insert(vehicleSnapshots).values({
        vehicleId: vehicle.id,
        ts,
        activityTs: ts,
        ignition: values.ignition,
        mileage: values.mileage,
        fuel: values.fuel,
        fuelPercent: values.fuelPercent,
        fuelSource: 'converted',
        fuelTs: ts,
        rawJson: '{}'
      }).returning()
      return row
    }

    try {
      const parked = await snapshot(0, { ignition: false, mileage: 100, fuel: 30, fuelPercent: 60 })
      const started = await snapshot(1, { ignition: true, mileage: 100, fuel: 30, fuelPercent: 60 })
      await aggregateSnapshot(database, vehicle.id, started, parked)
      const warming = await snapshot(2, { ignition: true, mileage: 100, fuel: 30, fuelPercent: 60 })
      await aggregateSnapshot(database, vehicle.id, warming, started)
      const moving = await snapshot(3, { ignition: true, mileage: 101, fuel: 29, fuelPercent: 58 })
      await aggregateSnapshot(database, vehicle.id, moving, warming)
      const stopped = await snapshot(4, { ignition: false, mileage: 101, fuel: 29, fuelPercent: 58 })
      await aggregateSnapshot(database, vehicle.id, stopped, moving)
      const refuelled = await snapshot(5, { ignition: false, mileage: 101, fuel: 37, fuelPercent: 74 })
      await aggregateSnapshot(database, vehicle.id, refuelled, stopped)

      const session = await database.query.engineSessions.findFirst()
      expect(session).toMatchObject({ distance: 1, durationMinutes: 3, warmupMinutes: 1, isStationary: false, isOpen: false })
      const refuel = await database.query.refuelEvents.findFirst()
      expect(refuel).toMatchObject({ litresAdded: 8, percentBefore: 58, percentAfter: 74, mileage: 101 })
    } finally {
      await database.$client.close()
    }
  })
})
