import { and, count, desc, eq, gte, lt } from 'drizzle-orm'
import { trips } from '../../db/schema'
import { monthStatistics } from '../../metrics/statistics'
import { tripCost } from '../../shared/consumption'
import { currentMoscowMonth, moscowMonthRange } from '../../shared/moscow-month'
import { calculateTripMetrics } from '../../shared/trip-metrics'
import { moscowDayRange } from '../utils/moscow-day'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const page = Math.max(1, Number.parseInt(String(query.page || '1'), 10) || 1)
  const dayRange = moscowDayRange(query.day)
  const pageSize = 20
  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return { items: [], page, pageSize, total: 0, pages: 0, day: dayRange?.day || null }
  const where = and(
    eq(trips.vehicleId, vehicle.id),
    eq(trips.isOpen, false),
    ...(dayRange ? [gte(trips.startedAt, dayRange.start), lt(trips.startedAt, dayRange.end)] : [])
  )
  const [result] = await database.select({ total: count() }).from(trips).where(where)
  const rows = await database.select().from(trips).where(where).orderBy(desc(trips.startedAt)).limit(pageSize).offset((page - 1) * pageSize)

  // Километр стоит по-разному в разные месяцы, поэтому цена берётся у того
  // месяца, которому поездка принадлежит. Считает её та же `monthStatistics`,
  // что рисует страницу статистики: две страницы не должны называть разные
  // деньги за один и тот же август. На странице их от силы два, и каждый
  // считается один раз.
  const costPerKmByMonth = new Map<string, number | null>()
  for (const month of new Set(rows.map(trip => currentMoscowMonth(trip.startedAt)))) {
    const range = moscowMonthRange(month)
    if (!range) continue
    const statistics = await monthStatistics(database, range)
    costPerKmByMonth.set(month, statistics.totals.costPerKm)
  }

  const items = rows.map((trip) => {
    const metrics = calculateTripMetrics(trip)
    return {
      ...trip,
      ...metrics,
      cost: tripCost(metrics.distance, costPerKmByMonth.get(currentMoscowMonth(trip.startedAt)) ?? null)
    }
  })
  const total = Number(result?.total || 0)
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize), day: dayRange?.day || null }
})
