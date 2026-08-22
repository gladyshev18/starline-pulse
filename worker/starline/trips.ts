import { and, asc, desc, eq, gt, gte, isNotNull, isNull, or } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { armedMinutesBetween } from '../../metrics/engine'
import { tripFuelUsed } from '../../shared/fuel'
import { engineSessions, jobs, trips, vehicleSnapshots } from '../../db/schema'
import { tripCompletedText } from '../bot/trip-driver'

type Snapshot = typeof vehicleSnapshots.$inferSelect
type EngineSession = typeof engineSessions.$inferSelect
type Trip = typeof trips.$inferSelect

const ODOMETER_AFTER_STOP_GRACE_MS = 15 * 60_000
const LEGACY_TRIP_START_LAG_MS = 30 * 60_000

export function hasMileageIncreased(previous: number | null | undefined, current: number | null | undefined) {
  return previous != null && current != null && current > previous
}

// The device's own clock for when something happened, which runs ahead of the
// poll that fetched it by however long the worker slept. Sessions have always
// been stamped with it; trips use it too so the two line up exactly and can be
// matched by their start.
export function snapshotTime(snapshot: Pick<Snapshot, 'activityTs' | 'ts'>) {
  return snapshot.activityTs ?? snapshot.ts
}

function sameMileage(left: number | null, right: number | null) {
  return left == null || right == null || Math.abs(left - right) < 0.01
}

function sessionContainsOdometerUpdate(session: EngineSession, current: Snapshot) {
  const readingAt = current.mileageTs ?? current.ts
  if (session.startedAt > readingAt) return false
  return !session.endedAt || readingAt.getTime() - session.endedAt.getTime() <= ODOMETER_AFTER_STOP_GRACE_MS
}

// Where the odometer stood when the session was last heard from. The session may
// have reported part of its distance while it ran and the rest only after the
// ignition went off, so a flush that continues from its closing reading belongs
// to it — comparing against its opening reading instead would only recognise
// sessions that reported nothing at all.
function sessionMileageEdge(session: EngineSession) {
  return session.mileageEnd ?? session.mileageStart
}

// The odometer reports in chunks of ten to twenty kilometres and flushes what is
// left over only after the ignition goes off, minutes to hours later. So a
// mileage increase on a parked car is the norm, not an anomaly, and reading it
// as the start of a journey invents a trip that covers real kilometres at a
// standstill.
//
// What separates that from a genuine trip the poller slept through is the
// engine-hour counter: it cannot miss a start. Either snapshot showing the
// ignition on says the same thing more directly.
function engineWasRunning(current: Snapshot, previous: Snapshot) {
  if (current.ignition === true || previous.ignition === true) return true
  return previous.motorMinutes != null && current.motorMinutes != null && current.motorMinutes > previous.motorMinutes
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
    && sameMileage(sessionMileageEdge(item), previous.mileage)
  ))
  if (!session) {
    // No session without a trip of its own accounts for these kilometres. Either
    // the engine ran and the snapshots caught it, in which case the journey
    // starts here, or the car is parked and the odometer is settling up for a
    // journey that already has its trip.
    if (!engineWasRunning(current, previous)) return null
    return {
      startedAt: snapshotTime(previous),
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

// A session closes on whatever the odometer had said by the time the ignition
// went off, which is routinely less than the car drove. Left alone it keeps
// `is_stationary`, and `is_stationary` is what hands a session's minutes to the
// idling bill and its litres to the idle rate — so a drive would be priced as a
// warm-up. Any later reading that belongs to the session corrects it.
async function extendSession(database: Database, vehicleId: number, startedAt: Date, mileageEnd: number | null) {
  if (mileageEnd == null) return
  const session = await database.query.engineSessions.findFirst({
    where: and(eq(engineSessions.vehicleId, vehicleId), eq(engineSessions.startedAt, startedAt))
  })
  if (!session || session.mileageStart == null) return
  if (session.mileageEnd != null && mileageEnd <= session.mileageEnd) return
  const distance = mileageEnd - session.mileageStart
  if (distance < 0) return
  await database.update(engineSessions).set({
    mileageEnd,
    distance,
    isStationary: distance === 0
  }).where(eq(engineSessions.id, session.id))
}

// The kilometres the odometer settles up with once the car is parked belong to
// the journey that covered them, so they are written into the trip that already
// records it — and into its session for the same reason.
async function absorbLateOdometer(database: Database, vehicleId: number, current: Snapshot, previous: Snapshot) {
  if (current.mileage == null) return
  const trip = await database.query.trips.findFirst({
    where: and(eq(trips.vehicleId, vehicleId), eq(trips.isOpen, false)),
    orderBy: desc(trips.startedAt)
  })
  // Continuity is the proof of ownership: the reading the trip closed on is the
  // one the flush picks up from. Anything else and these kilometres came from
  // somewhere this cannot see, and guessing would be worse than leaving them.
  if (!trip || trip.mileageEnd == null || !sameMileage(trip.mileageEnd, previous.mileage)) return
  if (!(current.mileage > trip.mileageEnd)) return

  const distance = trip.mileageStart != null && current.mileage >= trip.mileageStart
    ? current.mileage - trip.mileageStart
    : trip.distance
  await database.update(trips).set({ mileageEnd: current.mileage, distance }).where(eq(trips.id, trip.id))
  await extendSession(database, vehicleId, trip.startedAt, current.mileage)
}

export async function handleMileageProgress(database: Database, vehicleId: number, current: Snapshot, previous?: Snapshot) {
  let openTrip = await database.query.trips.findFirst({ where: and(eq(trips.vehicleId, vehicleId), eq(trips.isOpen, true)), orderBy: desc(trips.startedAt) })
  const mileageIncreased = hasMileageIncreased(previous?.mileage, current.mileage)

  if (mileageIncreased && !openTrip && previous) {
    const origin = await tripOrigin(database, vehicleId, current, previous)
    if (!origin) {
      await absorbLateOdometer(database, vehicleId, current, previous)
      return
    }
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
  const fuelUsed = tripFuelUsed(fuelStart, fuelEnd)
  const engineSession = await database.query.engineSessions.findFirst({
    where: and(eq(engineSessions.vehicleId, payload.vehicleId), eq(engineSessions.startedAt, trip.startedAt))
  })
  const endedAt = engineSession?.endedAt && engineSession.endedAt >= trip.startedAt ? engineSession.endedAt : latest.ts
  const armedMinutes = await armedMinutesBetween(database, payload.vehicleId, trip.startedAt, endedAt)

  const [closed] = await database.update(trips).set({
    endedAt, mileageStart, mileageEnd, distance, fuelStart, fuelEnd, fuelUsed, armedMinutes,
    latEnd: latest.lat, lonEnd: latest.lon, isOpen: false
  }).where(eq(trips.id, trip.id)).returning()
  await extendSession(database, payload.vehicleId, trip.startedAt, mileageEnd)
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

function legacySessionMatchesTrip(session: EngineSession, trip: Trip) {
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
    const fuelUsed = tripFuelUsed(fuelStart, fuelEnd)
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
