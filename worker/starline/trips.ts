import { and, asc, desc, eq, gt, gte, isNotNull, isNull, or } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { engineSessions, jobs, trips, vehicleSnapshots } from '../../db/schema'
import { tripCompletedText } from '../bot/trip-driver'

type Snapshot = typeof vehicleSnapshots.$inferSelect
type EngineSession = typeof engineSessions.$inferSelect

const ODOMETER_AFTER_STOP_GRACE_MS = 15 * 60_000
const LEGACY_TRIP_START_LAG_MS = 30 * 60_000

export function hasMileageIncreased(previous: number | null | undefined, current: number | null | undefined) {
  return previous != null && current != null && current > previous
}

function sameMileage(left: number | null, right: number | null) {
  return left == null || right == null || Math.abs(left - right) < 0.01
}

function sessionContainsOdometerUpdate(session: EngineSession, current: Snapshot) {
  const readingAt = current.mileageTs ?? current.ts
  if (session.startedAt > readingAt) return false
  return !session.endedAt || readingAt.getTime() - session.endedAt.getTime() <= ODOMETER_AFTER_STOP_GRACE_MS
}

async function tripOrigin(database: Database, vehicleId: number, current: Snapshot, previous: Snapshot) {
  const recentSessions = await database.select().from(engineSessions)
    .where(eq(engineSessions.vehicleId, vehicleId))
    .orderBy(desc(engineSessions.startedAt))
    .limit(10)
  const latestTrip = await database.query.trips.findFirst({
    where: eq(trips.vehicleId, vehicleId),
    orderBy: desc(trips.startedAt)
  })
  const session = recentSessions.find(item => (
    (!latestTrip || item.startedAt > latestTrip.startedAt)
    && sessionContainsOdometerUpdate(item, current)
    && sameMileage(item.mileageStart, previous.mileage)
  ))
  if (!session) {
    return {
      startedAt: previous.ts,
      mileageStart: previous.mileage,
      fuelStart: previous.fuel,
      latStart: previous.lat,
      lonStart: previous.lon
    }
  }

  const startSnapshot = await database.query.vehicleSnapshots.findFirst({
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicleId),
      eq(vehicleSnapshots.ignition, true),
      gte(vehicleSnapshots.ts, session.startedAt)
    ),
    orderBy: asc(vehicleSnapshots.ts)
  })
  return {
    startedAt: session.startedAt,
    mileageStart: session.mileageStart ?? previous.mileage,
    fuelStart: session.fuelStart ?? startSnapshot?.fuel ?? previous.fuel,
    latStart: startSnapshot?.lat ?? previous.lat,
    lonStart: startSnapshot?.lon ?? previous.lon
  }
}

export async function handleMileageProgress(database: Database, vehicleId: number, current: Snapshot, previous?: Snapshot) {
  let openTrip = await database.query.trips.findFirst({ where: and(eq(trips.vehicleId, vehicleId), eq(trips.isOpen, true)), orderBy: desc(trips.startedAt) })
  const mileageIncreased = hasMileageIncreased(previous?.mileage, current.mileage)

  if (mileageIncreased && !openTrip && previous) {
    const origin = await tripOrigin(database, vehicleId, current, previous)
    const [createdTrip] = await database.insert(trips).values({
      vehicleId,
      ...origin
    }).returning()
    openTrip = createdTrip
  }

  if (!openTrip) return
  if (current.ignition === false) {
    const payload = JSON.stringify({ vehicleId, tripId: openTrip.id })
    const pendingClose = await database.query.jobs.findFirst({
      where: and(eq(jobs.type, 'starline:close_trip'), eq(jobs.payload, payload), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running')))
    })
    if (pendingClose) return
    await database.insert(jobs).values({
      type: 'starline:close_trip', payload, runAt: new Date(Date.now() + 3 * 60_000)
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
  const engineSession = await database.query.engineSessions.findFirst({
    where: and(eq(engineSessions.vehicleId, payload.vehicleId), eq(engineSessions.startedAt, trip.startedAt))
  })
  const endedAt = engineSession?.endedAt && engineSession.endedAt >= trip.startedAt ? engineSession.endedAt : latest.ts

  const [closed] = await database.update(trips).set({
    endedAt, mileageStart, mileageEnd, distance, fuelStart, fuelEnd, fuelUsed,
    latEnd: latest.lat, lonEnd: latest.lon, isOpen: false
  }).where(eq(trips.id, trip.id)).returning()
  if (closed) {
    // tripId в задаче — это и есть вопрос «кто был за рулём»: по нему к
    // уведомлению приклеиваются кнопки с именами.
    await database.insert(jobs).values({ type: 'telegram:notify', payload: JSON.stringify({
      html: true,
      text: tripCompletedText(closed),
      tripId: closed.id
    }) })
  }
  return closed
}

function legacySessionMatchesTrip(session: EngineSession, trip: typeof trips.$inferSelect) {
  if (session.startedAt > trip.startedAt || !sameMileage(session.mileageStart, trip.mileageStart)) return false
  if (trip.startedAt.getTime() - session.startedAt.getTime() > LEGACY_TRIP_START_LAG_MS) return false
  if (session.endedAt && trip.endedAt) {
    const endLag = trip.endedAt.getTime() - session.endedAt.getTime()
    if (endLag < 0 || endLag > ODOMETER_AFTER_STOP_GRACE_MS) return false
  }
  return true
}

export async function reconcileTripsWithEngineSessions(database: Database) {
  const candidates = await database.select().from(trips).where(and(
    eq(trips.isOpen, false),
    gt(trips.distance, 0),
    or(eq(trips.fuelUsed, 0), isNull(trips.fuelUsed))
  )).orderBy(asc(trips.startedAt))
  if (!candidates.length) return 0

  const sessionsByVehicle = new Map<number, EngineSession[]>()
  const usedSessionsByVehicle = new Map<number, Set<number>>()
  let updated = 0
  for (const trip of candidates) {
    let sessions = sessionsByVehicle.get(trip.vehicleId)
    if (!sessions) {
      sessions = await database.select().from(engineSessions)
        .where(eq(engineSessions.vehicleId, trip.vehicleId))
        .orderBy(desc(engineSessions.startedAt))
      sessionsByVehicle.set(trip.vehicleId, sessions)
    }
    let usedSessions = usedSessionsByVehicle.get(trip.vehicleId)
    if (!usedSessions) {
      usedSessions = new Set()
      usedSessionsByVehicle.set(trip.vehicleId, usedSessions)
    }
    const session = sessions.find(item => !usedSessions.has(item.id) && legacySessionMatchesTrip(item, trip))
    if (!session) continue
    usedSessions.add(session.id)

    const mileageStart = session.mileageStart ?? trip.mileageStart
    const fuelStart = session.fuelStart ?? trip.fuelStart
    const fuelEnd = trip.fuelEnd ?? session.fuelEnd
    const endedAt = session.endedAt ?? trip.endedAt
    const distance = mileageStart != null && trip.mileageEnd != null && trip.mileageEnd >= mileageStart
      ? trip.mileageEnd - mileageStart
      : trip.distance
    const fuelUsed = fuelStart != null && fuelEnd != null && fuelEnd <= fuelStart ? fuelStart - fuelEnd : null
    const unchanged = trip.startedAt.getTime() === session.startedAt.getTime()
      && trip.endedAt?.getTime() === endedAt?.getTime()
      && trip.mileageStart === mileageStart
      && trip.distance === distance
      && trip.fuelStart === fuelStart
      && trip.fuelEnd === fuelEnd
      && trip.fuelUsed === fuelUsed
    if (unchanged) continue
    await database.update(trips).set({
      startedAt: session.startedAt,
      endedAt,
      mileageStart,
      distance,
      fuelStart,
      fuelEnd,
      fuelUsed
    }).where(eq(trips.id, trip.id))
    updated++
  }
  return updated
}
