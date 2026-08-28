import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lte, or } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { armedMinutesBetween } from '../../metrics/engine'
import { sessionOdometerSpan } from '../../metrics/odometer'
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

// Сессия закрывается на том, что одометр успел сказать к выключению зажигания, а
// это регулярно меньше проеханного. Оставить как есть нельзя: по `is_stationary`
// минуты сессии уходят в счёт за холостой ход, а её литры — в ставку литров в
// час, и дорога оказалась бы оплачена как прогрев.
//
// Но докуда сессия дотянулась, решает не тот, кто её расширяет, а правило
// принадлежности показаний: своя досылка — да, но только до следующего запуска
// двигателя. Иначе километры следующей дороги попадают сразу в две сессии, и обе
// засчитывают их себе.
async function extendSession(database: Database, vehicleId: number, startedAt: Date) {
  const session = await database.query.engineSessions.findFirst({
    where: and(eq(engineSessions.vehicleId, vehicleId), eq(engineSessions.startedAt, startedAt))
  })
  if (!session) return
  const span = await sessionOdometerSpan(database, session)
  if (span.distance == null) return
  if (span.mileageStart === session.mileageStart && span.mileageEnd === session.mileageEnd) return
  await database.update(engineSessions).set({
    mileageStart: span.mileageStart,
    mileageEnd: span.mileageEnd,
    distance: span.distance,
    isStationary: span.distance === 0
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

  // Сколько именно досталось этой поездке, решает время съёма показаний, а не то,
  // в каком опросе они приехали: после следующего запуска двигателя одометр
  // считает уже чужие километры, даже если привёз их тот же ответ.
  const span = await sessionOdometerSpan(database, {
    vehicleId, startedAt: trip.startedAt, endedAt: trip.endedAt
  })
  const mileageEnd = span.mileageEnd
  if (mileageEnd == null || !(mileageEnd > trip.mileageEnd)) return

  const distance = trip.mileageStart != null && mileageEnd >= trip.mileageStart
    ? mileageEnd - trip.mileageStart
    : trip.distance
  await database.update(trips).set({ mileageEnd, distance }).where(eq(trips.id, trip.id))
  await extendSession(database, vehicleId, trip.startedAt)
}

export async function handleMileageProgress(database: Database, vehicleId: number, current: Snapshot, previous?: Snapshot) {
  let openTrip = await database.query.trips.findFirst({ where: and(eq(trips.vehicleId, vehicleId), eq(trips.isOpen, true)), orderBy: desc(trips.startedAt) })
  const mileageIncreased = hasMileageIncreased(previous?.mileage, current.mileage)

  if (mileageIncreased && !openTrip && previous) {
    // Машина на охране с работающим двигателем — это автозапуск: ехать на
    // охраняемой машине нельзя. Значит выросший одометр здесь не начало дороги, а
    // хвост той, что уже была: OBD просыпается вместе с двигателем и читает
    // одометр заново, и это чтение может оказаться больше прежнего, если
    // накануне машина ехала ещё минуту-другую после его последнего отчёта.
    // Раньше прогрев становился от этого отдельной поездкой.
    const remoteStart = current.ignition === true && current.armed === true
    const origin = remoteStart ? null : await tripOrigin(database, vehicleId, current, previous)
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
  if (!latest) return null

  const engineSession = await database.query.engineSessions.findFirst({
    where: and(eq(engineSessions.vehicleId, payload.vehicleId), eq(engineSessions.startedAt, trip.startedAt))
  })
  // Поездка кончается вместе со своей сессией, а не тогда, когда опрос застанет
  // зажигание выключенным. Раньше здесь стояла только вторая проверка, и если к
  // сроку закрытия машину успевали завести снова, поездка не закрывалась вовсе —
  // а потом забирала себе следующую дорогу целиком, оставляя себе длительность
  // своей. Шестиминутный прогрев на автозапуске получал так двадцать пять
  // километров, то есть пять тысяч километров в час.
  const sessionEnded = engineSession?.endedAt != null && engineSession.endedAt >= trip.startedAt
  if (!sessionEnded && latest.ignition !== false) return null
  const endedAt = sessionEnded ? engineSession!.endedAt! : latest.ts
  // Топливо и одометр читаются в окно поездки, а не «от старта и до последнего
  // снапшота вообще»: одометр досылает остаток после остановки, но следующая
  // дорога — уже не эта.
  const settledBy = new Date(endedAt.getTime() + ODOMETER_AFTER_STOP_GRACE_MS)

  const mileageStartSnapshot = trip.mileageStart == null
    ? await database.query.vehicleSnapshots.findFirst({ where: and(eq(vehicleSnapshots.vehicleId, payload.vehicleId), gte(vehicleSnapshots.ts, trip.startedAt), isNotNull(vehicleSnapshots.mileage)), orderBy: asc(vehicleSnapshots.ts) }) : null
  const fuelStartSnapshot = trip.fuelStart == null
    ? await database.query.vehicleSnapshots.findFirst({ where: and(eq(vehicleSnapshots.vehicleId, payload.vehicleId), gte(vehicleSnapshots.ts, trip.startedAt), isNotNull(vehicleSnapshots.fuel)), orderBy: asc(vehicleSnapshots.ts) }) : null
  const fuelEndSnapshot = await database.query.vehicleSnapshots.findFirst({ where: and(eq(vehicleSnapshots.vehicleId, payload.vehicleId), gte(vehicleSnapshots.ts, trip.startedAt), lte(vehicleSnapshots.ts, settledBy), isNotNull(vehicleSnapshots.fuel)), orderBy: desc(vehicleSnapshots.ts) })
  // Одометр берётся не из снапшотов поездки, а по правилу принадлежности
  // показаний: показание, застигнутое в момент запуска, снято раньше — иногда на
  // час, — и поездка, взявшая его за начало, приписывала себе хвост предыдущей.
  const span = await sessionOdometerSpan(database, {
    vehicleId: payload.vehicleId, startedAt: trip.startedAt, endedAt
  })
  const mileageStart = span.mileageStart ?? trip.mileageStart ?? mileageStartSnapshot?.mileage ?? null
  const fuelStart = trip.fuelStart ?? fuelStartSnapshot?.fuel ?? null
  const mileageEnd = span.mileageEnd
  const fuelEnd = fuelEndSnapshot?.fuel ?? null
  const distance = mileageStart != null && mileageEnd != null && mileageEnd >= mileageStart ? mileageEnd - mileageStart : null
  const fuelUsed = tripFuelUsed(fuelStart, fuelEnd)
  const armedMinutes = await armedMinutesBetween(database, payload.vehicleId, trip.startedAt, endedAt)

  const [closed] = await database.update(trips).set({
    endedAt, mileageStart, mileageEnd, distance, fuelStart, fuelEnd, fuelUsed, armedMinutes,
    latEnd: latest.lat, lonEnd: latest.lon, isOpen: false
  }).where(eq(trips.id, trip.id)).returning()
  await extendSession(database, payload.vehicleId, trip.startedAt)
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
