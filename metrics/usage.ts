import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { trips } from '../db/schema'
import { summariseStandstill, summariseUsage } from '../shared/usage-profile'

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

// Промежуток длиннее этого — не простой между поездками, а край выборки:
// первая поездка месяца отсчитывалась бы от начала времён.
const MAX_GAP_DAYS = 60

const moscowHour = sql<number>`cast(strftime('%H', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours') as integer)`
const moscowWeekday = sql<number>`cast(strftime('%w', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours') as integer)`
const moscowDay = sql<string>`strftime('%Y-%m-%d', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours')`

// Когда машиной пользуются и сколько она стоит между поездками. Считается по
// журналу поездок, а не по снапшотам: вопрос здесь не «работал ли двигатель», а
// «поехали ли», и ответ на него — сама поездка.
export async function usageProfile(database: Database, vehicleId: number, start: Date, end: Date, now = new Date()) {
  const scope = and(
    eq(trips.vehicleId, vehicleId),
    eq(trips.isOpen, false),
    gte(trips.startedAt, start),
    lt(trips.startedAt, end)
  )

  const cells = await database.select({
    weekday: moscowWeekday,
    hour: moscowHour,
    trips: sql<number>`count(*)`,
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`
  }).from(trips).where(scope).groupBy(moscowWeekday, moscowHour)

  // Простой меряется от конца предыдущей поездки, каким бы месяцем та ни была:
  // машина, простоявшая с тридцать первого июля, простояла именно столько, а не
  // «первого августа впервые поехала».
  const gapRows = await database.all<{ gap: number }>(sql`
    with ordered as (
      select
        ${trips.startedAt} as started_at,
        lag(${trips.endedAt}) over (order by ${trips.startedAt}) as previous_end
      from ${trips}
      where ${trips.vehicleId} = ${vehicleId} and ${trips.isOpen} = 0
    )
    select (started_at - previous_end) * 1.0 / ${HOUR_MS} as gap
    from ordered
    where previous_end is not null
      and started_at >= ${start.getTime()} and started_at < ${end.getTime()}
      and started_at - previous_end between 0 and ${MAX_GAP_DAYS * DAY_MS}
  `)

  const [days] = await database.select({ days: sql<number>`count(distinct ${moscowDay})` }).from(trips).where(scope)

  // Месяц считается по прожитой его части: в текущем месяце «шесть дней без
  // поездок» из тридцати одного означало бы, что двадцать будущих дней машина
  // уже простояла.
  const covered = Math.min(end.getTime(), Math.max(start.getTime(), now.getTime())) - start.getTime()

  return {
    ...summariseUsage(cells.map(row => ({
      weekday: Number(row.weekday),
      hour: Number(row.hour),
      trips: Number(row.trips || 0),
      distance: Number(row.distance || 0)
    }))),
    standstill: summariseStandstill({
      gaps: gapRows.map(row => Number(row.gap)),
      daysWithTrips: Number(days?.days || 0),
      daysCovered: Math.ceil(covered / DAY_MS)
    })
  }
}
