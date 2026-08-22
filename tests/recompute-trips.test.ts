import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { asc, eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createDatabase } from '../db/client'
import { engineSessions, trips, vehicles, vehicleSnapshots } from '../db/schema'
import { recomputeTrips } from '../worker/starline/recompute'

// Разбор накопленной истории. Сцены здесь списаны с боевых данных: одометр
// отдаёт пробег кусками и досылает остаток уже по стоящей машине, из-за чего в
// журнале завелись поездки, которых не было.
describe('recomputeTrips', () => {
  const base = new Date('2026-08-05T09:00:00.000Z')
  const at = (minute: number) => new Date(base.getTime() + minute * 60_000)

  async function setup() {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const snapshot = (minute: number, ignition: boolean, mileage: number, motorMinutes: number) =>
      database.insert(vehicleSnapshots).values({
        vehicleId: vehicle!.id,
        ts: at(minute),
        activityTs: at(minute),
        ignition,
        mileage,
        mileageTs: at(minute),
        motorMinutes,
        rawJson: '{}'
      })
    return { database, vehicleId: vehicle!.id, snapshot }
  }

  it('returns the late kilometres to the trip that drove them and drops the record they invented', async () => {
    const { database, vehicleId, snapshot } = await setup()
    try {
      await snapshot(0, false, 100, 500)
      await snapshot(1, true, 100, 501)
      await snapshot(6, true, 102, 506)
      await snapshot(13, false, 102, 508)
      await snapshot(15, false, 102, 508)
      // Досылка: машина стоит, моточасы стоят, а одометр отчитывается за дорогу.
      await snapshot(17, false, 105, 508)
      await snapshot(19, false, 105, 508)

      await database.insert(engineSessions).values({
        vehicleId, startedAt: at(1), endedAt: at(13), mileageStart: 100, mileageEnd: 102,
        distance: 2, durationMinutes: 12, isStationary: false, isOpen: false
      })
      const [real] = await database.insert(trips).values({
        vehicleId, startedAt: at(1), endedAt: at(13), mileageStart: 100, mileageEnd: 102, distance: 2, isOpen: false
      }).returning()
      const [phantom] = await database.insert(trips).values({
        vehicleId, startedAt: at(15), endedAt: at(19), mileageStart: 102, mileageEnd: 105, distance: 3, isOpen: false
      }).returning()

      const report = await recomputeTrips(database, { apply: true })
      expect(report.tripsMerged).toEqual([{ id: phantom!.id, intoId: real!.id, distance: 3 }])
      // Ни один километр не потерялся и ни один не удвоился.
      expect(report.distanceAfter).toBe(report.distanceBefore)
      expect(report.distanceAfter).toBe(report.odometerSpan)

      const remaining = await database.select().from(trips).orderBy(asc(trips.startedAt))
      expect(remaining).toHaveLength(1)
      expect(remaining[0]).toMatchObject({ id: real!.id, mileageStart: 100, mileageEnd: 105, distance: 5 })

      const [session] = await database.select().from(engineSessions)
      expect(session).toMatchObject({ mileageEnd: 105, distance: 5, isStationary: false })
    } finally {
      await database.$client.close()
    }
  })

  it('keeps a drive the poller slept through, because the engine clock counted it', async () => {
    const { database, vehicleId, snapshot } = await setup()
    try {
      await snapshot(0, false, 100, 500)
      await snapshot(1, true, 100, 501)
      await snapshot(6, true, 102, 506)
      await snapshot(13, false, 102, 508)
      // Опрос спит, а машина успевает съездить: зажигания никто не видел, зато
      // моточасы выросли на одиннадцать минут.
      await snapshot(25, false, 118, 519)

      await database.insert(engineSessions).values({
        vehicleId, startedAt: at(1), endedAt: at(13), mileageStart: 100, mileageEnd: 102,
        distance: 2, durationMinutes: 12, isStationary: false, isOpen: false
      })
      await database.insert(trips).values({
        vehicleId, startedAt: at(1), endedAt: at(13), mileageStart: 100, mileageEnd: 102, distance: 2, isOpen: false
      })
      const [untracked] = await database.insert(trips).values({
        vehicleId, startedAt: at(15), endedAt: at(25), mileageStart: 102, mileageEnd: 118, distance: 16, isOpen: false
      }).returning()

      const report = await recomputeTrips(database, { apply: true })
      expect(report.tripsMerged).toEqual([])
      expect(report.tripsEmptied).toEqual([])
      const remaining = await database.select().from(trips)
      expect(remaining.map(item => item.id)).toContain(untracked!.id)
      expect(remaining).toHaveLength(2)
    } finally {
      await database.$client.close()
    }
  })

  it('recognises a flush that arrived only after the next engine start', async () => {
    const { database, vehicleId, snapshot } = await setup()
    try {
      await snapshot(0, false, 100, 500)
      await snapshot(1, true, 100, 501)
      await snapshot(10, false, 100, 510)
      await snapshot(12, false, 100, 510)
      // Показание снято в 14-ю минуту, до следующего запуска, а привёз его опрос
      // 16-й минуты, когда двигатель уже работал снова. По флагу зажигания эти
      // километры оказались бы ничьими.
      await database.insert(vehicleSnapshots).values({
        vehicleId, ts: at(16), activityTs: at(16), ignition: true,
        mileage: 103, mileageTs: at(14), motorMinutes: 510, rawJson: '{}'
      })
      await snapshot(20, true, 103, 514)
      await snapshot(24, false, 108, 518)

      await database.insert(engineSessions).values([
        { vehicleId, startedAt: at(1), endedAt: at(10), mileageStart: 100, mileageEnd: 100, distance: 0, durationMinutes: 9, isStationary: true, isOpen: false },
        { vehicleId, startedAt: at(15), endedAt: at(24), mileageStart: 103, mileageEnd: 108, distance: 5, durationMinutes: 9, isStationary: false, isOpen: false }
      ])
      await database.insert(trips).values({
        vehicleId, startedAt: at(15), endedAt: at(24), mileageStart: 103, mileageEnd: 108, distance: 5, isOpen: false
      })

      const report = await recomputeTrips(database, { apply: true })
      // Первая сессия числилась прогревом, хотя проехала три километра.
      expect(report.sessionsExtended).toEqual([{ id: 1, distance: 3, wasStationary: true }])
      const first = await database.query.engineSessions.findFirst({ where: eq(engineSessions.id, 1) })
      expect(first).toMatchObject({ mileageEnd: 103, distance: 3, isStationary: false })
      expect(report.distanceAfter).toBe(report.odometerSpan)
    } finally {
      await database.$client.close()
    }
  })

  it('never deletes a record a person has written on', async () => {
    const { database, vehicleId, snapshot } = await setup()
    try {
      await snapshot(0, false, 100, 500)
      await snapshot(1, true, 100, 501)
      await snapshot(13, false, 102, 508)
      await snapshot(15, false, 102, 508)
      await snapshot(17, false, 105, 508)
      await snapshot(19, false, 105, 508)

      await database.insert(engineSessions).values({
        vehicleId, startedAt: at(1), endedAt: at(13), mileageStart: 100, mileageEnd: 102,
        distance: 2, durationMinutes: 12, isStationary: false, isOpen: false
      })
      await database.insert(trips).values({
        vehicleId, startedAt: at(1), endedAt: at(13), mileageStart: 100, mileageEnd: 102, distance: 2, isOpen: false
      })
      const [annotated] = await database.insert(trips).values({
        vehicleId, startedAt: at(15), endedAt: at(19), mileageStart: 102, mileageEnd: 105, distance: 3,
        comment: 'заезжал на мойку', driver: 'Игорь', isOpen: false
      }).returning()

      await recomputeTrips(database, { apply: true })
      const kept = await database.query.trips.findFirst({ where: eq(trips.id, annotated!.id) })
      // Строка на месте вместе с комментарием, но километры вернулись хозяину и
      // больше не считаются дважды.
      expect(kept).toMatchObject({ comment: 'заезжал на мойку', distance: 0 })
      const real = await database.query.trips.findFirst({ where: eq(trips.startedAt, at(1)) })
      expect(real).toMatchObject({ distance: 5, driver: 'Игорь' })
    } finally {
      await database.$client.close()
    }
  })
})
