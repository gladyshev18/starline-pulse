import { and, count, eq, gte, lt, sql } from 'drizzle-orm'
import { trips } from '../../db/schema'
import { currentMoscowMonth, moscowMonthRange } from '../utils/moscow-month'

type DailyRow = { day: string, distance: unknown, fuelUsed: unknown, trips: unknown }

function fillMonth(month: string, days: number, rows: DailyRow[]) {
  const values = new Map(rows.map(row => [row.day, {
    distance: Number(row.distance || 0),
    fuelUsed: Number(row.fuelUsed || 0),
    trips: Number(row.trips || 0)
  }]))

  return Array.from({ length: days }, (_, index) => {
    const day = `${month}-${String(index + 1).padStart(2, '0')}`
    return { day, ...(values.get(day) || { distance: 0, fuelUsed: 0, trips: 0 }) }
  })
}

export default defineEventHandler(async (event) => {
  const requestedMonth = getQuery(event).month
  const range = moscowMonthRange(requestedMonth)
  if (!range || (requestedMonth != null && requestedMonth !== range.month)) {
    throw createError({ statusCode: 400, statusMessage: 'Месяц должен быть указан в формате ГГГГ-ММ' })
  }

  const database = useAppDatabase()
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return {
    month: range.month,
    currentMonth: currentMoscowMonth(),
    daily: fillMonth(range.month, range.days, []),
    totals: { distance: 0, fuelUsed: 0, trips: 0, consumption: null }
  }

  const tripDay = sql<string>`strftime('%Y-%m-%d', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours')`
  const rows = await database.select({
    day: tripDay,
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
    trips: count()
  }).from(trips).where(and(
    eq(trips.vehicleId, vehicle.id),
    eq(trips.isOpen, false),
    gte(trips.startedAt, range.start),
    lt(trips.startedAt, range.end)
  )).groupBy(tripDay).orderBy(tripDay)

  const daily = fillMonth(range.month, range.days, rows)
  const totals = daily.reduce((result, item) => ({
    distance: result.distance + item.distance,
    fuelUsed: result.fuelUsed + item.fuelUsed,
    trips: result.trips + item.trips
  }), { distance: 0, fuelUsed: 0, trips: 0 })

  return {
    month: range.month,
    currentMonth: currentMoscowMonth(),
    daily,
    totals: {
      ...totals,
      consumption: totals.distance > 0 ? totals.fuelUsed / totals.distance * 100 : null
    }
  }
})
