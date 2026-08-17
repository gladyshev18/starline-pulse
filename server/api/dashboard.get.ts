import { and, count, desc, eq, gte, isNotNull, sql } from 'drizzle-orm'
import { engineSessions, refuelEvents, trips, vehicleSnapshots, vehicles } from '../../db/schema'

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000

function moscowMonthStart(now = new Date()) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - MOSCOW_OFFSET_MS)
}

function moscowDayStart(daysAgo: number, now = new Date()) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS)
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysAgo) - MOSCOW_OFFSET_MS)
}

function daySeries(days: number, rows: Array<{ day: string, distance: unknown, fuelUsed: unknown, trips: unknown }>) {
  const values = new Map(rows.map(row => [row.day, {
    distance: Number(row.distance || 0),
    fuelUsed: Number(row.fuelUsed || 0),
    trips: Number(row.trips || 0)
  }]))
  const today = new Date(Date.now() + MOSCOW_OFFSET_MS)
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today)
    day.setUTCDate(today.getUTCDate() - (days - index - 1))
    const key = day.toISOString().slice(0, 10)
    return { day: key, ...(values.get(key) || { distance: 0, fuelUsed: 0, trips: 0 }) }
  })
}

export default defineEventHandler(async () => {
  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return {
    vehicle: null,
    snapshot: null,
    month: { distance: 0, fuelUsed: 0, consumption: null, trips: 0 },
    daily: [], today: { distance: 0, fuelUsed: 0 }, engine: { stationaryMinutes: 0, warmupMinutes: 0, sessions: 0 },
    refuels: { count: 0, litres: 0, recent: [] }, batteryTrend: [],
    fuelCost: { amount: null, refuels: 0, unknown: 0, pricePerLitre: null }
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
    fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
    trips: count()
  }).from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false), gte(trips.startedAt, dailyStart)))
    .groupBy(tripDay).orderBy(tripDay)

  const [engine] = await database.select({
    sessions: count(),
    stationaryMinutes: sql<number>`coalesce(sum(case when ${engineSessions.isStationary} = 1 then ${engineSessions.durationMinutes} else 0 end), 0)`,
    warmupMinutes: sql<number>`coalesce(sum(${engineSessions.warmupMinutes}), 0)`
  }).from(engineSessions).where(and(eq(engineSessions.vehicleId, vehicle.id), eq(engineSessions.isOpen, false), gte(engineSessions.startedAt, monthStart)))

  // The sum stays null until at least one refuel of the month has a price on it:
  // «0 ₽» would read as a month without fuel spending rather than one without
  // receipts. The litres are summed over the paid refuels only, so the price per
  // litre divides the same set of refuels it came from.
  const [refuelSummary] = await database.select({
    count: count(),
    litres: sql<number>`coalesce(sum(${refuelEvents.litresAdded}), 0)`,
    amount: sql<number | null>`sum(${refuelEvents.totalAmount})`,
    paidCount: sql<number>`coalesce(sum(case when ${refuelEvents.totalAmount} is not null then 1 else 0 end), 0)`,
    paidLitres: sql<number>`coalesce(sum(case when ${refuelEvents.totalAmount} is not null then ${refuelEvents.litresAdded} else 0 end), 0)`
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
  const refuelsCount = Number(refuelSummary?.count || 0)
  const paidRefuels = Number(refuelSummary?.paidCount || 0)
  const paidLitres = Number(refuelSummary?.paidLitres || 0)
  const fuelAmount = refuelSummary?.amount == null ? null : Number(refuelSummary.amount)
  const distance = Number(month?.distance || 0)
  const fuelUsed = Number(month?.fuelUsed || 0)
  const daily = daySeries(14, dailyRows)
  const todayMetrics = daily.at(-1) || { distance: 0, fuelUsed: 0 }
  return {
    vehicle,
    snapshot,
    month: { distance, fuelUsed, consumption: distance > 0 ? fuelUsed / distance * 100 : null, trips: Number(month?.trips || 0) },
    daily,
    today: { distance: todayMetrics.distance, fuelUsed: todayMetrics.fuelUsed },
    engine: {
      sessions: Number(engine?.sessions || 0),
      stationaryMinutes: Number(engine?.stationaryMinutes || 0),
      warmupMinutes: Number(engine?.warmupMinutes || 0)
    },
    refuels: { count: refuelsCount, litres: Number(refuelSummary?.litres || 0), recent: recentRefuels },
    batteryTrend: batteryRows.map(row => ({ day: row.day, min: Number(row.min), max: Number(row.max), average: Number(row.average) })),
    fuelCost: {
      amount: fuelAmount,
      refuels: paidRefuels,
      unknown: refuelsCount - paidRefuels,
      pricePerLitre: fuelAmount != null && paidLitres > 0 ? fuelAmount / paidLitres : null
    }
  }
})
