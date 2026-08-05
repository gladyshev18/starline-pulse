import { and, count, desc, eq, gte, lt } from 'drizzle-orm'
import { trips } from '../../db/schema'
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
  const items = await database.select().from(trips).where(where).orderBy(desc(trips.startedAt)).limit(pageSize).offset((page - 1) * pageSize)
  const total = Number(result?.total || 0)
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize), day: dayRange?.day || null }
})
