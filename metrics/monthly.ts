import { and, asc, count, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { refuelEvents, trips, vehicleSnapshots } from '../db/schema'
import { costPerKilometre } from '../shared/consumption'
import { fuelBalance } from '../shared/fuel'
import { summariseFuelSpend } from '../shared/fuel-spend'
import { currentMoscowMonth, moscowMonthRange, shiftMonth } from '../shared/moscow-month'
import { isTankSummaryUsable, summariseTankLegs } from '../shared/tank-to-tank'
import { loadTankLegs, monthlyOdometerEdges, odometerBefore } from './tank-to-tank'

// Дальше двух лет назад график не нужен: столько данных у этой машины и нет, а
// ось из тридцати подписей всё равно нечитаема.
const MAX_MONTHS = 24

export interface MonthlyPoint {
  month: string
  distance: number
  trips: number
  fuelUsed: number
  fuelSource: 'balance' | 'trips'
  // Расход от бака до бака, если заправки накрыли месяц; иначе — прежний баланс.
  // Одна и та же величина на карточке месяца и в этой линии обязана считаться
  // одинаково, иначе график спорит с числом, на которое смотрит.
  consumption: number | null
  consumptionSource: 'tank' | 'balance' | 'trips' | 'none'
  // Рубли по чекам месяца — и число заправок, которые в них не попали: без него
  // сумма месяца выглядит полной, хотя половина бака в неё не вошла.
  spend: number | null
  refuels: number
  unpaidRefuels: number
  // Цена литра только своя, месячная: у месяца без чеков её нет, и линия
  // графика в этом месте честно рвётся, а не тянет прошлогоднюю цену.
  pricePerLitre: number | null
  // А вот километр считается по той же цене, что и карточка месяца, — с
  // подстановкой последней известной. Иначе одна и та же страница называла бы
  // две цены одного километра.
  costPerKm: number | null
}

interface MonthFuel {
  first: number | null
  last: number | null
}

async function earliestDataMonth(database: Database, vehicleId: number) {
  const [firstTrip] = await database.select({ ts: sql<number | null>`min(${trips.startedAt})` })
    .from(trips).where(eq(trips.vehicleId, vehicleId))
  const [firstSnapshot] = await database.select({ ts: sql<number | null>`min(${vehicleSnapshots.ts})` })
    .from(vehicleSnapshots).where(eq(vehicleSnapshots.vehicleId, vehicleId))

  const timestamps = [firstTrip?.ts, firstSnapshot?.ts].filter((value): value is number => value != null)
  if (!timestamps.length) return null
  return currentMoscowMonth(new Date(Math.min(...timestamps)))
}

// Первое и последнее показание бака каждого месяца — одним запросом вместо двух
// на месяц. Номер строки внутри месяца считается в обе стороны, поэтому оба
// края достаются одной группировкой.
async function monthlyFuelReadings(database: Database, vehicleId: number, start: Date, end: Date) {
  const month = sql`strftime('%Y-%m', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours')`
  const rows = await database.all<{ month: string, first_fuel: number | null, last_fuel: number | null }>(sql`
    with readings as (
      select
        ${month} as month,
        ${vehicleSnapshots.fuel} as fuel,
        row_number() over (partition by ${month} order by ${vehicleSnapshots.ts} asc) as from_start,
        row_number() over (partition by ${month} order by ${vehicleSnapshots.ts} desc) as from_end
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${vehicleId}
        and ${vehicleSnapshots.fuel} is not null
        and ${vehicleSnapshots.ts} >= ${start.getTime()}
        and ${vehicleSnapshots.ts} < ${end.getTime()}
    )
    select
      month,
      max(case when from_start = 1 then fuel end) as first_fuel,
      max(case when from_end = 1 then fuel end) as last_fuel
    from readings
    group by month
  `)

  return new Map<string, MonthFuel>(rows.map(row => [String(row.month), {
    first: row.first_fuel == null ? null : Number(row.first_fuel),
    last: row.last_fuel == null ? null : Number(row.last_fuel)
  }]))
}

export type MonthlyTrends = Awaited<ReturnType<typeof monthlyTrends>>

// Те же величины, что и на карточках одного месяца, но выстроенные в ряд: месяц
// к месяцу видно то, чего внутри месяца не видно вовсе, — куда поехала цена
// литра, дорожает ли километр и стало ли машины в жизни больше, чем год назад.
//
// Считается не двенадцатью вызовами месячной статистики, а несколькими
// групповыми запросами: тяжёлые разборы — по корзинам скорости, по часам, по
// достоверности расхода — помесячному графику не нужны.
export async function monthlyTrends(database: Database, now = new Date()) {
  const currentMonth = currentMoscowMonth(now)
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return { currentMonth, months: [] as MonthlyPoint[] }

  const earliest = await earliestDataMonth(database, vehicle.id)
  if (!earliest) return { currentMonth, months: [] as MonthlyPoint[] }

  const from = [earliest, shiftMonth(currentMonth, -(MAX_MONTHS - 1))].sort().at(-1)!
  const months: string[] = []
  for (let month = from; month <= currentMonth; month = shiftMonth(month, 1)) months.push(month)

  const start = moscowMonthRange(months[0])!.start
  const end = moscowMonthRange(months.at(-1))!.end

  const tripMonth = sql<string>`strftime('%Y-%m', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours')`
  const tripRows = await database.select({
    month: tripMonth,
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
    trips: count()
  }).from(trips).where(and(
    eq(trips.vehicleId, vehicle.id),
    eq(trips.isOpen, false),
    gte(trips.startedAt, start),
    lt(trips.startedAt, end)
  )).groupBy(tripMonth)
  const tripsByMonth = new Map(tripRows.map(row => [row.month, {
    distance: Number(row.distance || 0),
    fuelUsed: Number(row.fuelUsed || 0),
    trips: Number(row.trips || 0)
  }]))

  // Заправок за два года — десятки, поэтому они разбираются строками: сумму,
  // литры и цену месяца собирает тот же код, что и карточку месяца.
  const refuelRows = await database.select({
    detectedAt: refuelEvents.detectedAt,
    litresAdded: refuelEvents.litresAdded,
    sensorLitresAdded: refuelEvents.sensorLitresAdded,
    totalAmount: refuelEvents.totalAmount,
    pricePerLitre: refuelEvents.pricePerLitre
  }).from(refuelEvents).where(and(
    eq(refuelEvents.vehicleId, vehicle.id),
    gte(refuelEvents.detectedAt, start),
    lt(refuelEvents.detectedAt, end)
  )).orderBy(asc(refuelEvents.detectedAt))
  const refuelsByMonth = new Map<string, typeof refuelRows>()
  for (const row of refuelRows) {
    const month = currentMoscowMonth(row.detectedAt)
    const bucket = refuelsByMonth.get(month) ?? []
    bucket.push(row)
    refuelsByMonth.set(month, bucket)
  }

  const fuelByMonth = await monthlyFuelReadings(database, vehicle.id, start, end)
  const odometerByMonth = await monthlyOdometerEdges(database, vehicle.id, start, end)
  const legs = await loadTankLegs(database, vehicle.id)

  // Уровень, с которого месяц начинается, — последнее показание до него, как и
  // в месячной статистике. Для всех месяцев окна, кроме первого, им окажется
  // последнее показание предыдущего месяца, и оно переносится по циклу.
  const previousFuel = await database.query.vehicleSnapshots.findFirst({
    columns: { fuel: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicle.id),
      isNotNull(vehicleSnapshots.fuel),
      lt(vehicleSnapshots.ts, start)
    ),
    orderBy: desc(vehicleSnapshots.ts)
  })
  const previousPrice = await database.query.refuelEvents.findFirst({
    columns: { pricePerLitre: true },
    where: and(
      eq(refuelEvents.vehicleId, vehicle.id),
      isNotNull(refuelEvents.pricePerLitre),
      lt(refuelEvents.detectedAt, start)
    ),
    orderBy: desc(refuelEvents.detectedAt)
  })

  let carriedFuel = previousFuel?.fuel ?? null
  let carriedPrice = previousPrice?.pricePerLitre ?? null
  // Одометр на начало месяца — последнее показание до него, дальше по циклу им
  // становится конец предыдущего месяца. Тем же способом, что и уровень бака.
  let carriedMileage = await odometerBefore(database, vehicle.id, start)

  const points = months.map((month): MonthlyPoint => {
    const monthTrips = tripsByMonth.get(month) ?? { distance: 0, fuelUsed: 0, trips: 0 }
    const refuels = refuelsByMonth.get(month) ?? []
    const readings = fuelByMonth.get(month)

    const spend = summariseFuelSpend(refuels)
    const balance = fuelBalance({
      tankStart: carriedFuel ?? readings?.first ?? null,
      tankEnd: readings?.last ?? null,
      refuelled: refuels.reduce((sum, row) => sum + (row.litresAdded ?? row.sensorLitresAdded ?? 0), 0),
      refuelsWithoutVolume: refuels.filter(row => row.litresAdded == null && row.sensorLitresAdded == null).length,
      tripsFuelUsed: monthTrips.fuelUsed
    })
    if (readings?.last != null) carriedFuel = readings.last

    const odometer = odometerByMonth.get(month)
    const tank = summariseTankLegs(legs, {
      startMileage: carriedMileage ?? odometer?.first ?? null,
      endMileage: odometer?.last ?? null
    })
    if (odometer?.last != null) carriedMileage = odometer.last
    const tankUsable = isTankSummaryUsable(tank)
    const balanceConsumption = monthTrips.distance > 0 ? balance.fuelUsed / monthTrips.distance * 100 : null

    // Цена «последней известной» ищется до конца месяца, а не до его начала, —
    // ровно как её ищет карточка месяца.
    const lastPriced = refuels.filter(row => row.pricePerLitre != null).at(-1)
    if (lastPriced?.pricePerLitre != null) carriedPrice = lastPriced.pricePerLitre

    return {
      month,
      distance: monthTrips.distance,
      trips: monthTrips.trips,
      fuelUsed: balance.fuelUsed,
      fuelSource: balance.source,
      consumption: tankUsable ? tank.consumption : balanceConsumption,
      consumptionSource: tankUsable ? 'tank' : balanceConsumption == null ? 'none' : balance.source,
      spend: spend.amount,
      refuels: spend.total,
      unpaidRefuels: spend.unknown,
      pricePerLitre: spend.pricePerLitre,
      costPerKm: costPerKilometre(balance.fuelUsed, monthTrips.distance, spend.pricePerLitre ?? carriedPrice)
    }
  })

  return { currentMonth, months: points }
}
