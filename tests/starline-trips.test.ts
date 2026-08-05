import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { resolve } from 'node:path'
import { createDatabase } from '../db/client'
import { engineSessions, trips, vehicles, vehicleSnapshots } from '../db/schema'
import { aggregateSnapshot } from '../worker/starline/aggregates'
import { closeTrip, handleMileageProgress, hasMileageIncreased, reconcileTripsWithEngineSessions } from '../worker/starline/trips'

describe('trip detection by odometer', () => {
  it('starts a trip only when mileage increases', () => {
    expect(hasMileageIncreased(18_590, 18_591)).toBe(true)
    expect(hasMileageIncreased(18_590, 18_590)).toBe(false)
    expect(hasMileageIncreased(18_590, 18_589)).toBe(false)
  })

  it('does not infer a trip when either mileage value is unavailable', () => {
    expect(hasMileageIncreased(null, 18_591)).toBe(false)
    expect(hasMileageIncreased(18_590, null)).toBe(false)
  })

  it('keeps fuel consumed before a delayed odometer update', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const base = new Date('2026-08-05T09:00:00.000Z')
    const snapshot = async (minute: number, ignition: boolean, mileage: number, fuel: number) => {
      const ts = new Date(base.getTime() + minute * 60_000)
      const [row] = await database.insert(vehicleSnapshots).values({
        vehicleId: vehicle.id,
        ts,
        activityTs: ts,
        ignition,
        mileage,
        mileageTs: ts,
        fuel,
        fuelSource: 'converted',
        fuelTs: ts,
        rawJson: '{}'
      }).returning()
      return row
    }

    try {
      const parked = await snapshot(0, false, 100, 37)
      const started = await snapshot(1, true, 100, 37)
      await aggregateSnapshot(database, vehicle.id, started, parked)
      await handleMileageProgress(database, vehicle.id, started, parked)

      const fuelDropped = await snapshot(2, true, 100, 36)
      await aggregateSnapshot(database, vehicle.id, fuelDropped, started)
      await handleMileageProgress(database, vehicle.id, fuelDropped, started)

      const odometerUpdated = await snapshot(3, true, 102, 36)
      await aggregateSnapshot(database, vehicle.id, odometerUpdated, fuelDropped)
      await handleMileageProgress(database, vehicle.id, odometerUpdated, fuelDropped)
      const openTrip = await database.query.trips.findFirst()
      expect(openTrip).toMatchObject({
        startedAt: started.ts,
        mileageStart: 100,
        fuelStart: 37,
        isOpen: true
      })

      const stopped = await snapshot(4, false, 102, 36)
      await aggregateSnapshot(database, vehicle.id, stopped, odometerUpdated)
      await handleMileageProgress(database, vehicle.id, stopped, odometerUpdated)
      const closed = await closeTrip(database, { vehicleId: vehicle.id, tripId: openTrip!.id })
      expect(closed).toMatchObject({
        startedAt: started.ts,
        endedAt: stopped.ts,
        distance: 2,
        fuelStart: 37,
        fuelEnd: 36,
        fuelUsed: 1,
        isOpen: false
      })
    } finally {
      await database.$client.close()
    }
  })

  it('repairs legacy trips whose start was recorded after fuel consumption', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const base = new Date('2026-08-05T09:00:00.000Z')
    const startedAt = new Date(base.getTime() + 1 * 60_000)
    const endedAt = new Date(base.getTime() + 20 * 60_000)

    try {
      await database.insert(engineSessions).values({
        vehicleId: vehicle.id,
        startedAt,
        endedAt,
        mileageStart: 18_593,
        mileageEnd: 18_593,
        fuelStart: 36,
        fuelEnd: 34,
        isOpen: false
      })
      const [legacyTrip] = await database.insert(trips).values({
        vehicleId: vehicle.id,
        startedAt: new Date(base.getTime() + 19 * 60_000),
        endedAt: new Date(base.getTime() + 24 * 60_000),
        mileageStart: 18_593,
        mileageEnd: 18_616,
        distance: 23,
        fuelStart: 34,
        fuelEnd: 34,
        fuelUsed: 0,
        isOpen: false
      }).returning()

      await expect(reconcileTripsWithEngineSessions(database)).resolves.toBe(1)
      const repaired = await database.query.trips.findFirst()
      expect(repaired).toMatchObject({
        id: legacyTrip.id,
        startedAt,
        endedAt,
        mileageStart: 18_593,
        mileageEnd: 18_616,
        distance: 23,
        fuelStart: 36,
        fuelEnd: 34,
        fuelUsed: 2,
        isOpen: false
      })
      await expect(reconcileTripsWithEngineSessions(database)).resolves.toBe(0)
    } finally {
      await database.$client.close()
    }
  })
})
