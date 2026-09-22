import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { and, asc, eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createDatabase } from '../db/client'
import { engineSessions, jobs, removedTrips, trips, vehicles, vehicleSnapshots } from '../db/schema'
import { closeTrip } from '../worker/starline/trips'
import { recalculateDistances } from '../worker/starline/distances'
import { askAboutClosedTrips, resolveTrip } from '../worker/bot/trip-driver'

type Database = ReturnType<typeof createDatabase>

const BASE = new Date('2026-09-22T05:00:00.000Z').getTime()
const at = (minute: number) => new Date(BASE + minute * 60_000)

async function setup() {
  const database = createDatabase(':memory:')
  await migrate(database, { migrationsFolder: resolve('db/migrations') })
  const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
  return { database, vehicle }
}

async function snapshot(
  database: Database,
  vehicleId: number,
  minute: number,
  ignition: boolean,
  mileage: number,
  armed = false
) {
  const ts = at(minute)
  await database.insert(vehicleSnapshots).values({
    vehicleId, ts, activityTs: ts, ignition, armed, mileage, mileageTs: ts, rawJson: '{}'
  })
}

async function driverQuestions(database: Database) {
  const rows = await database.select().from(jobs).where(eq(jobs.type, 'telegram:notify')).orderBy(asc(jobs.id))
  return rows.map(row => JSON.parse(row.payload) as { text: string, tripId?: number })
}

describe('Вопрос о водителе переживает пересчёт границ', () => {
  // Боевой случай 22 сентября: опрос закрыл поездку с предварительными 7 км,
  // пересчёт тут же снёс её как прогрев и завёл на её месте другую на 4 км —
  // а вопрос уже улетел в чат с номером несуществующей записи и без кнопок.
  it('спрашивает о той поездке, что пережила пересчёт, и с её километрами', async () => {
    const { database, vehicle } = await setup()
    // Прогрев на автозапуске: двигатель работал, охрана не снималась — ехать
    // так нельзя, и километров этой сессии не достанется ни одного.
    await snapshot(database, vehicle.id, 0, true, 100, true)
    await snapshot(database, vehicle.id, 5, true, 100, true)
    // Дорога, за которую и пришли четыре километра.
    await snapshot(database, vehicle.id, 20, true, 100)
    await snapshot(database, vehicle.id, 40, true, 104)
    await snapshot(database, vehicle.id, 45, false, 104)

    await database.insert(engineSessions).values([
      { vehicleId: vehicle.id, startedAt: at(0), endedAt: at(5), isOpen: false },
      { vehicleId: vehicle.id, startedAt: at(20), endedAt: at(40), isOpen: false }
    ])
    // Поездка, заведённая опросом по прогреву: журнал ещё не сказал, что
    // машина в эти пять минут никуда не ехала.
    const [open] = await database.insert(trips).values({
      vehicleId: vehicle.id, startedAt: at(0), mileageStart: 100, isOpen: true
    }).returning()

    await closeTrip(database, { vehicleId: vehicle.id, tripId: open.id })

    const alive = await database.select().from(trips)
    expect(alive).toHaveLength(1)
    expect(alive[0].id).not.toBe(open.id)
    expect(alive[0].distance).toBeCloseTo(4, 5)

    const questions = await driverQuestions(database)
    expect(questions).toHaveLength(1)
    expect(questions[0].tripId).toBe(alive[0].id)
    expect(questions[0].text).toContain('Расстояние: 4.0 км')
    expect(questions[0].text).toContain('Кто был за рулём?')
    // Отметка о вопросе живёт в самой поездке, чтобы второго раза не было.
    expect(alive[0].driverAskedAt).not.toBeNull()
  })

  it('спрашивает о каждой поездке один раз, сколько бы проходов ни было', async () => {
    const { database, vehicle } = await setup()
    const [trip] = await database.insert(trips).values({
      vehicleId: vehicle.id, startedAt: at(0), endedAt: at(30), distance: 12, isOpen: false
    }).returning()

    expect(await askAboutClosedTrips(database, vehicle.id, at(-60))).toBe(1)
    expect(await askAboutClosedTrips(database, vehicle.id, at(-60))).toBe(0)
    expect(await driverQuestions(database)).toHaveLength(1)
    expect((await database.query.trips.findFirst({ where: eq(trips.id, trip.id) }))?.driverAskedAt).not.toBeNull()
  })

  it('не трогает поездки старше окна и открытые', async () => {
    const { database, vehicle } = await setup()
    await database.insert(trips).values([
      { vehicleId: vehicle.id, startedAt: at(-600), endedAt: at(-570), distance: 8, isOpen: false },
      { vehicleId: vehicle.id, startedAt: at(0), isOpen: true }
    ])
    expect(await askAboutClosedTrips(database, vehicle.id, at(-60))).toBe(0)
    expect(await driverQuestions(database)).toHaveLength(0)
  })
})

describe('Ответ на сообщение о заменённой поездке', () => {
  it('находит запись, занявшую место удалённой', async () => {
    const { database, vehicle } = await setup()
    const [successor] = await database.insert(trips).values({
      vehicleId: vehicle.id, startedAt: at(2), endedAt: at(30), distance: 12, isOpen: false
    }).returning()
    await database.insert(removedTrips).values({
      tripId: 777, vehicleId: vehicle.id, startedAt: at(0), endedAt: at(29)
    })

    expect((await resolveTrip(database, successor.id))?.id).toBe(successor.id)
    expect((await resolveTrip(database, 777))?.id).toBe(successor.id)
    // След есть, а преемника нет: отвечать некуда, и это честнее подмены.
    await database.insert(removedTrips).values({
      tripId: 778, vehicleId: vehicle.id, startedAt: at(600), endedAt: at(630)
    })
    expect(await resolveTrip(database, 778)).toBeNull()
    expect(await resolveTrip(database, 999)).toBeNull()
  })

  it('передаёт преемнику названное имя и отметку о вопросе', async () => {
    const { database, vehicle } = await setup()
    // Дубль с прежними границами и та же дорога с точными: пересчёт снимет
    // первую, но подтверждённого человеком водителя терять нельзя.
    await snapshot(database, vehicle.id, 0, true, 100)
    await snapshot(database, vehicle.id, 30, true, 112)
    await snapshot(database, vehicle.id, 35, false, 112)
    await database.insert(engineSessions).values({
      vehicleId: vehicle.id, startedAt: at(2), endedAt: at(30), isOpen: false
    })
    const [stale] = await database.insert(trips).values({
      vehicleId: vehicle.id, startedAt: at(0), endedAt: at(31), distance: 12,
      driver: 'Кристина', driverAskedAt: at(31), isOpen: false
    }).returning()
    const [owner] = await database.insert(trips).values({
      vehicleId: vehicle.id, startedAt: at(2), endedAt: at(30), distance: 12, isOpen: false
    }).returning()

    await recalculateDistances(database, vehicle.id)

    const alive = await database.select().from(trips)
    expect(alive.map(item => item.id)).toEqual([owner.id])
    expect(alive[0].driver).toBe('Кристина')
    expect(alive[0].driverAskedAt).not.toBeNull()
    // И вопрос об этой дороге второй раз не задаётся.
    expect(await askAboutClosedTrips(database, vehicle.id, at(-60))).toBe(0)

    const trace = await database.query.removedTrips.findFirst({ where: eq(removedTrips.tripId, stale.id) })
    expect(trace).toMatchObject({ driver: 'Кристина' })
    expect((await resolveTrip(database, stale.id))?.id).toBe(owner.id)
  })

  it('возвращает имя дороге, которую пересчёт завёл заново', async () => {
    const { database, vehicle } = await setup()
    await database.insert(removedTrips).values({
      tripId: 500, vehicleId: vehicle.id, startedAt: at(0), endedAt: at(30),
      driver: 'Игорь', driverAskedAt: at(31)
    })
    await snapshot(database, vehicle.id, 0, true, 100)
    await snapshot(database, vehicle.id, 30, true, 112)
    await snapshot(database, vehicle.id, 35, false, 112)
    await database.insert(engineSessions).values({
      vehicleId: vehicle.id, startedAt: at(1), endedAt: at(30), isOpen: false
    })

    await recalculateDistances(database, vehicle.id)

    const created = await database.query.trips.findFirst({
      where: and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false))
    })
    expect(created?.driver).toBe('Игорь')
    expect(await askAboutClosedTrips(database, vehicle.id, at(-60))).toBe(0)
  })
})
