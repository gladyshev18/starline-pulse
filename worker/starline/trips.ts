import { and, asc, desc, eq, gte, isNotNull } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { jobs, trips, vehicleSnapshots } from '../../db/schema'

type Snapshot = typeof vehicleSnapshots.$inferSelect

export async function handleIgnitionTransition(database: Database, vehicleId: number, current: Snapshot, previous?: Snapshot) {
  if (current.ignition == null || current.ignition === previous?.ignition) return
  const openTrip = await database.query.trips.findFirst({ where: and(eq(trips.vehicleId, vehicleId), eq(trips.isOpen, true)), orderBy: desc(trips.startedAt) })
  if (previous?.ignition !== true && current.ignition) {
    if (!openTrip) await database.insert(trips).values({ vehicleId, startedAt: current.ts, mileageStart: current.mileage, fuelStart: current.fuel, latStart: current.lat, lonStart: current.lon })
    return
  }
  if (previous?.ignition === true && !current.ignition && openTrip) {
    await database.insert(jobs).values({
      type: 'starline:close_trip', payload: JSON.stringify({ vehicleId, tripId: openTrip.id }), runAt: new Date(Date.now() + 3 * 60_000)
    })
  }
}

export async function closeTrip(database: Database, payload: { vehicleId: number, tripId: number }) {
  const trip = await database.query.trips.findFirst({ where: and(eq(trips.id, payload.tripId), eq(trips.isOpen, true)) })
  if (!trip) return null
  const latest = await database.query.vehicleSnapshots.findFirst({ where: eq(vehicleSnapshots.vehicleId, payload.vehicleId), orderBy: desc(vehicleSnapshots.ts) })
  if (!latest || latest.ignition !== false) return null

  const mileageStartSnapshot = trip.mileageStart == null
    ? await database.query.vehicleSnapshots.findFirst({ where: and(eq(vehicleSnapshots.vehicleId, payload.vehicleId), gte(vehicleSnapshots.ts, trip.startedAt), isNotNull(vehicleSnapshots.mileage)), orderBy: asc(vehicleSnapshots.ts) }) : null
  const fuelStartSnapshot = trip.fuelStart == null
    ? await database.query.vehicleSnapshots.findFirst({ where: and(eq(vehicleSnapshots.vehicleId, payload.vehicleId), gte(vehicleSnapshots.ts, trip.startedAt), isNotNull(vehicleSnapshots.fuel)), orderBy: asc(vehicleSnapshots.ts) }) : null
  const mileageEndSnapshot = await database.query.vehicleSnapshots.findFirst({ where: and(eq(vehicleSnapshots.vehicleId, payload.vehicleId), gte(vehicleSnapshots.ts, trip.startedAt), isNotNull(vehicleSnapshots.mileage)), orderBy: desc(vehicleSnapshots.ts) })
  const fuelEndSnapshot = await database.query.vehicleSnapshots.findFirst({ where: and(eq(vehicleSnapshots.vehicleId, payload.vehicleId), gte(vehicleSnapshots.ts, trip.startedAt), isNotNull(vehicleSnapshots.fuel)), orderBy: desc(vehicleSnapshots.ts) })
  const mileageStart = trip.mileageStart ?? mileageStartSnapshot?.mileage ?? null
  const fuelStart = trip.fuelStart ?? fuelStartSnapshot?.fuel ?? null
  const mileageEnd = mileageEndSnapshot?.mileage ?? null
  const fuelEnd = fuelEndSnapshot?.fuel ?? null
  const distance = mileageStart != null && mileageEnd != null && mileageEnd >= mileageStart ? mileageEnd - mileageStart : null
  const fuelUsed = fuelStart != null && fuelEnd != null && fuelEnd <= fuelStart ? fuelStart - fuelEnd : null

  const [closed] = await database.update(trips).set({
    endedAt: latest.ts, mileageStart, mileageEnd, distance, fuelStart, fuelEnd, fuelUsed,
    latEnd: latest.lat, lonEnd: latest.lon, isOpen: false
  }).where(eq(trips.id, trip.id)).returning()
  if (closed) {
    const consumption = distance && fuelUsed != null ? fuelUsed / distance * 100 : null
    await database.insert(jobs).values({ type: 'telegram:notify', payload: JSON.stringify({
      text: `Поездка завершена\nРасстояние: ${format(distance)} км\nТопливо: ${format(fuelUsed)} л\nРасход: ${format(consumption)} л/100 км`
    }) })
  }
  return closed
}

function format(value: number | null) { return value == null ? '—' : value.toFixed(1) }
