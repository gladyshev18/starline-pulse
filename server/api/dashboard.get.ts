import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { apiCalls, engineSessions, refuelEvents, trips, vehicleSnapshots, vehicles } from '../../db/schema'

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

function moscowMonthStart(now = new Date()) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - MOSCOW_OFFSET_MS)
}

function moscowDayStart(daysAgo: number, now = new Date()) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysAgo) - MOSCOW_OFFSET_MS)
}

function daySeries(days: number, rows: Array<{ day: string, distance: unknown, trips: unknown }>) {
  const values = new Map(rows.map(row => [row.day, { distance: Number(row.distance || 0), trips: Number(row.trips || 0) }]))
  const today = new Date(Date.now() + MOSCOW_OFFSET_MS)
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today)
    day.setUTCDate(today.getUTCDate() - (days - index - 1))
    const key = day.toISOString().slice(0, 10)
    return { day: key, ...(values.get(key) || { distance: 0, trips: 0 }) }
  })
}

export default defineEventHandler(async () => {
  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return {
    vehicle: null,
    snapshot: null,
    month: { distance: 0, fuelUsed: 0, consumption: null, trips: 0 },
    daily: [], engine: { stationaryMinutes: 0, warmupMinutes: 0, sessions: 0 },
    refuels: { count: 0, litres: 0, recent: [] }, batteryTrend: [], api: { used: 0, remaining: 1000 }
  }

  const snapshot = await database.query.vehicleSnapshots.findFirst({
    where: eq(vehicleSnapshots.vehicleId, vehicle.id),
    orderBy: desc(vehicleSnapshots.ts)
  })
  const monthStart = moscowMonthStart()
  const [month] = await database.select({
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
    trips: count()
  }).from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false), gte(trips.startedAt, monthStart)))

  const dailyStart = moscowDayStart(13)
  const tripDay = sql<string>`strftime('%Y-%m-%d', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours')`
  const dailyRows = await database.select({
    day: tripDay,
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    trips: count()
  }).from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false), gte(trips.startedAt, dailyStart)))
    .groupBy(tripDay).orderBy(tripDay)

  const [engine] = await database.select({
    sessions: count(),
    stationaryMinutes: sql<number>`coalesce(sum(case when ${engineSessions.isStationary} = 1 then ${engineSessions.durationMinutes} else 0 end), 0)`,
    warmupMinutes: sql<number>`coalesce(sum(${engineSessions.warmupMinutes}), 0)`
  }).from(engineSessions).where(and(eq(engineSessions.vehicleId, vehicle.id), eq(engineSessions.isOpen, false), gte(engineSessions.startedAt, monthStart)))

  const [refuelSummary] = await database.select({
    count: count(),
    litres: sql<number>`coalesce(sum(${refuelEvents.litresAdded}), 0)`
  }).from(refuelEvents).where(and(eq(refuelEvents.vehicleId, vehicle.id), gte(refuelEvents.detectedAt, monthStart)))
  const recentRefuels = await database.select().from(refuelEvents).where(eq(refuelEvents.vehicleId, vehicle.id))
    .orderBy(desc(refuelEvents.detectedAt)).limit(5)

  const batteryStart = moscowDayStart(6)
  const batteryDay = sql<string>`strftime('%Y-%m-%d', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours')`
  const batteryRows = await database.select({
    day: batteryDay,
    min: sql<number>`min(${vehicleSnapshots.battery})`,
    max: sql<number>`max(${vehicleSnapshots.battery})`,
    average: sql<number>`avg(${vehicleSnapshots.battery})`
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicle.id),
    eq(vehicleSnapshots.batteryType, 'volt'),
    isNotNull(vehicleSnapshots.battery),
    gte(vehicleSnapshots.ts, batteryStart)
  )).groupBy(batteryDay).orderBy(batteryDay)
  const today = new Date().toISOString().slice(0, 10)
  const [api] = await database.select({ used: sql<number>`count(*)` }).from(apiCalls).where(eq(apiCalls.day, today))
  const distance = Number(month?.distance || 0)
  const fuelUsed = Number(month?.fuelUsed || 0)
  return {
    vehicle,
    snapshot,
    month: { distance, fuelUsed, consumption: distance > 0 ? fuelUsed / distance * 100 : null, trips: Number(month?.trips || 0) },
    daily: daySeries(14, dailyRows),
    engine: {
      sessions: Number(engine?.sessions || 0),
      stationaryMinutes: Number(engine?.stationaryMinutes || 0),
      warmupMinutes: Number(engine?.warmupMinutes || 0)
    },
    refuels: { count: Number(refuelSummary?.count || 0), litres: Number(refuelSummary?.litres || 0), recent: recentRefuels },
    batteryTrend: batteryRows.map(row => ({ day: row.day, min: Number(row.min), max: Number(row.max), average: Number(row.average) })),
    api: { used: Number(api?.used || 0), remaining: Math.max(0, 1000 - Number(api?.used || 0)) }
  }
})
