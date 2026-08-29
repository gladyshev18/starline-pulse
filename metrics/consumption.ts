import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { trips, vehicleSnapshots } from '../db/schema'
import { summariseBySpeed } from '../shared/consumption'

// The hours a parked car has been standing still long enough for the engine
// block to have given up its heat. Anything earlier in the evening is still the
// engine cooling down, and anything later is the sun coming up.
const AMBIENT_FROM_HOUR = 2
const AMBIENT_TO_HOUR = 7

export async function speedBreakdown(database: Database, vehicleId: number, start: Date, end: Date) {
  const rows = await database.select({
    distance: trips.distance,
    fuelUsed: trips.fuelUsed,
    armedMinutes: trips.armedMinutes,
    preDepartureMinutes: sql<number | null>`case when ${trips.departedAt} is not null
      then (${trips.departedAt} - ${trips.startedAt}) / 60000.0 else null end`,
    durationMinutes: sql<number | null>`case when ${trips.endedAt} is not null
      then (${trips.endedAt} - ${trips.startedAt}) / 60000.0 else null end`
  }).from(trips).where(and(
    eq(trips.vehicleId, vehicleId),
    eq(trips.isOpen, false),
    gte(trips.startedAt, start),
    lt(trips.startedAt, end)
  ))
  return summariseBySpeed(rows.map(row => ({
    distance: row.distance,
    fuelUsed: row.fuelUsed,
    armedMinutes: row.armedMinutes,
    preDepartureMinutes: row.preDepartureMinutes == null ? null : Number(row.preDepartureMinutes),
    durationMinutes: row.durationMinutes == null ? null : Number(row.durationMinutes)
  })))
}

// There is no thermometer pointing outside, but there is one on an engine that
// has been off all night. The cabin has one too and it reads about five degrees
// warmer even before dawn — glass keeps heat the way a block of iron does not —
// so the engine is the honest proxy. Taking the minimum means any warmth left
// over from the evening can only push the estimate up, never down.
export async function ambientTemperature(database: Database, vehicleId: number, start: Date, end: Date) {
  const day = sql<string>`strftime('%Y-%m-%d', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours')`
  const hour = sql<number>`cast(strftime('%H', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours') as integer)`
  const rows = await database.select({
    day,
    night: sql<number>`min(${vehicleSnapshots.engineTemp})`
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    eq(vehicleSnapshots.ignition, false),
    isNotNull(vehicleSnapshots.engineTemp),
    gte(vehicleSnapshots.ts, start),
    lt(vehicleSnapshots.ts, end),
    sql`${hour} >= ${AMBIENT_FROM_HOUR} and ${hour} <= ${AMBIENT_TO_HOUR}`
  )).groupBy(day).orderBy(day)

  const daily = rows.map(row => ({ day: row.day, night: Number(row.night) }))
  if (!daily.length) return { average: null, min: null, max: null, days: 0, daily }
  const values = daily.map(item => item.night)
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    days: values.length,
    daily
  }
}
