import { and, asc, count, desc, eq, gte, isNotNull, lt } from 'drizzle-orm'
import { telegramRecipients, trips } from '../../db/schema'
import { monthStatistics } from '../../metrics/statistics'
import { tripCost } from '../../shared/consumption'
import { consumptionErrorBound, type TripConsumptionQuality } from '../../shared/consumption-confidence'
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
  if (!vehicle) return { items: [], page, pageSize, total: 0, pages: 0, day: dayRange?.day || null, drivers: [] as string[] }
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
  //
  // Оттуда же берётся и оценка достоверности расхода: выброс меряется от медианы
  // своей корзины за весь месяц, а не за двадцать поездок этой страницы, иначе
  // одна и та же поездка на разных страницах оказывалась бы то нормальной, то
  // выбивающейся.
  const costPerKmByMonth = new Map<string, number | null>()
  const qualityByTrip = new Map<number, TripConsumptionQuality>()
  for (const month of new Set(rows.map(trip => currentMoscowMonth(trip.startedAt)))) {
    const range = moscowMonthRange(month)
    if (!range) continue
    const statistics = await monthStatistics(database, range)
    costPerKmByMonth.set(month, statistics.totals.costPerKm)
    for (const item of statistics.quality.trips) qualityByTrip.set(item.id, item)
  }

  const items = rows.map((trip) => {
    const metrics = calculateTripMetrics(trip)
    const quality = qualityByTrip.get(trip.id)
    return {
      ...trip,
      ...metrics,
      cost: tripCost(metrics.distance, costPerKmByMonth.get(currentMoscowMonth(trip.startedAt)) ?? null),
      // Граница ошибки расхода этой поездки и причины, по которым её число не
      // стоит читать как измерение.
      consumptionErrorBound: quality?.errorBound ?? consumptionErrorBound(metrics.distance),
      doubts: quality?.doubts ?? [],
      outlier: quality?.outlier ?? false,
      deviation: quality?.deviation ?? null
    }
  })
  const total = Number(result?.total || 0)
  return { items, page, pageSize, total, pages: Math.ceil(total / pageSize), day: dayRange?.day || null, drivers: await knownDrivers(database, vehicle.id) }
})

// Кого предлагать в списке «за рулём». Имена берутся из двух источников сразу:
// из получателей Telegram, потому что именно их бот показывает кнопками, и из
// уже проставленных ответов — иначе тот, кого убрали из чата, исчез бы и из
// выбора, а его прошлые поездки остались бы неисправимыми.
async function knownDrivers(database: ReturnType<typeof useAppDatabase>, vehicleId: number) {
  const [recipients, answered] = await Promise.all([
    database.select({ username: telegramRecipients.username, firstName: telegramRecipients.firstName })
      .from(telegramRecipients).orderBy(asc(telegramRecipients.id)),
    database.selectDistinct({ driver: trips.driver }).from(trips)
      .where(and(eq(trips.vehicleId, vehicleId), isNotNull(trips.driver)))
  ])
  const names = [
    ...recipients.map(item => item.firstName?.trim() || item.username.replace(/^@/, '')),
    ...answered.map(item => item.driver?.trim() ?? '')
  ].filter(Boolean)
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, 'ru'))
}
