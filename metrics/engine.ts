import { and, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
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

// What the trackers made of the same stretch. The gap between this and the
// counter is engine time no session ever saw — a start that fell between two
// polls, or a stretch the worker was down for.
async function sessionMinutesBetween(database: Database, vehicleId: number, start: Date, end: Date) {
  const [row] = await database.select({
    minutes: sql<number>`coalesce(sum(${engineSessions.durationMinutes}), 0)`,
    sessions: sql<number>`count(*)`
  }).from(engineSessions).where(and(
    eq(engineSessions.vehicleId, vehicleId),
    eq(engineSessions.isOpen, false),
    gte(engineSessions.startedAt, start),
    lt(engineSessions.startedAt, end)
  ))
  return { minutes: Number(row?.minutes || 0), sessions: Number(row?.sessions || 0) }
}

export async function engineSummary(database: Database, vehicleId: number, start: Date, end: Date) {
  const counterMinutes = await engineMinutesBetween(database, vehicleId, start, end)
  const tracked = await sessionMinutesBetween(database, vehicleId, start, end)
  return {
    counterMinutes,
    sessionMinutes: tracked.minutes,
    sessions: tracked.sessions,
    // Never negative: the counter ticks in whole minutes, so rounding alone can
    // put the sessions a shade ahead over a short period.
    unattributedMinutes: Math.max(0, counterMinutes - tracked.minutes)
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
