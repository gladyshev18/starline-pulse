import 'dotenv/config'
import { and, asc, eq, gte, isNotNull, lte } from 'drizzle-orm'
import { createDatabase } from '../db/client'
import { engineSessions, refuelEvents, trips, vehicleSnapshots } from '../db/schema'
import { applyReceiptsToRefuel } from '../receipts/store'
import { FUEL_TANK_CAPACITY_LITRES, fuelFromPercent } from '../shared/fuel'

// Every litre figure recorded before the switch came from StarLine's
// `fuel_converted`, which is the stored percentage floored to whole litres. The
// percentage survived in every snapshot, so the half litre the floor dropped
// can be put back.
//
// Snapshots and refuels carry their own percentage, so they convert exactly.
// Trips and engine sessions only kept the floored litres, and re-deriving their
// boundaries from scratch would silently move them: the closing reading is
// deliberately taken after the trip ends, because the OBD fuel level stops
// refreshing once the engine does. So instead of recomputing them, this
// identifies the snapshot each figure came from — a reading in the trip's own
// window whose floored value still matches what was stored — and upgrades only
// that reading. A boundary that cannot be identified is left untouched.
const apply = process.argv.includes('--apply')
const SNAPSHOT_MATCH_GRACE_MS = 15 * 60_000
const database = createDatabase()

function litres(value: number | null) {
  return value == null ? '—' : value.toFixed(1)
}

function floored(percent: number | null) {
  const fuel = fuelFromPercent(percent)
  return fuel == null ? null : Math.floor(fuel)
}

async function backfillSnapshots() {
  const rows = await database.select({
    id: vehicleSnapshots.id,
    fuel: vehicleSnapshots.fuel,
    fuelPercent: vehicleSnapshots.fuelPercent,
    fuelSource: vehicleSnapshots.fuelSource
  }).from(vehicleSnapshots).where(isNotNull(vehicleSnapshots.fuelPercent))

  let changed = 0
  for (const row of rows) {
    const fuel = fuelFromPercent(row.fuelPercent)
    // An even percentage floors to itself, so the litres already match. The
    // source still has to be relabelled — leaving it as 'converted' would make
    // `sameSource` in the refuel detector flip back and forth across a history
    // that is uniformly percentage-derived.
    if (fuel == null || (fuel === row.fuel && row.fuelSource === 'percent')) continue
    changed++
    if (apply) {
      await database.update(vehicleSnapshots).set({ fuel, fuelSource: 'percent' })
        .where(eq(vehicleSnapshots.id, row.id))
    }
  }
  console.log(`snapshots: ${changed} of ${rows.length} recomputed from the percentage`)
}

// The stored litres came from one snapshot in this window, and flooring is not
// invertible on its own — 26 litres is either 52% or 53%. Requiring the floored
// percentage to match the stored value is what pins it down, and refusing to
// guess when nothing matches is what keeps the backfill honest.
async function refine(vehicleId: number, from: Date, to: Date, stored: number | null) {
  if (stored == null) return null
  const readings = await database.select({
    fuelPercent: vehicleSnapshots.fuelPercent
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    gte(vehicleSnapshots.ts, new Date(from.getTime() - SNAPSHOT_MATCH_GRACE_MS)),
    lte(vehicleSnapshots.ts, new Date(to.getTime() + SNAPSHOT_MATCH_GRACE_MS)),
    isNotNull(vehicleSnapshots.fuelPercent)
  )).orderBy(asc(vehicleSnapshots.ts))

  const percentages = new Set(readings.filter(r => floored(r.fuelPercent) === stored).map(r => r.fuelPercent!))
  // Two candidate percentages both floor to the stored value; only an unambiguous
  // match tells us which reading it actually was.
  if (percentages.size !== 1) return null
  return fuelFromPercent([...percentages][0])
}

async function backfillEngineSessions() {
  const rows = await database.select().from(engineSessions).where(eq(engineSessions.isOpen, false))

  let changed = 0
  let ambiguous = 0
  for (const session of rows) {
    if (!session.endedAt) continue
    const fuelStart = await refine(session.vehicleId, session.startedAt, session.endedAt, session.fuelStart) ?? session.fuelStart
    const fuelEnd = await refine(session.vehicleId, session.startedAt, session.endedAt, session.fuelEnd) ?? session.fuelEnd
    if (fuelStart === session.fuelStart && fuelEnd === session.fuelEnd) {
      if (session.fuelStart != null || session.fuelEnd != null) ambiguous++
      continue
    }
    changed++
    if (apply) {
      await database.update(engineSessions).set({ fuelStart, fuelEnd })
        .where(eq(engineSessions.id, session.id))
    }
  }
  console.log(`engine sessions: ${changed} of ${rows.length} refined, ${ambiguous} left as recorded`)
}

async function backfillTrips() {
  const rows = await database.select().from(trips).where(eq(trips.isOpen, false))

  let changed = 0
  let ambiguous = 0
  for (const trip of rows) {
    if (!trip.endedAt) continue
    const fuelStart = await refine(trip.vehicleId, trip.startedAt, trip.endedAt, trip.fuelStart) ?? trip.fuelStart
    const fuelEnd = await refine(trip.vehicleId, trip.startedAt, trip.endedAt, trip.fuelEnd) ?? trip.fuelEnd
    const fuelUsed = fuelStart != null && fuelEnd != null && fuelEnd <= fuelStart ? fuelStart - fuelEnd : trip.fuelUsed
    if (fuelStart === trip.fuelStart && fuelEnd === trip.fuelEnd && fuelUsed === trip.fuelUsed) {
      if (trip.fuelUsed != null) ambiguous++
      continue
    }
    changed++
    const before = trip.distance && trip.fuelUsed ? trip.fuelUsed / trip.distance * 100 : null
    const after = trip.distance && fuelUsed ? fuelUsed / trip.distance * 100 : null
    console.log(`  trip ${trip.id}: ${litres(trip.fuelStart)}→${litres(trip.fuelEnd)} л`
      + ` ⇒ ${litres(fuelStart)}→${litres(fuelEnd)} л`
      + ` · расход ${litres(trip.fuelUsed)} → ${litres(fuelUsed)} л`
      + `${before == null || after == null ? '' : ` · ${before.toFixed(1)} → ${after.toFixed(1)} л/100 км`}`)
    if (apply) {
      await database.update(trips).set({ fuelStart, fuelEnd, fuelUsed }).where(eq(trips.id, trip.id))
    }
  }
  console.log(`trips: ${changed} of ${rows.length} refined, ${ambiguous} left as recorded`)
}

async function backfillRefuels() {
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
    console.log(`  refuel ${refuel.id}: sensor ${litres(refuel.sensorLitresAdded)} → ${litres(sensorLitresAdded)} л${saturated}`)
    if (apply) {
      await database.update(refuelEvents).set({ fuelBefore, fuelAfter, sensorLitresAdded })
        .where(eq(refuelEvents.id, refuel.id))
      // Receipts outrank the sensor, so this restores the receipt volume on
      // events that have one and the corrected sensor volume on those that do not.
      await applyReceiptsToRefuel(database, refuel.id)
    }
  }
  console.log(`refuels: ${changed} of ${rows.length} recomputed`)
}

console.log(`Tank: ${FUEL_TANK_CAPACITY_LITRES} л · 1% = ${FUEL_TANK_CAPACITY_LITRES / 100} л`)
await backfillSnapshots()
await backfillEngineSessions()
await backfillTrips()
await backfillRefuels()
console.log(apply ? 'Backfill applied' : 'Dry run — nothing written. Re-run with --apply to write.')
