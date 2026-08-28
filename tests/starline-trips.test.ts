import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { desc, eq } from 'drizzle-orm'
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

  // Одометр отдаёт пробег кусками и досылает остаток уже после того, как
  // двигатель заглушили. На боевых данных так приходит каждый восьмой километр,
  // и раньше каждая такая досылка становилась отдельной поездкой на стоящей
  // машине — тремя километрами за две минуты, то есть 90 км/ч на парковке.
  describe('odometer flushing after the engine stopped', () => {
    const build = async () => {
      const database = createDatabase(':memory:')
      await migrate(database, { migrationsFolder: resolve('db/migrations') })
      const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
      const base = new Date('2026-08-05T09:00:00.000Z')
      let previous: typeof vehicleSnapshots.$inferSelect | undefined
      const feed = async (minute: number, ignition: boolean, mileage: number, motorMinutes: number) => {
        const ts = new Date(base.getTime() + minute * 60_000)
        const [row] = await database.insert(vehicleSnapshots).values({
          vehicleId: vehicle!.id,
          ts,
          activityTs: ts,
          ignition,
          mileage,
          mileageTs: ts,
          fuel: 30,
          fuelSource: 'converted',
          fuelTs: ts,
          motorMinutes,
          rawJson: '{}'
        }).returning()
        await aggregateSnapshot(database, vehicle!.id, row!, previous)
        await handleMileageProgress(database, vehicle!.id, row!, previous)
        previous = row
        return row!
      }
      return { database, vehicle: vehicle!, feed }
    }

    it('adds the late reading to the trip that drove it instead of inventing one', async () => {
      const { database, vehicle, feed } = await build()
      try {
        await feed(0, false, 100, 500)
        await feed(1, true, 100, 501)
        // Одометр отчитался о трёх километрах ещё на ходу — поездка открылась.
        await feed(5, true, 103, 505)
        const open = await database.query.trips.findFirst()
        await feed(6, false, 103, 506)
        await closeTrip(database, { vehicleId: vehicle.id, tripId: open!.id })

        // Через восемь минут стоянки приходят оставшиеся четыре километра.
        await feed(14, false, 107, 506)

        const all = await database.select().from(trips)
        expect(all).toHaveLength(1)
        expect(all[0]).toMatchObject({ mileageStart: 100, mileageEnd: 107, distance: 7, isOpen: false })

        // Сессия тоже должна забрать хвост, иначе её distance останется
        // трёхкилометровым, а по нему считается is_stationary.
        const [session] = await database.select().from(engineSessions)
        expect(session).toMatchObject({ mileageEnd: 107, distance: 7, isStationary: false })
      } finally {
        await database.$client.close()
      }
    })

    it('marks a session as moving once its distance arrives late', async () => {
      const { database, vehicle, feed } = await build()
      try {
        await feed(0, false, 100, 500)
        await feed(1, true, 100, 501)
        // Двигатель проработал две минуты и одометр не сказал ни слова, поэтому
        // поездки нет вовсе, а сессия закрылась как прогрев.
        await feed(3, false, 100, 503)
        const parked = await database.select().from(engineSessions)
        expect(parked[0]).toMatchObject({ distance: 0, isStationary: true })

        // Через десять минут выясняется, что машина проехала два километра.
        await feed(13, false, 102, 503)

        const all = await database.select().from(trips)
        expect(all).toHaveLength(1)
        expect(all[0]).toMatchObject({ mileageStart: 100, isOpen: true })
        // Поездка привязалась к сессии, а не к моменту, когда пришла досылка.
        expect(all[0]!.startedAt.getTime()).toBe(new Date('2026-08-05T09:01:00.000Z').getTime())

        await closeTrip(database, { vehicleId: vehicle.id, tripId: all[0]!.id })
        const closed = await database.query.trips.findFirst()
        expect(closed).toMatchObject({ mileageStart: 100, mileageEnd: 102, distance: 2, isOpen: false })
        const [session] = await database.select().from(engineSessions)
        expect(session).toMatchObject({ isStationary: false })
      } finally {
        await database.$client.close()
      }
    })

    it('still records a trip the poller slept through, because the engine clock saw it', async () => {
      const { database, feed } = await build()
      try {
        await feed(0, false, 100, 500)
        await feed(1, true, 100, 501)
        await feed(5, true, 103, 505)
        const open = await database.query.trips.findFirst()
        await feed(6, false, 103, 506)
        await closeTrip(database, { vehicleId: 1, tripId: open!.id })

        // Опрос спит по пять минут на стоянке, и целая поездка уместилась между
        // двумя запросами. Зажигания не видел никто, но моточасы выросли на
        // одиннадцать минут — значит машина ехала, а не одометр досылал.
        await feed(20, false, 118, 517)

        const all = await database.select().from(trips)
        expect(all).toHaveLength(2)
        expect(all[1]).toMatchObject({ mileageStart: 103, isOpen: true })
      } finally {
        await database.$client.close()
      }
    })

    it('leaves the reading alone when it does not continue from the last trip', async () => {
      const { database, vehicle, feed } = await build()
      try {
        await feed(0, false, 100, 500)
        await feed(1, true, 100, 501)
        await feed(5, true, 103, 505)
        const open = await database.query.trips.findFirst()
        await feed(6, false, 103, 506)
        await closeTrip(database, { vehicleId: vehicle.id, tripId: open!.id })
        const closed = await database.query.trips.findFirst()
        expect(closed).toMatchObject({ mileageEnd: 103 })

        // Показание прыгнуло не с того места, на котором поездка закончилась:
        // где машина взяла эти километры, данных нет, и дописывать их наугад
        // хуже, чем оставить как есть.
        await database.insert(vehicleSnapshots).values({
          vehicleId: vehicle.id, ts: new Date('2026-08-05T09:20:00.000Z'), activityTs: new Date('2026-08-05T09:20:00.000Z'),
          ignition: false, mileage: 150, mileageTs: new Date('2026-08-05T09:20:00.000Z'), motorMinutes: 506, rawJson: '{}'
        })
        const [drifted] = await database.select().from(vehicleSnapshots).orderBy(desc(vehicleSnapshots.ts)).limit(1)
        const stale = { ...drifted!, mileage: 140 }
        await handleMileageProgress(database, vehicle.id, drifted!, stale)

        const all = await database.select().from(trips)
        expect(all).toHaveLength(1)
        expect(all[0]).toMatchObject({ mileageEnd: 103, distance: 3 })
      } finally {
        await database.$client.close()
      }
    })
  })

  // Обе истории ниже случились на боевых данных 28 августа и вместе дали
  // поездку в 5470 км/ч: прогрев на автозапуске стал поездкой, не закрылся,
  // потому что к сроку закрытия машину уже завели снова, и забрал себе
  // двадцать пять километров следующей дороги, оставшись при своих шести
  // минутах.
  describe('a warm-up on the remote start', () => {
    const build = async () => {
      const database = createDatabase(':memory:')
      await migrate(database, { migrationsFolder: resolve('db/migrations') })
      const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
      const base = new Date('2026-08-05T09:00:00.000Z')
      let previous: typeof vehicleSnapshots.$inferSelect | undefined
      const feed = async (minute: number, state: {
        ignition: boolean, armed: boolean, mileage: number, mileageMinute: number, motorMinutes: number
      }) => {
        const ts = new Date(base.getTime() + minute * 60_000)
        const [row] = await database.insert(vehicleSnapshots).values({
          vehicleId: vehicle!.id,
          ts,
          activityTs: ts,
          ignition: state.ignition,
          armed: state.armed,
          mileage: state.mileage,
          mileageTs: new Date(base.getTime() + state.mileageMinute * 60_000),
          fuel: 30,
          fuelSource: 'converted',
          fuelTs: ts,
          motorMinutes: state.motorMinutes,
          rawJson: '{}'
        }).returning()
        await aggregateSnapshot(database, vehicle!.id, row!, previous)
        await handleMileageProgress(database, vehicle!.id, row!, previous)
        previous = row
        return row!
      }
      return { database, vehicle: vehicle!, feed, base }
    }

    it('is not a trip, even when the odometer flushes yesterday inside it', async () => {
      const { database, vehicle, feed } = await build()
      try {
        await feed(0, { ignition: false, armed: true, mileage: 100, mileageMinute: 0, motorMinutes: 500 })
        await feed(1, { ignition: true, armed: false, mileage: 100, mileageMinute: 1, motorMinutes: 501 })
        await feed(5, { ignition: true, armed: false, mileage: 103, mileageMinute: 5, motorMinutes: 505 })
        const drive = await database.query.trips.findFirst()
        await feed(6, { ignition: false, armed: true, mileage: 103, mileageMinute: 6, motorMinutes: 506 })
        await closeTrip(database, { vehicleId: vehicle.id, tripId: drive!.id })

        // Через полчаса машину заводят с брелка: сигнализация не снята, ехать
        // нельзя. OBD просыпается вместе с двигателем и читает одометр заново —
        // на четыре километра больше, чем успел отчитаться в прошлый раз. Метка
        // у чтения свежая, и только охрана доказывает, что эти километры не
        // проеханы сейчас.
        await feed(30, { ignition: true, armed: true, mileage: 103, mileageMinute: 6, motorMinutes: 510 })
        await feed(32, { ignition: true, armed: true, mileage: 107, mileageMinute: 32, motorMinutes: 512 })
        await feed(34, { ignition: false, armed: true, mileage: 107, mileageMinute: 32, motorMinutes: 514 })

        const all = await database.select().from(trips)
        expect(all).toHaveLength(1)
        expect(all[0]).toMatchObject({ mileageStart: 100, mileageEnd: 107, distance: 7 })

        const sessions = await database.select().from(engineSessions).orderBy(engineSessions.startedAt)
        expect(sessions).toHaveLength(2)
        expect(sessions[0]).toMatchObject({ distance: 7, isStationary: false })
        expect(sessions[1]).toMatchObject({ distance: 0, isStationary: true })
      } finally {
        await database.$client.close()
      }
    })
  })

  it('closes a trip with its own session even if the engine is already running again', async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const base = new Date('2026-08-05T09:00:00.000Z')
    let previous: typeof vehicleSnapshots.$inferSelect | undefined
    const feed = async (minute: number, ignition: boolean, mileage: number, motorMinutes: number) => {
      const ts = new Date(base.getTime() + minute * 60_000)
      const [row] = await database.insert(vehicleSnapshots).values({
        vehicleId: vehicle!.id, ts, activityTs: ts, ignition, armed: !ignition,
        mileage, mileageTs: ts, fuel: 30, fuelSource: 'converted', fuelTs: ts, motorMinutes, rawJson: '{}'
      }).returning()
      await aggregateSnapshot(database, vehicle!.id, row!, previous)
      await handleMileageProgress(database, vehicle!.id, row!, previous)
      previous = row
      return row!
    }

    try {
      await feed(0, false, 100, 500)
      await feed(1, true, 100, 501)
      await feed(3, true, 103, 503)
      const first = await database.query.trips.findFirst()
      await feed(4, false, 103, 504)

      // Закрытие поездки отложено на три минуты, и за это время машину успевают
      // завести снова. Прежде поездка на этом оставалась открытой навсегда и
      // забирала себе следующую дорогу.
      await feed(6, true, 103, 506)
      const closed = await closeTrip(database, { vehicleId: vehicle!.id, tripId: first!.id })
      expect(closed).toMatchObject({
        endedAt: new Date(base.getTime() + 4 * 60_000),
        mileageStart: 100,
        mileageEnd: 103,
        distance: 3,
        isOpen: false
      })

      await feed(10, true, 113, 510)
      await feed(12, false, 113, 512)
      const second = await database.query.trips.findFirst({ where: eq(trips.isOpen, true) })
      await closeTrip(database, { vehicleId: vehicle!.id, tripId: second!.id })

      const all = await database.select().from(trips).orderBy(trips.startedAt)
      expect(all).toHaveLength(2)
      expect(all[1]).toMatchObject({
        startedAt: new Date(base.getTime() + 6 * 60_000),
        endedAt: new Date(base.getTime() + 12 * 60_000),
        mileageStart: 103,
        mileageEnd: 113,
        distance: 10
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
