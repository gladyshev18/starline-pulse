import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { asc } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createDatabase } from '../db/client'
import { deviceEvents, engineSessions, trips, vehicles, vehicleSnapshots } from '../db/schema'
import { recomputeTrips } from '../worker/starline/recompute'
import { HANDBRAKE_RELEASED, IGNITION_OFF, IGNITION_ON } from '../shared/starline-events'

// Разовый проход не имеет своей логики: он повторяет то, что воркер делает на
// живом опросе. Проверяется поэтому не устройство разбора, а его обещание —
// после прогона километры сходятся с одометром, а записи соответствуют тому,
// что видел журнал сигнализации.
describe('recomputeTrips', () => {
  const base = new Date('2026-08-05T09:00:00.000Z')
  const at = (minute: number) => new Date(base.getTime() + minute * 60_000)
  const seconds = (minute: number) => Math.floor(at(minute).getTime() / 1000)

  const build = async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const snapshot = async (minute: number, mileage: number, mileageMinute = minute, ignition = false) => {
      await database.insert(vehicleSnapshots).values({
        vehicleId: vehicle!.id, ts: at(minute), activityTs: at(minute), ignition, armed: !ignition,
        mileage, mileageTs: at(mileageMinute), fuel: 30, fuelSource: 'converted', fuelTs: at(minute),
        motorMinutes: 500 + minute, rawJson: '{}'
      })
    }
    const session = async (from: number, to: number) => {
      const [row] = await database.insert(engineSessions).values({
        vehicleId: vehicle!.id, startedAt: at(from), endedAt: at(to), isOpen: false
      }).returning()
      return row!
    }
    const events = async (pairs: Array<[number, number]>) => {
      await database.insert(deviceEvents).values(pairs.map(([minute, type]) => ({
        vehicleId: vehicle!.id, type, ts: at(minute)
      })))
    }
    return { database, vehicle: vehicle!, snapshot, session, events }
  }

  it('сводит километры с одометром и заводит поездки тем, кто ехал', async () => {
    const { database, snapshot, session, events } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(12, 108, 11, true)
      await snapshot(40, 120, 38)
      await session(2, 10)
      await session(25, 35)
      await events([[2, IGNITION_ON], [3, HANDBRAKE_RELEASED], [10, IGNITION_OFF],
        [25, IGNITION_ON], [26, HANDBRAKE_RELEASED], [35, IGNITION_OFF]])

      const report = await recomputeTrips(database, { apply: true })
      expect(report.odometerSpan).toBe(20)
      expect(report.distanceAfter + report.unattributed).toBeCloseTo(20, 6)

      const all = await database.select().from(trips).orderBy(asc(trips.startedAt))
      expect(all).toHaveLength(2)
      expect((all[0]!.distance ?? 0) + (all[1]!.distance ?? 0)).toBeCloseTo(20, 6)
    } finally {
      await database.$client.close()
    }
  })

  it('снимает запись, за которую машина не сдвинулась', async () => {
    const { database, vehicle, snapshot, session, events } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(40, 100, 0)
      const warmup = await session(5, 15)
      await events([[5, IGNITION_ON], [15, IGNITION_OFF]])
      await database.insert(trips).values({
        vehicleId: vehicle.id, startedAt: warmup.startedAt, endedAt: warmup.endedAt,
        mileageStart: 100, mileageEnd: 100, distance: 0, driver: 'Кристина', isOpen: false
      })

      const report = await recomputeTrips(database, { apply: true })
      expect(report.tripsRemoved).toHaveLength(1)
      expect(await database.select().from(trips)).toHaveLength(0)
      // Прогрев остаётся сессией: по ней его считает счёт холостого хода.
      expect(await database.select().from(engineSessions)).toHaveLength(1)
    } finally {
      await database.$client.close()
    }
  })

  it('не удаляет запись, на которой человек оставил комментарий', async () => {
    const { database, vehicle, snapshot, session, events } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(40, 100, 0)
      const warmup = await session(5, 15)
      await events([[5, IGNITION_ON], [15, IGNITION_OFF]])
      await database.insert(trips).values({
        vehicleId: vehicle.id, startedAt: warmup.startedAt, endedAt: warmup.endedAt,
        mileageStart: 100, mileageEnd: 100, distance: 0, comment: 'заезжал на мойку', isOpen: false
      })

      await recomputeTrips(database, { apply: true })
      const left = await database.select().from(trips)
      expect(left).toHaveLength(1)
      expect(left[0]).toMatchObject({ comment: 'заезжал на мойку' })
    } finally {
      await database.$client.close()
    }
  })

  it('оставляет километры ничьими, если двигатель в это время не работал', async () => {
    const { database, snapshot, session, events } = await build()
    try {
      await snapshot(0, 100, 0)
      // Одометр вырос там, где ни одна сессия не работала.
      await snapshot(20, 130, 18)
      await snapshot(60, 130, 18)
      await session(30, 40)
      await events([[30, IGNITION_ON], [31, HANDBRAKE_RELEASED], [40, IGNITION_OFF]])

      const report = await recomputeTrips(database, { apply: true })
      expect(report.unattributed).toBe(30)
      expect(report.distanceAfter).toBe(0)
    } finally {
      await database.$client.close()
    }
  })
})
