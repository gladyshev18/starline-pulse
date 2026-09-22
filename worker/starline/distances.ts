import { and, eq, gt, lte } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { engineSessions, removedTrips, trips } from '../../db/schema'
import { type SessionDistance, sessionDistances } from '../../metrics/odometer'
import { armedMinutesBetween } from '../../metrics/engine'
import { tripFuelUsed } from '../../shared/fuel'

// Доля меньше половины километра — не поездка. Одометр этой машины целый, и
// такая доля целиком лежит внутри его собственной погрешности: отличить
// «проехал триста метров» от «постоял, пока сосед по промежутку ехал» нечем.
// Сессия свои километры сохраняет — по ней считается холостой ход, — а в журнал
// поездок такая запись не попадает.
const MIN_TRIP_DISTANCE = 0.5

export interface DistanceReport {
  sessionsUpdated: number
  tripsUpdated: number
  // Сессии, которым разбор завёл поездку, и записи, оказавшиеся прогревом.
  created: Array<{ sessionId: number, startedAt: Date, distance: number }>
  removed: Array<{ tripId: number, startedAt: Date }>
  total: number
  unattributed: number
}

type Trip = typeof trips.$inferSelect

// Удаление поездки оставляет след. В чате может висеть сообщение с кнопками,
// которые ссылаются на её номер, а имя водителя человек подтверждал руками —
// и то и другое должно доехать до записи, занявшей её место, даже если та
// появится только следующим проходом.
async function removeTrip(database: Database, trip: Trip, successor?: Trip) {
  if (successor) {
    const driver = successor.driver ?? trip.driver
    // Отметка о вопросе переезжает вместе с именем: про одну дорогу
    // спрашивают один раз, кто бы из двух записей её ни представлял.
    const driverAskedAt = successor.driverAskedAt ?? trip.driverAskedAt
    if (driver !== successor.driver || driverAskedAt !== successor.driverAskedAt) {
      await database.update(trips).set({ driver, driverAskedAt }).where(eq(trips.id, successor.id))
    }
  }
  await database.insert(removedTrips).values({
    tripId: trip.id,
    vehicleId: trip.vehicleId,
    startedAt: trip.startedAt,
    endedAt: trip.endedAt,
    driver: trip.driver,
    driverAskedAt: trip.driverAskedAt
  }).onConflictDoNothing()
  await database.delete(trips).where(eq(trips.id, trip.id))
}

// Что осталось от записи, стоявшей на этом же месте до пересчёта.
async function removedAt(database: Database, vehicleId: number, from: Date, to: Date) {
  return await database.query.removedTrips.findFirst({
    where: and(
      eq(removedTrips.vehicleId, vehicleId),
      lte(removedTrips.startedAt, to),
      gt(removedTrips.endedAt, from)
    )
  })
}

// Сессия, с которой запись делит больше всего времени.
function mostOverlapping(sessions: SessionDistance[], from: Date, to: Date) {
  let best: SessionDistance | null = null
  let bestShared = 0
  for (const item of sessions) {
    const shared = Math.min(item.endedAt.getTime(), to.getTime()) - Math.max(item.startedAt.getTime(), from.getTime())
    if (shared > bestShared) { best = item; bestShared = shared }
  }
  return best
}

// Единственное место, где решается, сколько километров у какой записи.
//
// Считается всё разом и по всей истории: доля сессии зависит от того, кто ещё
// делил с ней промежуток между двумя показаниями одометра, поэтому посчитать
// одну запись в отрыве от соседей нельзя. Отсюда же берётся и стыковка —
// начало каждой там, где кончилась предыдущая.
export async function recalculateDistances(database: Database, vehicleId: number): Promise<DistanceReport> {
  const { sessions, unattributed } = await sessionDistances(database, vehicleId)
  const report: DistanceReport = {
    sessionsUpdated: 0, tripsUpdated: 0, created: [], removed: [],
    total: sessions.reduce((sum, item) => sum + item.distance, 0),
    unattributed
  }

  // Записи со старыми границами, оставшиеся от прежнего разбора: у сессии они
  // не числятся, но накрывают её по времени и мешают завести правильную. Такая
  // запись — дубль той же дороги, а не отдельная: 29 августа из-за одной такой
  // вторая поездка дня не появилась вовсе.
  //
  // Поездку, которой не соответствует ни одна сессия, трогать нельзя: это может
  // быть дорога, которую опрос не увидел, и другого следа у неё нет.
  const starts = new Set(sessions.map(item => item.startedAt.getTime()))
  const stale = await database.select().from(trips).where(and(eq(trips.vehicleId, vehicleId), eq(trips.isOpen, false)))
  for (const trip of stale) {
    if (starts.has(trip.startedAt.getTime()) || !trip.endedAt) continue
    // Из накрытых сессий берётся та, с которой запись делит больше всего
    // времени, а не первая по порядку. Прежние границы поездки почти всегда
    // начинаются раньше настоящих — опрос застаёт зажигание уже включённым, —
    // и первой в этот промежуток попадает предыдущая сессия. 4 сентября так
    // вышло бы, что дорога досталась пятиминутному прогреву перед ней, а не
    // шестнадцати минутам, которые она и есть.
    const shadowed = mostOverlapping(sessions, trip.startedAt, trip.endedAt)
    if (!shadowed) continue

    const owner = await database.query.trips.findFirst({
      where: and(eq(trips.vehicleId, vehicleId), eq(trips.startedAt, shadowed.startedAt))
    })
    // Своей поездки у сессии ещё нет — значит это она и есть, просто с прежними
    // границами. Переносим, а не удаляем: комментарий писал человек, имя
    // водителя он же и подтвердил, и терять их из-за неточных границ нельзя.
    if (!owner) {
      await database.update(trips).set({
        startedAt: shadowed.startedAt,
        endedAt: shadowed.endedAt,
        departedAt: shadowed.departedAt
      }).where(eq(trips.id, trip.id))
      starts.add(shadowed.startedAt.getTime())
      report.tripsUpdated++
      continue
    }
    // Поездка у сессии уже есть, а эта запись — её дубль с чужими границами.
    if (trip.comment) continue
    await removeTrip(database, trip, owner)
    report.removed.push({ tripId: trip.id, startedAt: trip.startedAt })
  }

  for (const item of sessions) {
    const session = await database.query.engineSessions.findFirst({
      where: eq(engineSessions.id, item.sessionId)
    })
    if (!session) continue

    const changed = session.distance !== item.distance
      || session.mileageStart !== item.mileageStart
      || session.mileageEnd !== item.mileageEnd
    if (changed) {
      await database.update(engineSessions).set({
        mileageStart: item.mileageStart,
        mileageEnd: item.mileageEnd,
        distance: item.distance,
        isStationary: item.distance === 0
      }).where(eq(engineSessions.id, session.id))
      report.sessionsUpdated++
    }

    const trip = await database.query.trips.findFirst({
      where: and(eq(trips.vehicleId, vehicleId), eq(trips.startedAt, session.startedAt))
    })

    // Машина никуда не уехала — это прогрев, и в журнале поездок ему не место.
    // Сам прогрев остаётся сессией, по ней его считает счёт холостого хода.
    // Комментарий писали руками, и запись с ним остаётся.
    if (trip && !trip.isOpen && item.distance < MIN_TRIP_DISTANCE) {
      if (!trip.comment) {
        await removeTrip(database, trip)
        report.removed.push({ tripId: trip.id, startedAt: trip.startedAt })
      }
      continue
    }

    if (trip && !trip.isOpen) {
      // Конец поездки идёт за концом сессии. Обычно они и так совпадают, но
      // если журнал сигнализации потерял выключение зажигания, а потом нашёлся
      // — разбор границ укоротит сессию, и поездка должна укоротиться вместе с
      // ней. Иначе она остаётся с прежним концом: 21 сентября дорога на двадцать
      // восемь минут числилась пятнадцатью часами.
      const needsUpdate = trip.distance !== item.distance
        || trip.mileageStart !== item.mileageStart
        || trip.mileageEnd !== item.mileageEnd
        || trip.departedAt?.getTime() !== item.departedAt?.getTime()
        || trip.endedAt?.getTime() !== item.endedAt.getTime()
      if (needsUpdate) {
        await database.update(trips).set({
          endedAt: item.endedAt,
          mileageStart: item.mileageStart,
          mileageEnd: item.mileageEnd,
          distance: item.distance,
          departedAt: item.departedAt
        }).where(eq(trips.id, trip.id))
        report.tripsUpdated++
      }
      continue
    }
    if (trip) continue

    // Сессия проехала, а поездки у неё нет: опрос проспал запуск целиком либо
    // одометр отчитался за неё только потом. Дорога была — значит ей место в
    // журнале.
    if (!(item.distance >= MIN_TRIP_DISTANCE)) continue
    const covered = await database.query.trips.findFirst({
      where: and(
        eq(trips.vehicleId, vehicleId),
        lte(trips.startedAt, item.endedAt),
        gt(trips.endedAt, item.startedAt)
      )
    })
    if (covered) continue

    // Та же дорога могла уже стоять здесь с прежними границами: разбор снёс
    // её и заводит заново. Имя водителя и отметка о заданном вопросе
    // переезжают вместе с ней — иначе имя пропадёт, а бот спросит второй раз
    // про ту же поездку.
    const previous = await removedAt(database, vehicleId, item.startedAt, item.endedAt)
    await database.insert(trips).values({
      vehicleId,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      departedAt: item.departedAt,
      mileageStart: item.mileageStart,
      mileageEnd: item.mileageEnd,
      distance: item.distance,
      fuelStart: session.fuelStart,
      fuelEnd: session.fuelEnd,
      fuelUsed: tripFuelUsed(session.fuelStart, session.fuelEnd),
      armedMinutes: await armedMinutesBetween(database, vehicleId, item.startedAt, item.endedAt),
      driver: previous?.driver ?? null,
      driverAskedAt: previous?.driverAskedAt ?? null,
      isOpen: false
    })
    report.created.push({ sessionId: item.sessionId, startedAt: item.startedAt, distance: item.distance })
  }

  return report
}
