import { and, eq, gt, lte } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { engineSessions, trips } from '../../db/schema'
import { sessionDistances } from '../../metrics/odometer'
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
    if (starts.has(trip.startedAt.getTime()) || trip.comment || !trip.endedAt) continue
    const shadowed = sessions.some(item => item.startedAt < trip.endedAt! && item.endedAt > trip.startedAt)
    if (!shadowed) continue
    await database.delete(trips).where(eq(trips.id, trip.id))
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
        await database.delete(trips).where(eq(trips.id, trip.id))
        report.removed.push({ tripId: trip.id, startedAt: trip.startedAt })
      }
      continue
    }

    if (trip && !trip.isOpen) {
      const needsUpdate = trip.distance !== item.distance
        || trip.mileageStart !== item.mileageStart
        || trip.mileageEnd !== item.mileageEnd
        || trip.departedAt?.getTime() !== item.departedAt?.getTime()
      if (needsUpdate) {
        await database.update(trips).set({
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
      isOpen: false
    })
    report.created.push({ sessionId: item.sessionId, startedAt: item.startedAt, distance: item.distance })
  }

  return report
}
