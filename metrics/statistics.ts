import { and, asc, count, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { refuelEvents, trips, vehicleSnapshots } from '../db/schema'
import { costPerKilometre, fuelCost, summariseBySpeed } from '../shared/consumption'
import { driverCoverage, summariseByDriver } from '../shared/drivers'
import { fuelBalance } from '../shared/fuel'
import { currentMoscowMonth, type MoscowMonthRange } from '../shared/moscow-month'
import { operatingRates } from '../shared/operating'
import { ownershipCost, serviceCostPerKilometre } from '../shared/ownership'
import { summariseCoverage } from '../shared/receipt-coverage'
import { isTankSummaryUsable, summariseTankLegs, type TankLeg } from '../shared/tank-to-tank'
import { summariseStandstill, summariseUsage } from '../shared/usage-profile'
import { summariseColdStarts } from '../shared/warmup'
import { ambientTemperature, consumptionQuality, speedBreakdown } from './consumption'
import { emptyFuelSpend, fuelSpend } from './fuel-spend'
import { emptyIdleSummary, idleSummary, resolveFuelPrice } from './idle'
import { operatingSummary } from './operating'
import { ownershipSummary } from './ownership'
import { loadTankLegs } from './tank-to-tank'
import { usageProfile } from './usage'
import { coldStarts } from './warmup'

type DailyRow = { day: string, distance: unknown, fuelUsed: unknown, trips: unknown }

// Откуда взят расход месяца. `tank` — от бака до бака, по чекам и одометру;
// остальные два — прежний баланс бака и сумма поездок, к которым приходится
// откатываться, пока заправок в месяце не набралось.
export type ConsumptionSource = 'tank' | 'balance' | 'trips' | 'none'

// Рубли приклеиваются к строке разбивки по её же литрам — см. `fuelCost`. Обе
// разбивки проходят через это, включая пустую статистику, иначе у страницы
// оказалось бы два разных набора полей на одно и то же место.
function priced<T extends { fuelUsed: number }>(rows: T[], pricePerLitre: number | null) {
  return rows.map(row => ({ ...row, cost: fuelCost(row.fuelUsed, pricePerLitre) }))
}

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

function emptyStatistics(range: MoscowMonthRange, now: Date) {
  return {
    month: range.month,
    currentMonth: currentMoscowMonth(now),
    vehicle: null,
    daily: fillMonth(range.month, range.days, []),
    odometer: [] as Array<{ day: string, mileage: number, edge: 'start' | 'end' }>,
    totals: {
      distance: 0,
      fuelUsed: 0,
      trips: 0,
      consumption: null,
      consumptionError: null,
      consumptionSource: 'none' as ConsumptionSource,
      fuelSource: 'trips' as const,
      tankStart: null,
      tankEnd: null,
      refuelled: 0,
      refuels: 0,
      tripsFuelUsed: 0,
      costPerKm: null,
      pricePerLitre: null
    },
    fuelSpend: emptyFuelSpend(),
    coverage: summariseCoverage([]),
    tank: { month: summariseTankLegs([]), overall: summariseTankLegs([]), legs: [] as TankLeg[] },
    idle: emptyIdleSummary(),
    coldStarts: summariseColdStarts([]),
    bySpeed: priced(summariseBySpeed([]), null),
    byDriver: priced(summariseByDriver([]), null),
    ambient: { average: null, min: null, max: null, days: 0, daily: [] },
    operating: {
      periods: [] as ReturnType<typeof operatingRates>,
      total: operatingRates([{ bucket: 'total', from: '', to: '', km: 0, motorMinutes: 0 }])[0]!
    },
    quality: { trips: [], total: 0, measured: 0, outliers: [] } as Awaited<ReturnType<typeof consumptionQuality>>,
    driverCoverage: driverCoverage([]),
    ownership: {
      ...ownershipCost({ fuelPerKm: null, servicePerKm: null, fixedAmount: 0, distance: 0 }),
      service: serviceCostPerKilometre([]),
      fixedAmount: 0,
      fixed: [] as Awaited<ReturnType<typeof ownershipSummary>>['fixed']
    },
    usage: {
      ...summariseUsage([]),
      standstill: summariseStandstill({ gaps: [], daysWithTrips: 0, daysCovered: 0 })
    }
  }
}

export type MonthStatistics = Awaited<ReturnType<typeof monthStatistics>>

// One month of the car's life, as both the statistics page and the Telegram bot
// report it. Keeping the arithmetic in a single place is what stops the two from
// quoting different numbers for the same August.
export async function monthStatistics(database: Database, range: MoscowMonthRange, now = new Date()) {
  const vehicle = await database.query.vehicles.findFirst()
  if (!vehicle) return emptyStatistics(range, now)

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

  const driverRows = await database.select({
    driver: trips.driver,
    trips: count(),
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
    minutes: sql<number>`coalesce(sum(case when ${trips.endedAt} is not null then (${trips.endedAt} - ${trips.startedAt}) / 60000.0 else 0 end), 0)`
  }).from(trips).where(and(
    eq(trips.vehicleId, vehicle.id),
    eq(trips.isOpen, false),
    gte(trips.startedAt, range.start),
    lt(trips.startedAt, range.end)
  )).groupBy(trips.driver)

  const mileageDay = sql<string>`strftime('%Y-%m-%d', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours')`
  const mileageRows = await database.select({
    day: mileageDay,
    first: sql<number>`min(${vehicleSnapshots.mileage})`,
    last: sql<number>`max(${vehicleSnapshots.mileage})`
  }).from(vehicleSnapshots).where(and(
    eq(vehicleSnapshots.vehicleId, vehicle.id),
    isNotNull(vehicleSnapshots.mileage),
    gte(vehicleSnapshots.ts, range.start),
    lt(vehicleSnapshots.ts, range.end)
  )).groupBy(mileageDay).orderBy(mileageDay)

  const previousMileage = await database.query.vehicleSnapshots.findFirst({
    columns: { mileage: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicle.id),
      isNotNull(vehicleSnapshots.mileage),
      lt(vehicleSnapshots.ts, range.start)
    ),
    orderBy: desc(vehicleSnapshots.ts)
  })

  const firstMileage = previousMileage?.mileage ?? (mileageRows[0] ? Number(mileageRows[0].first) : null)
  const odometer = firstMileage == null
    ? []
    : [
        { day: `${range.month}-01`, mileage: Number(firstMileage), edge: 'start' as const },
        ...mileageRows.map(row => ({ day: row.day, mileage: Number(row.last), edge: 'end' as const }))
      ]

  // The level the month starts from is the last reading before it, so nothing
  // burned in the gap between the final trip of one month and the first of the
  // next goes missing. Only a month that predates the recorded history has to
  // fall back to its own first reading.
  const previousFuel = await database.query.vehicleSnapshots.findFirst({
    columns: { fuel: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicle.id),
      isNotNull(vehicleSnapshots.fuel),
      lt(vehicleSnapshots.ts, range.start)
    ),
    orderBy: desc(vehicleSnapshots.ts)
  })
  const fuelRange = and(
    eq(vehicleSnapshots.vehicleId, vehicle.id),
    isNotNull(vehicleSnapshots.fuel),
    gte(vehicleSnapshots.ts, range.start),
    lt(vehicleSnapshots.ts, range.end)
  )
  const [firstFuel, lastFuel] = await Promise.all([
    database.query.vehicleSnapshots.findFirst({ columns: { fuel: true }, where: fuelRange, orderBy: asc(vehicleSnapshots.ts) }),
    database.query.vehicleSnapshots.findFirst({ columns: { fuel: true }, where: fuelRange, orderBy: desc(vehicleSnapshots.ts) })
  ])

  // Те же заправки строками: полноте учёта нужны литры каждой по отдельности —
  // залитое без чека и залитое с чеком считаются порознь.
  const refuelRows = await database.select({
    litresAdded: refuelEvents.litresAdded,
    sensorLitresAdded: refuelEvents.sensorLitresAdded,
    totalAmount: refuelEvents.totalAmount
  }).from(refuelEvents).where(and(
    eq(refuelEvents.vehicleId, vehicle.id),
    gte(refuelEvents.detectedAt, range.start),
    lt(refuelEvents.detectedAt, range.end)
  ))

  const [refuelled] = await database.select({
    events: count(),
    litres: sql<number>`coalesce(sum(coalesce(${refuelEvents.litresAdded}, ${refuelEvents.sensorLitresAdded})), 0)`,
    withoutVolume: sql<number>`coalesce(sum(case when ${refuelEvents.litresAdded} is null and ${refuelEvents.sensorLitresAdded} is null then 1 else 0 end), 0)`
  }).from(refuelEvents).where(and(
    eq(refuelEvents.vehicleId, vehicle.id),
    gte(refuelEvents.detectedAt, range.start),
    lt(refuelEvents.detectedAt, range.end)
  ))

  const daily = fillMonth(range.month, range.days, rows)
  const totals = daily.reduce((result, item) => ({
    distance: result.distance + item.distance,
    tripsFuelUsed: result.tripsFuelUsed + item.fuelUsed,
    trips: result.trips + item.trips
  }), { distance: 0, tripsFuelUsed: 0, trips: 0 })

  const balance = fuelBalance({
    tankStart: previousFuel?.fuel ?? firstFuel?.fuel ?? null,
    tankEnd: lastFuel?.fuel ?? null,
    refuelled: Number(refuelled?.litres || 0),
    refuelsWithoutVolume: Number(refuelled?.withoutVolume || 0),
    tripsFuelUsed: totals.tripsFuelUsed
  })

  // Расход от бака до бака. Края окна — те же показания одометра, что нарисованы
  // на графике выше: перегон, перевалившийся через первое число, делится между
  // месяцами по ним.
  const legs = await loadTankLegs(database, vehicle.id)
  const tankMonth = summariseTankLegs(legs, {
    startMileage: firstMileage == null ? null : Number(firstMileage),
    endMileage: mileageRows.at(-1) ? Number(mileageRows.at(-1)!.last) : null
  })
  const tankUsable = isTankSummaryUsable(tankMonth)
  const balanceConsumption = totals.distance > 0 ? balance.fuelUsed / totals.distance * 100 : null

  const { pricePerLitre } = await resolveFuelPrice(database, vehicle.id, range.start, range.end)
  const byDriver = summariseByDriver(driverRows.map(row => ({
    driver: row.driver,
    trips: Number(row.trips || 0),
    distance: Number(row.distance || 0),
    fuelUsed: Number(row.fuelUsed || 0),
    minutes: Number(row.minutes || 0)
  })))

  return {
    month: range.month,
    currentMonth: currentMoscowMonth(now),
    vehicle: { id: vehicle.id, alias: vehicle.alias },
    daily,
    odometer,
    totals: {
      distance: totals.distance,
      trips: totals.trips,
      fuelUsed: balance.fuelUsed,
      // Расход и израсходованное больше не одно делить на другое. Литры месяца —
      // это баланс бака, со всеми прогревами и с тем, что не досталось ни одной
      // поездке; расход — то, что машина пьёт на сотню, и мерить его уровнем
      // датчика в случайной точке шкалы незачем, когда есть два полных бака и
      // чек между ними.
      consumption: tankUsable ? tankMonth.consumption : balanceConsumption,
      consumptionError: tankUsable ? tankMonth.errorBound : null,
      consumptionSource: (tankUsable
        ? 'tank'
        : balanceConsumption == null ? 'none' : balance.source) as ConsumptionSource,
      fuelSource: balance.source,
      tankStart: balance.tankStart,
      tankEnd: balance.tankEnd,
      refuelled: balance.refuelled,
      refuels: Number(refuelled?.events || 0),
      tripsFuelUsed: totals.tripsFuelUsed,
      // Priced off the balance rather than the trips, so the kilometre carries
      // the idling and the litres no trip ever claimed.
      costPerKm: costPerKilometre(balance.fuelUsed, totals.distance, pricePerLitre),
      pricePerLitre
    },
    // Рубли по чекам месяца: сколько на самом деле заплачено за бензин. Это не
    // то же, что израсходовано, — залитое в конце месяца доедет до следующего.
    fuelSpend: await fuelSpend(database, vehicle.id, range.start, range.end),
    // Сколько из залитого вообще подтверждено чеком. Без этой доли сумма выше
    // читается как весь бензин месяца, хотя за половиной бака чека может не
    // быть вовсе.
    coverage: summariseCoverage(refuelRows, pricePerLitre),
    // Перегоны от заправки до заправки: и месячный итог, из которого взят расход
    // выше, и вся история разом — одного месяца на такую таблицу мало, там от
    // силы пять строк, а разброс между ними виден только на фоне остальных.
    tank: { month: tankMonth, overall: summariseTankLegs(legs), legs },
    // Стояние с заведённым двигателем — отдельная строка топливного бюджета, а
    // не мелочь: прогревы жгут литры, которые не увезли машину никуда, и в
    // расходе на сотню они растворяются без следа.
    idle: await idleSummary(database, vehicle.id, range.start, range.end),
    // Холодных пусков за месяц и сколько их пришлось на тысячу километров.
    // Именно они изнашивают двигатель, а не километры сами по себе.
    coldStarts: await coldStarts(database, vehicle.id, range.start, range.end),
    // Литры здесь — по завершённым поездкам, а не по баку: прогревы и то, что
    // не досталось ни одной поездке, за руль никто не сажал.
    byDriver: priced(byDriver, pricePerLitre),
    // Какая часть этого пробега вообще имеет водителя. Без неё две строки в
    // таблице читаются как весь месяц.
    driverCoverage: driverCoverage(byDriver),
    bySpeed: priced(await speedBreakdown(database, vehicle.id, range.start, range.end), pricePerLitre),
    ambient: await ambientTemperature(database, vehicle.id, range.start, range.end),
    // Километры на моточас считаются по счётчику сигнализации и одометру, а не
    // по журналу поездок: это независимая от него величина, и в том её польза —
    // если разложение пробега по поездкам поедет, она останется на месте.
    operating: await operatingSummary(database, vehicle.id, range.start, range.end),
    quality: await consumptionQuality(database, vehicle.id, range.start, range.end),
    usage: await usageProfile(database, vehicle.id, range.start, range.end, now),
    // Километр целиком: к топливу добавляются заказ-наряды и постоянные
    // расходы. Топливная часть берётся ровно та же, что в `totals.costPerKm`, —
    // иначе на одной странице оказалось бы две цены одного километра.
    ownership: await ownershipSummary(database, vehicle.id, range.start, range.end, {
      fuelPerKm: costPerKilometre(balance.fuelUsed, totals.distance, pricePerLitre),
      distance: totals.distance
    })
  }
}
