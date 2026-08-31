import { and, asc, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { refuelEvents, trips, vehicleSnapshots } from '../db/schema'
import { forecastRange } from '../shared/fuel-forecast'
import { fuelBalance } from '../shared/fuel'

const DAY_MS = 24 * 60 * 60_000

// Тридцать дней, а не календарный месяц: первого числа месячный расход посчитан
// по одному дню, а прогноз нужен и первого тоже.
const WINDOW_DAYS = 30

// Поездки, из которых берётся «обычная» и «дальняя», смотрят дальше: привычка
// ездить к родителям раз в месяц не должна пропадать из-за того, что в этот
// тридцатидневный отрезок такая поездка не попала.
const TRIPS_WINDOW_DAYS = 90

// Расход за окно считается по баку, а не по сумме поездок: датчик округляет, и
// у половины поездок расход тонет в шаге, а через бак не проходит ничего лишнего.
// Заправка неизвестного объёма отправляет расчёт обратно к поездкам — иначе её
// литры записались бы в сожжённые.
async function windowConsumption(database: Database, vehicleId: number, start: Date, end: Date) {
  const inRange = and(
    eq(vehicleSnapshots.vehicleId, vehicleId),
    isNotNull(vehicleSnapshots.fuel),
    gte(vehicleSnapshots.ts, start),
    lt(vehicleSnapshots.ts, end)
  )
  const [first, last, refuelled, distance] = await Promise.all([
    database.query.vehicleSnapshots.findFirst({ columns: { fuel: true }, where: inRange, orderBy: asc(vehicleSnapshots.ts) }),
    database.query.vehicleSnapshots.findFirst({ columns: { fuel: true }, where: inRange, orderBy: desc(vehicleSnapshots.ts) }),
    database.select({
      litres: sql<number>`coalesce(sum(coalesce(${refuelEvents.litresAdded}, ${refuelEvents.sensorLitresAdded})), 0)`,
      withoutVolume: sql<number>`coalesce(sum(case when ${refuelEvents.litresAdded} is null and ${refuelEvents.sensorLitresAdded} is null then 1 else 0 end), 0)`
    }).from(refuelEvents).where(and(
      eq(refuelEvents.vehicleId, vehicleId),
      gte(refuelEvents.detectedAt, start),
      lt(refuelEvents.detectedAt, end)
    )),
    database.select({
      km: sql<number>`coalesce(sum(${trips.distance}), 0)`,
      fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`
    }).from(trips).where(and(
      eq(trips.vehicleId, vehicleId),
      eq(trips.isOpen, false),
      gte(trips.startedAt, start),
      lt(trips.startedAt, end)
    ))
  ])

  const km = Number(distance[0]?.km || 0)
  if (!(km > 0)) return null
  const balance = fuelBalance({
    tankStart: first?.fuel ?? null,
    tankEnd: last?.fuel ?? null,
    refuelled: Number(refuelled[0]?.litres || 0),
    refuelsWithoutVolume: Number(refuelled[0]?.withoutVolume || 0),
    tripsFuelUsed: Number(distance[0]?.fuelUsed || 0)
  })
  return balance.fuelUsed > 0 ? balance.fuelUsed / km * 100 : null
}

// На сколько хватит бака — в километрах, в днях и в поездках.
export async function fuelForecast(database: Database, vehicleId: number, now = new Date()) {
  const start = new Date(now.getTime() - WINDOW_DAYS * DAY_MS)
  const latest = await database.query.vehicleSnapshots.findFirst({
    columns: { fuel: true },
    where: and(eq(vehicleSnapshots.vehicleId, vehicleId), isNotNull(vehicleSnapshots.fuel)),
    orderBy: desc(vehicleSnapshots.ts)
  })

  const day = sql<string>`strftime('%Y-%m-%d', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours')`
  const [days, distances] = await Promise.all([
    database.select({ day, km: sql<number>`coalesce(sum(${trips.distance}), 0)` })
      .from(trips).where(and(
        eq(trips.vehicleId, vehicleId),
        eq(trips.isOpen, false),
        gte(trips.startedAt, new Date(now.getTime() - TRIPS_WINDOW_DAYS * DAY_MS))
      )).groupBy(day),
    database.select({ distance: trips.distance }).from(trips).where(and(
      eq(trips.vehicleId, vehicleId),
      eq(trips.isOpen, false),
      isNotNull(trips.distance),
      gte(trips.startedAt, new Date(now.getTime() - TRIPS_WINDOW_DAYS * DAY_MS))
    ))
  ])

  const consumption = await windowConsumption(database, vehicleId, start, now)
  return {
    litres: latest?.fuel ?? null,
    consumption,
    ...forecastRange({
      litres: latest?.fuel ?? null,
      consumption,
      dailyDistances: days.map(row => Number(row.km || 0)),
      tripDistances: distances.map(row => Number(row.distance || 0))
    })
  }
}
