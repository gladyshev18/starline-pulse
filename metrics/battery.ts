import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { vehicleSnapshots } from '../db/schema'
import { batteryTrend } from '../shared/battery'
import { ambientTemperature } from './consumption'

// The same window the ambient estimate uses, and for the same reason: hours
// after the engine stopped, the alternator's surface charge has bled off and
// what is left is the battery's own resting voltage.
const RESTING_FROM_HOUR = 2
const RESTING_TO_HOUR = 7

const DAY_MS = 24 * 60 * 60_000

export async function batteryHealth(database: Database, vehicleId: number, start: Date, end: Date) {
  const day = sql<string>`strftime('%Y-%m-%d', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours')`
  const hour = sql<number>`cast(strftime('%H', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours') as integer)`
  const rows = await database.select({
    day,
    // The lowest reading of the night is the most rested one: surface charge
    // only ever decays downward towards the true value.
    volts: sql<number>`min(${vehicleSnapshots.battery})`
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    eq(vehicleSnapshots.ignition, false),
    eq(vehicleSnapshots.batteryType, 'volt'),
    isNotNull(vehicleSnapshots.battery),
    gte(vehicleSnapshots.ts, start),
    lt(vehicleSnapshots.ts, end),
    sql`${hour} >= ${RESTING_FROM_HOUR} and ${hour} <= ${RESTING_TO_HOUR}`
  )).groupBy(day).orderBy(day)

  const ambient = await ambientTemperature(database, vehicleId, start, end)
  const ambientByDay = new Map(ambient.daily.map(item => [item.day, item.night]))
  const firstDay = rows[0]?.day ?? null
  const origin = firstDay ? Date.parse(`${firstDay}T00:00:00+03:00`) : 0

  const readings = rows.map(row => ({
    day: (Date.parse(`${row.day}T00:00:00+03:00`) - origin) / DAY_MS,
    volts: Number(row.volts),
    ambient: ambientByDay.get(row.day) ?? null
  }))

  return { ...batteryTrend(readings), readings, firstDay }
}
