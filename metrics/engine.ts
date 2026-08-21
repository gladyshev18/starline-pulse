import { and, desc, eq, gt, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { engineSessions, serviceEvents, vehicleSnapshots } from '../db/schema'
import { kmPerMotorHour, oilClockGap, oilLife } from '../shared/service'

// A single step larger than this is the counter being reset or garbled rather
// than the engine having run: even a whole night of idling stays under it.
const MAX_MOTOR_STEP_MINUTES = 720

// The counter only ever climbs, so engine time is the sum of its increments.
// Reading the difference between the first and last value instead would swallow
// a reset whole — `motorhours_reset` is in this device's function list — and a
// reset shows up here as a decrease, which simply contributes nothing.
export async function engineMinutesBetween(database: Database, vehicleId: number, start: Date, end: Date) {
  const rows = await database.all<{ minutes: number }>(sql`
    with steps as (
      select
        ${vehicleSnapshots.motorMinutes} as value,
        lag(${vehicleSnapshots.motorMinutes}) over (order by ${vehicleSnapshots.ts}) as previous
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${vehicleId}
        and ${vehicleSnapshots.ts} >= ${start.getTime()}
        and ${vehicleSnapshots.ts} < ${end.getTime()}
        and ${vehicleSnapshots.motorMinutes} is not null
    )
    select coalesce(sum(
      case when previous is not null and value > previous and value - previous <= ${MAX_MOTOR_STEP_MINUTES}
        then value - previous else 0 end
    ), 0) as minutes
    from steps
  `)
  return Number(rows[0]?.minutes || 0)
}

// What the trackers made of the same stretch. Sessions are measured by their
// overlap with the window rather than by their stored duration, so one that
// straddles a month boundary contributes only its share of the month, and one
// still running contributes at all.
const sessionOpens = (start: Date) => sql`max(${engineSessions.startedAt}, ${start.getTime()})`
const sessionCloses = (end: Date) => sql`min(coalesce(${engineSessions.endedAt}, ${end.getTime()}), ${end.getTime()})`

async function sessionMinutesBetween(database: Database, vehicleId: number, start: Date, end: Date) {
  const [row] = await database.select({
    minutes: sql<number>`coalesce(sum(max(0, ${sessionCloses(end)} - ${sessionOpens(start)})), 0) / 60000.0`,
    sessions: sql<number>`count(*)`
  }).from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    lt(engineSessions.startedAt, end),
    gt(sql`coalesce(${engineSessions.endedAt}, ${end.getTime()})`, start.getTime())
  ))
  return { minutes: Number(row?.minutes || 0), sessions: Number(row?.sessions || 0) }
}

// Engine time the counter reports over stretches no session covers at all: a
// start and a stop that both fell between two polls, or a spell the worker was
// down for. Comparing the counter against the sum of session durations would not
// isolate it — the counter ticks in whole minutes and the poller sees each
// ignition edge a little late, which over fifty sessions adds up to more than
// the real leftover.
//
// What separates a warm-up from a trip nobody recorded is whether the car went
// anywhere, and only the odometer can say. It reports in chunks while driving,
// but it flushes when the ignition goes off — and a stretch that slipped past
// the poller entirely began and ended with the engine, so its distance is on the
// books by the closing reading. A missing reading counts as movement: fuel is
// not billed to a warm-up that cannot be shown to have stood still.
export async function engineMinutesOutsideSessions(database: Database, vehicleId: number, start: Date, end: Date) {
  const rows = await database.all<{ from_ts: number, to_ts: number, minutes: number, distance: number | null }>(sql`
    with steps as (
      select
        ${vehicleSnapshots.ts} as ts,
        ${vehicleSnapshots.motorMinutes} as value,
        ${vehicleSnapshots.mileage} as mileage,
        lag(${vehicleSnapshots.ts}) over (order by ${vehicleSnapshots.ts}) as prev_ts,
        lag(${vehicleSnapshots.motorMinutes}) over (order by ${vehicleSnapshots.ts}) as prev_value,
        lag(${vehicleSnapshots.mileage}) over (order by ${vehicleSnapshots.ts}) as prev_mileage
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${vehicleId}
        and ${vehicleSnapshots.ts} >= ${start.getTime()}
        and ${vehicleSnapshots.ts} < ${end.getTime()}
        and ${vehicleSnapshots.motorMinutes} is not null
    )
    select
      prev_ts as from_ts,
      ts as to_ts,
      value - prev_value as minutes,
      case when mileage is not null and prev_mileage is not null then mileage - prev_mileage end as distance
    from steps
    where prev_value is not null and value > prev_value
      and value - prev_value <= ${MAX_MOTOR_STEP_MINUTES}
      and not exists (
        select 1 from ${engineSessions}
        where ${engineSessions.vehicleId} = ${vehicleId}
          and ${engineSessions.startedAt} < steps.ts
          and coalesce(${engineSessions.endedAt}, ${end.getTime()}) > steps.prev_ts
      )
    order by prev_ts
  `)

  const stretches = rows.map(row => ({
    startedAt: new Date(Number(row.from_ts)),
    endedAt: new Date(Number(row.to_ts)),
    minutes: Number(row.minutes),
    // Null means the odometer said nothing across the stretch, which is not the
    // same as saying it stood still — hence `moved` below, which treats silence
    // as movement rather than crediting it to the idling bill.
    distance: row.distance == null ? null : Number(row.distance),
    moved: row.distance == null || Number(row.distance) > 0
  }))

  return {
    stationaryMinutes: stretches.filter(item => !item.moved).reduce((sum, item) => sum + item.minutes, 0),
    movingMinutes: stretches.filter(item => item.moved).reduce((sum, item) => sum + item.minutes, 0),
    // Named rather than merely counted: a stretch nobody recorded is a trip the
    // page cannot link to, so the only way to recognise it is by when it was and
    // how far it went.
    movingStretches: stretches.filter(item => item.moved)
  }
}

export async function engineSummary(database: Database, vehicleId: number, start: Date, end: Date) {
  const counterMinutes = await engineMinutesBetween(database, vehicleId, start, end)
  const tracked = await sessionMinutesBetween(database, vehicleId, start, end)
  const loose = await engineMinutesOutsideSessions(database, vehicleId, start, end)
  return {
    counterMinutes,
    sessionMinutes: tracked.minutes,
    sessions: tracked.sessions,
    // The standing half is a warm-up nobody recorded, and the overview bills it
    // as one; the moving half is a trip the poller slept through.
    untrackedIdleMinutes: loose.stationaryMinutes,
    untrackedMovingMinutes: loose.movingMinutes,
    untrackedTrips: loose.movingStretches
  }
}

async function currentMileage(database: Database, vehicleId: number, before: Date) {
  const row = await database.query.vehicleSnapshots.findFirst({
    columns: { mileage: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicleId),
      isNotNull(vehicleSnapshots.mileage),
      lt(vehicleSnapshots.ts, before)
    ),
    orderBy: desc(vehicleSnapshots.ts)
  })
  return row?.mileage ?? null
}

const MONTH_MS = 30.437 * 24 * 60 * 60_000

export const emptyOilStatus = () => ({
  service: null as { performedAt: Date, mileage: number | null, note: string | null } | null,
  km: null as number | null,
  motorHours: null as number | null,
  months: null as number | null,
  kmPerHour: null as number | null,
  clockGap: null as number | null,
  life: oilLife({ km: null, motorHours: null, months: null })
})

// Everything is counted from the recorded service rather than from the counter's
// absolute value: the engine-hour counter can be reset, and the odometer reading
// at the time of service is the only thing that anchors the distance clock.
export async function oilStatus(database: Database, vehicleId: number, now = new Date()) {
  const service = await database.query.serviceEvents.findFirst({
    where: and(eq(serviceEvents.vehicleId, vehicleId), eq(serviceEvents.kind, 'oil')),
    orderBy: desc(serviceEvents.performedAt)
  })
  if (!service) return emptyOilStatus()

  const mileage = await currentMileage(database, vehicleId, now)
  const km = mileage != null && service.mileage != null ? Math.max(0, mileage - service.mileage) : null
  const motorHours = await engineMinutesBetween(database, vehicleId, service.performedAt, now) / 60
  const months = Math.max(0, (now.getTime() - service.performedAt.getTime()) / MONTH_MS)
  const life = oilLife({ km, motorHours, months })

  return {
    service: { performedAt: service.performedAt, mileage: service.mileage, note: service.note },
    km,
    motorHours,
    months,
    kmPerHour: kmPerMotorHour(km, motorHours),
    clockGap: oilClockGap(life),
    life
  }
}
