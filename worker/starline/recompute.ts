import { eq, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { trips, vehicleSnapshots } from '../../db/schema'
import { recalculateDistances } from './distances'
import { applyEventBoundaries } from './events'

// Разовый проход по накопленной истории. Своей логики у него нет и быть не
// должно: он делает ровно то же, что воркер делает на живом опросе, — сначала
// ставит границы по журналу сигнализации, потом раскладывает километры между
// всеми, кто ехал в том же промежутке между показаниями одометра.
//
// Раньше здесь жил отдельный разбор со своими правилами, и два способа считать
// одно и то же спорили за одни и те же строки.
export interface RecomputeReport {
  sessionsCorrected: number
  sessionsCreated: number
  sessionsUpdated: number
  tripsCreated: Array<{ startedAt: Date, distance: number }>
  tripsRemoved: Array<{ startedAt: Date }>
  tripsUpdated: number
  // Ни один километр не должен ни появиться, ни исчезнуть. Одометр —
  // независимый свидетель, и расхождение с ним значит, что в разборе ошибка.
  distanceBefore: number
  distanceAfter: number
  odometerSpan: number | null
  // Километры, которым не нашлось ни одной работающей минуты двигателя: поездка,
  // которую опрос не увидел вовсе. Приписывать их соседям нельзя.
  unattributed: number
}

export async function recomputeTrips(database: Database, options: { apply: boolean }): Promise<RecomputeReport> {
  const vehicle = await database.query.vehicles.findFirst()
  const [span] = await database.select({
    low: sql<number | null>`min(${vehicleSnapshots.mileage})`,
    high: sql<number | null>`max(${vehicleSnapshots.mileage})`
  }).from(vehicleSnapshots).where(isNotNull(vehicleSnapshots.mileage))
  const before = await database.select({ distance: trips.distance }).from(trips).where(eq(trips.isOpen, false))

  const report: RecomputeReport = {
    sessionsCorrected: 0, sessionsCreated: 0, sessionsUpdated: 0,
    tripsCreated: [], tripsRemoved: [], tripsUpdated: 0,
    distanceBefore: before.reduce((sum, item) => sum + (item.distance ?? 0), 0),
    distanceAfter: 0,
    odometerSpan: span?.low != null && span.high != null ? Number(span.high) - Number(span.low) : null,
    unattributed: 0
  }
  if (!vehicle || !options.apply) return report

  const boundaries = await applyEventBoundaries(database, vehicle.id)
  report.sessionsCorrected = boundaries.corrected.length
  report.sessionsCreated = boundaries.created.length

  // Разбор границ пересчитывает километры сам, поэтому большая часть правок
  // случается уже там; второй проход дочищает то, чего границы не касались.
  const distances = await recalculateDistances(database, vehicle.id)
  report.sessionsUpdated = distances.sessionsUpdated
  report.tripsUpdated = distances.tripsUpdated
  report.tripsCreated = [...boundaries.created, ...distances.created]
    .map(item => ({ startedAt: item.startedAt, distance: item.distance ?? 0 }))
  report.tripsRemoved = [...boundaries.removed, ...distances.removed]
    .map(item => ({ startedAt: item.startedAt }))
  report.unattributed = distances.unattributed

  const after = await database.select({ distance: trips.distance }).from(trips).where(eq(trips.isOpen, false))
  report.distanceAfter = after.reduce((sum, item) => sum + (item.distance ?? 0), 0)
  return report
}
