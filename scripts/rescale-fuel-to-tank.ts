import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import { createDatabase } from '../db/client'
import { engineSessions, refuelEvents, trips, vehicleSnapshots } from '../db/schema'
import { applyReceiptsToRefuel } from '../receipts/store'
import { FUEL_TANK_CAPACITY_LITRES, fuelFromPercent, tripFuelUsed } from '../shared/fuel'

// Every litre figure in the database is the sensor's percentage multiplied by
// whatever tank size was configured when the row was written. Correcting the
// tank size therefore leaves the whole history low by the difference, and no
// amount of scaling fixes it honestly: the percentage is the only thing the car
// ever measured, and only the snapshots kept it.
//
// Snapshots and refuels carry their own percentage and convert exactly. Trips
// and engine sessions kept only the litres, so each boundary is traced back to
// the snapshot it was copied from — the one in the row's own window whose
// recorded litres are still what the boundary says — and that snapshot's
// percentage is converted afresh. Matching against the snapshot rather than
// against a formula is what makes this work on a history written in layers:
// whatever tank size or rounding produced the figure, the snapshot it came from
// carries the same figure.
//
// A boundary that cannot be traced is left alone, and so is the rest of its row.
// Half a row on the new tank and half on the old would make the tank appear to
// refill mid-trip, which is worse than being uniformly low.
const SNAPSHOT_MATCH_GRACE_MS = 15 * 60_000

export interface FuelReading {
  percent: number
  fuel: number
}

function distinct(values: number[]) {
  return [...new Set(values)]
}

// StarLine's own `fuel_converted` — what the older rows hold — is the same
// conversion floored to whole litres, and flooring is not invertible on its own:
// 31 litres is either 62% or 63% of a fifty litre tank. So an exact match is
// taken first, a floored one only when nothing matches exactly, and neither is
// accepted while two readings disagree about the answer.
export function rescaleLitres(
  stored: number | null,
  readings: FuelReading[],
  toCapacity: number = FUEL_TANK_CAPACITY_LITRES
) {
  if (stored == null || !Number.isFinite(stored)) return null
  const converted = (reading: FuelReading) => reading.percent * toCapacity / 100
  const exact = distinct(readings.filter(reading => reading.fuel === stored).map(converted))
  if (exact.length) return exact.length === 1 ? exact[0] : null
  const floored = distinct(readings.filter(reading => Math.floor(reading.fuel) === stored).map(converted))
  return floored.length === 1 ? floored[0] : null
}

const apply = process.argv.includes('--apply')

function litres(value: number | null) {
  return value == null ? '—' : value.toFixed(2)
}

async function main() {
  const database = createDatabase()
  console.log(`Бак: ${FUEL_TANK_CAPACITY_LITRES} л · 1% = ${FUEL_TANK_CAPACITY_LITRES / 100} л`)

  async function windowReadings(vehicleId: number, from: Date, to: Date): Promise<FuelReading[]> {
    const rows = await database.select({
      fuelPercent: vehicleSnapshots.fuelPercent,
      fuel: vehicleSnapshots.fuel
    }).from(vehicleSnapshots).where(and(
      eq(vehicleSnapshots.vehicleId, vehicleId),
      gte(vehicleSnapshots.ts, new Date(from.getTime() - SNAPSHOT_MATCH_GRACE_MS)),
      lte(vehicleSnapshots.ts, new Date(to.getTime() + SNAPSHOT_MATCH_GRACE_MS)),
      isNotNull(vehicleSnapshots.fuelPercent),
      isNotNull(vehicleSnapshots.fuel)
    )).orderBy(asc(vehicleSnapshots.ts))
    return rows.map(row => ({ percent: row.fuelPercent!, fuel: row.fuel! }))
  }

  // Trips and sessions are traced against the snapshots as they stand, so they
  // have to be done before the snapshots themselves move.
  async function rescaleEngineSessions() {
    const rows = await database.select().from(engineSessions).where(eq(engineSessions.isOpen, false))

    let changed = 0
    let partial = 0
    let untraced = 0
    for (const session of rows) {
      if (!session.endedAt) continue
      if (session.fuelStart == null && session.fuelEnd == null) continue
      const readings = await windowReadings(session.vehicleId, session.startedAt, session.endedAt)
      const fuelStart = rescaleLitres(session.fuelStart, readings)
      const fuelEnd = rescaleLitres(session.fuelEnd, readings)
      const startTraced = session.fuelStart == null || fuelStart != null
      const endTraced = session.fuelEnd == null || fuelEnd != null
      if (!startTraced || !endTraced) {
        console.log(`  сессия ${session.id}: ${litres(session.fuelStart)}→${litres(session.fuelEnd)} л`
          + ` — ${startTraced === endTraced ? 'ни один край не опознан' : 'опознан только один край'}, оставлено как было`)
        if (startTraced !== endTraced) partial++
        else untraced++
        continue
      }
      if (fuelStart === session.fuelStart && fuelEnd === session.fuelEnd) continue
      changed++
      if (apply) {
        await database.update(engineSessions)
          .set({ fuelStart: fuelStart ?? session.fuelStart, fuelEnd: fuelEnd ?? session.fuelEnd })
          .where(eq(engineSessions.id, session.id))
      }
    }
    console.log(`сессии двигателя: ${changed} пересчитаны, ${partial} пропущены (опознан только один край), ${untraced} не опознаны`)
  }

  async function rescaleTrips() {
    const rows = await database.select().from(trips).where(eq(trips.isOpen, false))

    let changed = 0
    let partial = 0
    let untraced = 0
    for (const trip of rows) {
      if (!trip.endedAt) continue
      if (trip.fuelStart == null && trip.fuelEnd == null) continue
      const readings = await windowReadings(trip.vehicleId, trip.startedAt, trip.endedAt)
      const fuelStart = rescaleLitres(trip.fuelStart, readings)
      const fuelEnd = rescaleLitres(trip.fuelEnd, readings)
      const startTraced = trip.fuelStart == null || fuelStart != null
      const endTraced = trip.fuelEnd == null || fuelEnd != null
      if (!startTraced || !endTraced) {
        console.log(`  поездка ${trip.id}: ${litres(trip.fuelStart)}→${litres(trip.fuelEnd)} л`
          + ` — ${startTraced === endTraced ? 'ни один край не опознан' : 'опознан только один край'}, оставлено как было`)
        if (startTraced !== endTraced) partial++
        else untraced++
        continue
      }
      if (fuelStart === trip.fuelStart && fuelEnd === trip.fuelEnd) continue
      const fuelUsed = tripFuelUsed(fuelStart, fuelEnd)
      // Both boundaries moved by the same factor, so a rise that was rounding
      // before is still rounding now. Anything else means the pair is not what
      // it looked like, and the row is left as recorded.
      if (fuelUsed == null && trip.fuelUsed != null) {
        console.log(`  поездка ${trip.id}: расход перестал считаться, оставлено как было`)
        partial++
        continue
      }
      changed++
      const before = trip.distance && trip.fuelUsed ? trip.fuelUsed / trip.distance * 100 : null
      const after = trip.distance && fuelUsed ? fuelUsed / trip.distance * 100 : null
      console.log(`  поездка ${trip.id}: ${litres(trip.fuelStart)}→${litres(trip.fuelEnd)} л`
        + ` ⇒ ${litres(fuelStart)}→${litres(fuelEnd)} л`
        + ` · расход ${litres(trip.fuelUsed)} → ${litres(fuelUsed)} л`
        + `${before == null || after == null ? '' : ` · ${before.toFixed(1)} → ${after.toFixed(1)} л/100 км`}`)
      if (apply) {
        await database.update(trips)
          .set({ fuelStart: fuelStart ?? trip.fuelStart, fuelEnd: fuelEnd ?? trip.fuelEnd, fuelUsed })
          .where(eq(trips.id, trip.id))
      }
    }
    console.log(`поездки: ${changed} пересчитаны, ${partial} пропущены (опознан только один край), ${untraced} не опознаны`)
  }

  // The percentage is untouched by the tank size, so the snapshots need no
  // detective work: converting it again is the whole correction.
  async function rescaleSnapshots() {
    const rows = await database.select({
      id: vehicleSnapshots.id,
      fuel: vehicleSnapshots.fuel,
      fuelPercent: vehicleSnapshots.fuelPercent,
      fuelSource: vehicleSnapshots.fuelSource
    }).from(vehicleSnapshots).where(isNotNull(vehicleSnapshots.fuelPercent))

    let changed = 0
    for (const row of rows) {
      const fuel = fuelFromPercent(row.fuelPercent)
      if (fuel == null || (fuel === row.fuel && row.fuelSource === 'percent')) continue
      changed++
      if (apply) {
        await database.update(vehicleSnapshots).set({ fuel, fuelSource: 'percent' })
          .where(eq(vehicleSnapshots.id, row.id))
      }
    }
    console.log(`снимки: ${changed} из ${rows.length} пересчитаны по проценту`)
  }

  async function rescaleRefuels() {
    const rows = await database.select().from(refuelEvents)

    let changed = 0
    for (const refuel of rows) {
      const fuelBefore = fuelFromPercent(refuel.percentBefore) ?? refuel.fuelBefore
      const fuelAfter = fuelFromPercent(refuel.percentAfter) ?? refuel.fuelAfter
      const sensorLitresAdded = fuelBefore != null && fuelAfter != null && fuelAfter > fuelBefore
        ? fuelAfter - fuelBefore
        : refuel.sensorLitresAdded
      if (fuelBefore === refuel.fuelBefore && fuelAfter === refuel.fuelAfter
        && sensorLitresAdded === refuel.sensorLitresAdded) continue
      changed++
      const saturated = refuel.percentAfter === 100 ? ' (бак полный, датчик упёрся в 100%)' : ''
      console.log(`  заправка ${refuel.id}: датчик ${litres(refuel.sensorLitresAdded)} → ${litres(sensorLitresAdded)} л${saturated}`)
      if (apply) {
        await database.update(refuelEvents).set({ fuelBefore, fuelAfter, sensorLitresAdded })
          .where(eq(refuelEvents.id, refuel.id))
        // Receipts outrank the sensor, so this restores the receipt volume on
        // events that have one and the corrected sensor volume on those that do not.
        await applyReceiptsToRefuel(database, refuel.id)
      }
    }
    console.log(`заправки: ${changed} из ${rows.length} пересчитаны`)
  }

  await rescaleEngineSessions()
  await rescaleTrips()
  await rescaleSnapshots()
  await rescaleRefuels()
  console.log(apply ? 'Записано.' : 'Сухой прогон — ничего не записано. Повторите с --apply.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
