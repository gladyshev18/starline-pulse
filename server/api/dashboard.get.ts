import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { apiCalls, trips, vehicleSnapshots, vehicles } from '../../db/schema'

export default defineEventHandler(async () => {
  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return { vehicle: null, snapshot: null, month: { distance: 0, fuelUsed: 0, consumption: null }, api: { used: 0, remaining: 1000 } }

  const snapshot = await database.query.vehicleSnapshots.findFirst({
    where: eq(vehicleSnapshots.vehicleId, vehicle.id),
    orderBy: desc(vehicleSnapshots.ts)
  })
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const [month] = await database.select({
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`
  }).from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false), gte(trips.startedAt, monthStart)))
  const today = new Date().toISOString().slice(0, 10)
  const [api] = await database.select({ used: sql<number>`count(*)` }).from(apiCalls).where(eq(apiCalls.day, today))
  const distance = Number(month?.distance || 0)
  const fuelUsed = Number(month?.fuelUsed || 0)
  return {
    vehicle,
    snapshot,
    month: { distance, fuelUsed, consumption: distance > 0 ? fuelUsed / distance * 100 : null },
    api: { used: Number(api?.used || 0), remaining: Math.max(0, 1000 - Number(api?.used || 0)) }
  }
})
