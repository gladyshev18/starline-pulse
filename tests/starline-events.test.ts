import { describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { asc } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createDatabase } from '../db/client'
import { deviceEvents, engineSessions, trips, vehicles, vehicleSnapshots } from '../db/schema'
import { applyEventBoundaries, ignitionSpans, storeEvents, syncEvents } from '../worker/starline/events'
import {
  ENGINE_STARTED, ENGINE_STOPPED, HANDBRAKE_RELEASED, IGNITION_OFF, IGNITION_ON
} from '../shared/starline-events'

// Опрос видит машину раз в полминуты на ходу и раз в полчаса на стоянке, и на
// боевых данных за август это стоило 27 пропущенных запусков двигателя и
// опоздания стартов на 73 секунды в медиане. Журнал сигнализации знает то же
// самое с точностью до секунды.
describe('границы поездок по журналу сигнализации', () => {
  const base = new Date('2026-08-05T09:00:00.000Z')
  const at = (minute: number) => new Date(base.getTime() + minute * 60_000)
  const seconds = (minute: number) => Math.floor(at(minute).getTime() / 1000)

  const build = async () => {
    const database = createDatabase(':memory:')
    await migrate(database, { migrationsFolder: resolve('db/migrations') })
    const [vehicle] = await database.insert(vehicles).values({ deviceId: '42', alias: 'Car' }).returning()
    const snapshot = async (minute: number, mileage: number, mileageMinute = minute) => {
      await database.insert(vehicleSnapshots).values({
        vehicleId: vehicle!.id, ts: at(minute), activityTs: at(minute), ignition: false, armed: true,
        mileage, mileageTs: at(mileageMinute), fuel: 30, fuelSource: 'converted', fuelTs: at(minute), rawJson: '{}'
      })
    }
    const session = async (from: number, to: number, mileageStart: number, mileageEnd: number) => {
      const [row] = await database.insert(engineSessions).values({
        vehicleId: vehicle!.id, startedAt: at(from), endedAt: at(to),
        mileageStart, mileageEnd, distance: mileageEnd - mileageStart,
        durationMinutes: to - from, isOpen: false
      }).returning()
      return row!
    }
    return { database, vehicle: vehicle!, snapshot, session }
  }

  it('не останавливает выборку на неполной странице', async () => {
    const { database, vehicle } = await build()
    try {
      // Сервер режет выдачу и по своим окнам: за тихие сутки страница приходит
      // короткой, но события после неё есть. Обрыв на этом месте оставил
      // журнал на трёх днях вместо трёх недель.
      // Курсор первого захода отсчитывается от «сейчас», поэтому и события
      // должны быть свежими — иначе выборка справедливо решит, что не сдвинулась.
      const recent = Math.floor(Date.now() / 1000) - 3600
      const pages = [
        [{ type: IGNITION_ON, groupId: 5, timestamp: recent }],
        [{ type: IGNITION_OFF, groupId: 5, timestamp: recent + 900 }],
        []
      ]
      let calls = 0
      await syncEvents(database, vehicle.id, async () => pages[calls++] ?? [])
      expect(calls).toBeGreaterThanOrEqual(3)
      const stored = await database.select().from(deviceEvents)
      expect(stored).toHaveLength(2)
    } finally {
      await database.$client.close()
    }
  })

  it('собирает интервалы зажигания и не считает вторым запуском повтор кода', async () => {
    const { database, vehicle } = await build()
    try {
      await storeEvents(database, vehicle.id, [
        { type: IGNITION_ON, groupId: 5, timestamp: seconds(1) },
        // Тот же запуск, доехавший вторым кодом: это не второй старт.
        { type: ENGINE_STARTED, groupId: 5, timestamp: seconds(1) + 2 },
        { type: HANDBRAKE_RELEASED, groupId: 5, timestamp: seconds(1) + 12 },
        { type: IGNITION_OFF, groupId: 5, timestamp: seconds(20) },
        { type: ENGINE_STOPPED, groupId: 5, timestamp: seconds(20) },
        { type: IGNITION_ON, groupId: 5, timestamp: seconds(40) },
        { type: IGNITION_OFF, groupId: 5, timestamp: seconds(55) }
      ])
      const spans = await ignitionSpans(database, vehicle.id)
      expect(spans).toHaveLength(2)
      expect(spans[0]!.startedAt.getTime()).toBe(at(1).getTime())
      expect(spans[0]!.endedAt.getTime()).toBe(at(20).getTime())
      expect(spans[1]!.startedAt.getTime()).toBe(at(40).getTime())
    } finally {
      await database.$client.close()
    }
  })

  it('переносит опоздавший старт сессии и её поездку на точное время события', async () => {
    const { database, vehicle, snapshot, session } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(25, 120, 20)
      // Опрос застал зажигание только на седьмой минуте, хотя завели на первой.
      const stored = await session(7, 20, 100, 120)
      const [trip] = await database.insert(trips).values({
        vehicleId: vehicle.id, startedAt: at(7), endedAt: at(20),
        mileageStart: 100, mileageEnd: 120, distance: 20, isOpen: false
      }).returning()

      await storeEvents(database, vehicle.id, [
        { type: IGNITION_ON, groupId: 5, timestamp: seconds(1) },
        { type: IGNITION_OFF, groupId: 5, timestamp: seconds(20) }
      ])
      const report = await applyEventBoundaries(database, vehicle.id)
      expect(report.corrected).toHaveLength(1)
      expect(report.corrected[0]!.shiftedStartSeconds).toBe(6 * 60)

      const [fixed] = await database.select().from(engineSessions)
      expect(fixed!.startedAt.getTime()).toBe(at(1).getTime())
      expect(fixed!.durationMinutes).toBe(19)
      expect(fixed!.id).toBe(stored.id)

      // Поездка привязана к сессии равенством started_at, поэтому обязана
      // переехать вместе с ней — иначе перестанет находить свою сессию.
      const [movedTrip] = await database.select().from(trips)
      expect(movedTrip!.id).toBe(trip!.id)
      expect(movedTrip!.startedAt.getTime()).toBe(at(1).getTime())
    } finally {
      await database.$client.close()
    }
  })

  it('заводит сессию и поездку для запуска, который опрос проспал целиком', async () => {
    const { database, vehicle, snapshot } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(60, 130, 55)

      await storeEvents(database, vehicle.id, [
        { type: IGNITION_ON, groupId: 5, timestamp: seconds(10) },
        { type: IGNITION_OFF, groupId: 5, timestamp: seconds(50) }
      ])
      const report = await applyEventBoundaries(database, vehicle.id)
      expect(report.created).toHaveLength(1)
      expect(report.created[0]!.distance).toBe(30)

      const [session] = await database.select().from(engineSessions)
      expect(session).toMatchObject({ distance: 30, isStationary: false })
      expect(session!.startedAt.getTime()).toBe(at(10).getTime())

      const [trip] = await database.select().from(trips)
      expect(trip).toMatchObject({ mileageStart: 100, mileageEnd: 130, distance: 30, isOpen: false })
    } finally {
      await database.$client.close()
    }
  })

  it('не заводит поездку для пропущенного запуска, если машина стояла', async () => {
    const { database, vehicle, snapshot } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(60, 100, 0)
      await storeEvents(database, vehicle.id, [
        { type: IGNITION_ON, groupId: 5, timestamp: seconds(10) },
        { type: IGNITION_OFF, groupId: 5, timestamp: seconds(18) }
      ])
      await applyEventBoundaries(database, vehicle.id)

      const sessions = await database.select().from(engineSessions)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({ distance: 0, isStationary: true })
      expect(await database.select().from(trips)).toHaveLength(0)
    } finally {
      await database.$client.close()
    }
  })

  // На боевых данных 14 августа опрос пропустил выключение зажигания посередине
  // и склеил два запуска в одну сессию на 41 минуту. Короткий интервал, лежащий
  // внутри неё, отобрал бы у поездки тридцать две минуты.
  it('не схлопывает длинную сессию до короткого интервала внутри неё', async () => {
    const { database, vehicle, snapshot, session } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(80, 160, 75)
      const long = await session(10, 51, 100, 160)

      await storeEvents(database, vehicle.id, [
        { type: IGNITION_ON, groupId: 5, timestamp: seconds(12) },
        { type: IGNITION_OFF, groupId: 5, timestamp: seconds(21) }
      ])
      const report = await applyEventBoundaries(database, vehicle.id)
      expect(report.corrected).toHaveLength(0)

      const [untouched] = await database.select().from(engineSessions)
      expect(untouched!.id).toBe(long.id)
      expect(untouched!.startedAt.getTime()).toBe(at(10).getTime())
      expect(untouched!.endedAt!.getTime()).toBe(at(51).getTime())
    } finally {
      await database.$client.close()
    }
  })

  // На боевых данных 27 августа машину заводили семь раз за час. Сопоставление
  // «ближайший интервал в пределах получаса» приписало тогда стодесятиминутной
  // поездке семиминутный интервал и выдало 842 км/ч.
  it('не сопоставляет длинную поездку с коротким чужим интервалом', async () => {
    const { database, vehicle, snapshot, session } = await build()
    try {
      await snapshot(0, 100, 0)
      await snapshot(200, 200, 195)
      const long = await session(10, 120, 100, 200)

      await storeEvents(database, vehicle.id, [
        // Короткий чужой запуск за пять минут до длинной поездки.
        { type: IGNITION_ON, groupId: 5, timestamp: seconds(5) },
        { type: IGNITION_OFF, groupId: 5, timestamp: seconds(8) }
      ])
      const report = await applyEventBoundaries(database, vehicle.id)

      // Пересечения нет вовсе, значит это отдельный запуск, а не та же поездка.
      expect(report.corrected).toHaveLength(0)
      expect(report.created).toHaveLength(1)
      const untouched = await database.select().from(engineSessions).orderBy(asc(engineSessions.startedAt))
      expect(untouched.find(item => item.id === long.id)!.startedAt.getTime()).toBe(at(10).getTime())
    } finally {
      await database.$client.close()
    }
  })
})
