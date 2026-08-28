import { and, desc, eq } from 'drizzle-orm'
import type { Database } from '../../db/client'
import { sessionOdometerSpan } from '../../metrics/odometer'
import { engineSessions, refuelEvents, vehicleSnapshots } from '../../db/schema'
import { applyReceiptsToRefuel, rematchPendingReceipts } from '../../receipts/store'
import { hasMileageIncreased, snapshotTime } from './trips'

type Snapshot = typeof vehicleSnapshots.$inferSelect

const REFUEL_MIN_LITRES = 3
const REFUEL_MIN_PERCENT = 5
const REFUEL_MERGE_WINDOW_MS = 30 * 60_000

function elapsedMinutes(start: Date, end: Date) {
  return Math.max(0, end.getTime() - start.getTime()) / 60_000
}

export function isRefuelIncrease(litresDelta: number | null, percentDelta: number | null, sameSource: boolean) {
  return Boolean(
    (sameSource && litresDelta != null && litresDelta >= REFUEL_MIN_LITRES)
    || (percentDelta != null && percentDelta >= REFUEL_MIN_PERCENT)
  )
}

async function updateEngineSession(database: Database, vehicleId: number, current: Snapshot, previous?: Snapshot) {
  let session = await database.query.engineSessions.findFirst({
    where: and(eq(engineSessions.vehicleId, vehicleId), eq(engineSessions.isOpen, true)),
    orderBy: desc(engineSessions.startedAt)
  })
  const mileageIncreased = hasMileageIncreased(previous?.mileage, current.mileage)

  if (current.ignition === true && !session) {
    [session] = await database.insert(engineSessions).values({
      vehicleId,
      startedAt: snapshotTime(current),
      mileageStart: current.mileage,
      fuelStart: current.fuel,
      engineTempStart: current.engineTemp
    }).returning()
  }
  if (!session) return

  let firstMovementAt = session.firstMovementAt
  if (!firstMovementAt && mileageIncreased && previous) {
    firstMovementAt = snapshotTime(previous)
    await database.update(engineSessions).set({ firstMovementAt }).where(eq(engineSessions.id, session.id))
  }

  if (current.ignition !== false) return
  const reportedEnd = snapshotTime(current)
  const endedAt = reportedEnd >= session.startedAt ? reportedEnd : current.ts
  // Не то, что показывает одометр в момент остановки, а то, что ему на этот
  // момент принадлежит: показание могло быть снято за прошлую дорогу и доехать
  // только сейчас — так прогрев на автозапуске получал чужие километры.
  const span = await sessionOdometerSpan(database, {
    vehicleId, startedAt: session.startedAt, endedAt
  })
  const mileageStart = span.mileageStart ?? session.mileageStart
  const mileageEnd = span.mileageEnd ?? current.mileage
  const distance = mileageStart != null && mileageEnd != null && mileageEnd >= mileageStart
    ? mileageEnd - mileageStart
    : null
  await database.update(engineSessions).set({
    endedAt,
    firstMovementAt,
    mileageStart,
    mileageEnd,
    fuelEnd: current.fuel,
    engineTempEnd: current.engineTemp,
    distance,
    durationMinutes: elapsedMinutes(session.startedAt, endedAt),
    warmupMinutes: firstMovementAt ? elapsedMinutes(session.startedAt, firstMovementAt) : null,
    isStationary: distance == null ? null : distance === 0,
    isOpen: false
  }).where(eq(engineSessions.id, session.id))
}

async function detectRefuel(database: Database, vehicleId: number, current: Snapshot, previous?: Snapshot) {
  if (!previous || !current.fuelTs || !previous.fuelTs || current.fuelTs <= previous.fuelTs) return false
  // The OBD fuel level only refreshes while the engine runs, so the reading
  // after a refuel arrives one or two polls after the next start — with the
  // ignition already on in both snapshots. Movement, not ignition, is what
  // separates a refuel from fuel sloshing in the tank on the road.
  if (hasMileageIncreased(previous.mileage, current.mileage)) return false

  const litresDelta = current.fuel != null && previous.fuel != null ? current.fuel - previous.fuel : null
  const percentDelta = current.fuelPercent != null && previous.fuelPercent != null ? current.fuelPercent - previous.fuelPercent : null
  const sameSource = current.fuelSource === previous.fuelSource
  if (!isRefuelIncrease(litresDelta, percentDelta, sameSource)) return false

  const last = await database.query.refuelEvents.findFirst({
    where: eq(refuelEvents.vehicleId, vehicleId),
    orderBy: desc(refuelEvents.detectedAt)
  })
  if (last && current.fuelTs.getTime() - last.detectedAt.getTime() <= REFUEL_MERGE_WINDOW_MS) {
    const litresAdded = last.fuelBefore != null && current.fuel != null && current.fuel >= last.fuelBefore
      ? current.fuel - last.fuelBefore
      : last.litresAdded
    await database.update(refuelEvents).set({
      detectedAt: current.fuelTs,
      mileage: current.mileage,
      fuelAfter: current.fuel,
      litresAdded,
      sensorLitresAdded: litresAdded,
      percentAfter: current.fuelPercent,
      lat: current.lat,
      lon: current.lon
    }).where(eq(refuelEvents.id, last.id))
    // A receipt may already have corrected this event, and the merge just
    // overwrote its volume with the sensor reading again.
    await applyReceiptsToRefuel(database, last.id)
    return true
  }

  await database.insert(refuelEvents).values({
    vehicleId,
    detectedAt: current.fuelTs,
    mileage: current.mileage,
    fuelBefore: previous.fuel,
    fuelAfter: current.fuel,
    litresAdded: sameSource && litresDelta != null && litresDelta > 0 ? litresDelta : null,
    sensorLitresAdded: sameSource && litresDelta != null && litresDelta > 0 ? litresDelta : null,
    percentBefore: previous.fuelPercent,
    percentAfter: current.fuelPercent,
    lat: current.lat,
    lon: current.lon
  }).onConflictDoNothing()
  return true
}

export async function aggregateSnapshot(database: Database, vehicleId: number, current: Snapshot, previous?: Snapshot) {
  await updateEngineSession(database, vehicleId, current, previous)
  const refuelChanged = await detectRefuel(database, vehicleId, current, previous)
  // A receipt usually reaches the mailbox before the sensor reports the jump, so
  // whatever is still waiting gets another chance the moment an event appears.
  const linkedReceipts = refuelChanged ? await rematchPendingReceipts(database, vehicleId) : []
  return { refuelChanged, linkedReceipts }
}
