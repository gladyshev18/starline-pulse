import { and, asc, count, desc, eq, gte, isNotNull, lt, sql } from 'drizzle-orm'
import { createDatabase } from '../db/client'
import { refuelEvents, telegramRecipients, trips, vehicleSnapshots } from '../db/schema'
import { batteryHealth } from '../metrics/battery'
import { ambientTemperature, consumptionQuality, speedBreakdown } from '../metrics/consumption'
import { oilStatus } from '../metrics/engine'
import { fuelForecast } from '../metrics/forecast'
import { idleSummary, resolveFuelPrice } from '../metrics/idle'
import { operatingSummary } from '../metrics/operating'
import { ownershipSummary } from '../metrics/ownership'
import { standstillFuel } from '../metrics/standstill-fuel'
import { usageProfile } from '../metrics/usage'
import { costPerKilometre } from '../shared/consumption'
import { summariseByDriver } from '../shared/drivers'
import { fuelBalance } from '../shared/fuel'

// Материал для еженедельной подборки в Telegram: неделя, с чем её сравнить и
// что в ней выделяется. Скрипт ничего не пишет и никуда не отправляет — только
// печатает JSON, из которого потом собирается человеческий текст.
//
//   npx tsx scripts/weekly-facts.ts            — неделя с понедельника по сейчас
//   npx tsx scripts/weekly-facts.ts --last     — предыдущая полная неделя
//   npx tsx scripts/weekly-facts.ts --weeks=12 — глубина базы для сравнения

const MOSCOW_OFFSET_MS = 3 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const WEEK_MS = 7 * DAY_MS

const argument = (name: string) => process.argv.find(item => item.startsWith(`--${name}=`))?.split('=')[1]
const baselineWeeks = Math.max(2, Number(argument('weeks') || 8))
const wantLastWeek = process.argv.includes('--last')

const now = new Date()

function moscowMonday(moment: Date) {
  const shifted = new Date(moment.getTime() + MOSCOW_OFFSET_MS)
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - MOSCOW_OFFSET_MS
  return new Date(midnight - daysSinceMonday * DAY_MS)
}

const thisMonday = moscowMonday(now)
const start = wantLastWeek ? new Date(thisMonday.getTime() - WEEK_MS) : thisMonday
const end = wantLastWeek ? thisMonday : now
const previous = { start: new Date(start.getTime() - WEEK_MS), end: start }
const baseline = { start: new Date(start.getTime() - baselineWeeks * WEEK_MS), end: start }

const iso = (value: Date | null | undefined) => value ? value.toISOString() : null
const moscow = (value: Date | null | undefined) => value
  ? new Date(value.getTime() + MOSCOW_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16)
  : null
const round = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value) ? null : Number(value.toFixed(digits))

const database = createDatabase()
const vehicle = await database.query.vehicles.findFirst()
if (!vehicle) {
  console.log(JSON.stringify({ error: 'NO_VEHICLE' }))
  process.exit(0)
}

const closedTrips = (from: Date, to: Date) => and(
  eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false),
  gte(trips.startedAt, from), lt(trips.startedAt, to)
)

// Итоги отрезка ровно теми же формулами, что и на странице статистики: литры по
// балансу бака, километр — по этим литрам. Одна функция на неделю, на прошлую
// неделю и на базу для сравнения, иначе сравнивать было бы нечего.
async function period(from: Date, to: Date) {
  const [totals] = await database.select({
    trips: count(),
    distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
    tripsFuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
    minutes: sql<number>`coalesce(sum(case when ${trips.endedAt} is not null then (${trips.endedAt} - ${trips.startedAt}) / 60000.0 else 0 end), 0)`
  }).from(trips).where(closedTrips(from, to))

  const fuelScope = and(
    eq(vehicleSnapshots.vehicleId, vehicle!.id), isNotNull(vehicleSnapshots.fuel),
    gte(vehicleSnapshots.ts, from), lt(vehicleSnapshots.ts, to)
  )
  const [before, last, refuelled] = await Promise.all([
    database.query.vehicleSnapshots.findFirst({
      columns: { fuel: true },
      where: and(eq(vehicleSnapshots.vehicleId, vehicle!.id), isNotNull(vehicleSnapshots.fuel), lt(vehicleSnapshots.ts, from)),
      orderBy: desc(vehicleSnapshots.ts)
    }),
    database.query.vehicleSnapshots.findFirst({ columns: { fuel: true }, where: fuelScope, orderBy: desc(vehicleSnapshots.ts) }),
    database.select({
      events: count(),
      litres: sql<number>`coalesce(sum(coalesce(${refuelEvents.litresAdded}, ${refuelEvents.sensorLitresAdded})), 0)`,
      amount: sql<number>`coalesce(sum(${refuelEvents.totalAmount}), 0)`,
      withoutVolume: sql<number>`coalesce(sum(case when ${refuelEvents.litresAdded} is null and ${refuelEvents.sensorLitresAdded} is null then 1 else 0 end), 0)`
    }).from(refuelEvents).where(and(
      eq(refuelEvents.vehicleId, vehicle!.id), gte(refuelEvents.detectedAt, from), lt(refuelEvents.detectedAt, to)
    ))
  ])

  const distance = Number(totals?.distance || 0)
  const balance = fuelBalance({
    tankStart: before?.fuel ?? null,
    tankEnd: last?.fuel ?? null,
    refuelled: Number(refuelled[0]?.litres || 0),
    refuelsWithoutVolume: Number(refuelled[0]?.withoutVolume || 0),
    tripsFuelUsed: Number(totals?.tripsFuelUsed || 0)
  })
  const { pricePerLitre } = await resolveFuelPrice(database, vehicle!.id, from, to)
  const idle = await idleSummary(database, vehicle!.id, from, to)
  const days = Math.max(1, (to.getTime() - from.getTime()) / DAY_MS)

  return {
    from: iso(from),
    to: iso(to),
    days: round(days),
    trips: Number(totals?.trips || 0),
    distance: round(distance),
    distancePerWeek: round(distance / days * 7),
    hoursOnRoad: round(Number(totals?.minutes || 0) / 60),
    fuelUsed: round(balance.fuelUsed),
    fuelSource: balance.source,
    consumption: distance > 0 && balance.fuelUsed > 0 ? round(balance.fuelUsed / distance * 100) : null,
    pricePerLitre: round(pricePerLitre, 2),
    costPerKm: round(costPerKilometre(balance.fuelUsed, distance, pricePerLitre), 2),
    fuelCost: round(pricePerLitre == null ? null : balance.fuelUsed * pricePerLitre),
    refuels: Number(refuelled[0]?.events || 0),
    refuelledLitres: round(Number(refuelled[0]?.litres || 0)),
    refuelledAmount: round(Number(refuelled[0]?.amount || 0)),
    idle: {
      sessions: idle.sessions,
      minutes: round(idle.minutes),
      litres: round(idle.litres),
      cost: round(idle.cost),
      coldMinutes: round(idle.coldMinutes)
    }
  }
}

const [week, priorWeek, base] = await Promise.all([
  period(start, end),
  period(previous.start, previous.end),
  period(baseline.start, baseline.end)
])

// Поездки недели целиком: из них потом выбираются самая длинная, самая ранняя и
// всё прочее, что интересно назвать поимённо.
const weekTrips = await database.select({
  id: trips.id,
  startedAt: trips.startedAt,
  endedAt: trips.endedAt,
  distance: trips.distance,
  fuelUsed: trips.fuelUsed,
  driver: trips.driver,
  comment: trips.comment
}).from(trips).where(closedTrips(start, end)).orderBy(asc(trips.startedAt))

const described = weekTrips.map((trip) => {
  const minutes = trip.endedAt ? (trip.endedAt.getTime() - trip.startedAt.getTime()) / 60_000 : null
  const moscowStart = new Date(trip.startedAt.getTime() + MOSCOW_OFFSET_MS)
  return {
    id: trip.id,
    startedAt: moscow(trip.startedAt),
    endedAt: moscow(trip.endedAt),
    weekday: moscowStart.getUTCDay(),
    hour: moscowStart.getUTCHours(),
    minutes: round(minutes),
    distance: round(trip.distance),
    fuelUsed: round(trip.fuelUsed),
    speed: minutes && minutes > 0 && trip.distance ? round(trip.distance / (minutes / 60)) : null,
    driver: trip.driver,
    comment: trip.comment
  }
})

type DescribedTrip = typeof described[number]

const best = (rows: DescribedTrip[], value: (row: DescribedTrip) => number | null) => rows
  .filter(row => value(row) != null)
  .sort((left, right) => value(right)! - value(left)!)[0] || null

const spending = described.filter(trip => (trip.distance || 0) >= 10 && (trip.fuelUsed || 0) > 0)

const driverRows = await database.select({
  driver: trips.driver,
  trips: count(),
  distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
  fuelUsed: sql<number>`coalesce(sum(${trips.fuelUsed}), 0)`,
  minutes: sql<number>`coalesce(sum(case when ${trips.endedAt} is not null then (${trips.endedAt} - ${trips.startedAt}) / 60000.0 else 0 end), 0)`
}).from(trips).where(closedTrips(start, end)).groupBy(trips.driver)

// Неделя на фоне всей истории: рекорд по пробегу — это когда есть с чем
// сравнивать. Недели считаются от понедельника, как и сама подборка.
const weeklyHistory = await database.all<{ week: string, distance: number, trips: number }>(sql`
  select
    strftime('%Y-%W', ${trips.startedAt} / 1000, 'unixepoch', '+3 hours') as week,
    coalesce(sum(${trips.distance}), 0) as distance,
    count(*) as trips
  from ${trips}
  where ${trips.vehicleId} = ${vehicle.id} and ${trips.isOpen} = 0
  group by week order by week
`)

const weekDistances = weeklyHistory.map(row => Number(row.distance || 0))
const beaten = weekDistances.filter(value => value < (week.distance || 0)).length

const [lifetime] = await database.select({
  trips: count(),
  distance: sql<number>`coalesce(sum(${trips.distance}), 0)`,
  hours: sql<number>`coalesce(sum(case when ${trips.endedAt} is not null then (${trips.endedAt} - ${trips.startedAt}) / 3600000.0 else 0 end), 0)`,
  first: sql<number>`min(${trips.startedAt})`
}).from(trips).where(and(eq(trips.vehicleId, vehicle.id), eq(trips.isOpen, false)))

const [lifetimeRefuels] = await database.select({
  events: count(),
  litres: sql<number>`coalesce(sum(coalesce(${refuelEvents.litresAdded}, ${refuelEvents.sensorLitresAdded})), 0)`,
  amount: sql<number>`coalesce(sum(${refuelEvents.totalAmount}), 0)`
}).from(refuelEvents).where(eq(refuelEvents.vehicleId, vehicle.id))

const weekRefuels = await database.select({
  detectedAt: refuelEvents.detectedAt,
  litres: sql<number>`coalesce(${refuelEvents.litresAdded}, ${refuelEvents.sensorLitresAdded})`,
  amount: refuelEvents.totalAmount,
  price: refuelEvents.pricePerLitre,
  station: refuelEvents.stationName,
  brand: refuelEvents.station,
  fuelType: refuelEvents.fuelType
}).from(refuelEvents).where(and(
  eq(refuelEvents.vehicleId, vehicle.id), gte(refuelEvents.detectedAt, start), lt(refuelEvents.detectedAt, end)
)).orderBy(asc(refuelEvents.detectedAt))

// Цена литра за последние полгода: подборке интересно не «сколько стоит», а
// «дороже или дешевле, чем было».
const priceHistory = await database.select({
  detectedAt: refuelEvents.detectedAt,
  price: refuelEvents.pricePerLitre,
  station: refuelEvents.stationName
}).from(refuelEvents).where(and(
  eq(refuelEvents.vehicleId, vehicle.id), isNotNull(refuelEvents.pricePerLitre),
  gte(refuelEvents.detectedAt, new Date(end.getTime() - 182 * DAY_MS))
)).orderBy(asc(refuelEvents.detectedAt))

const snapshot = await database.query.vehicleSnapshots.findFirst({
  where: eq(vehicleSnapshots.vehicleId, vehicle.id),
  orderBy: desc(vehicleSnapshots.ts)
})

const recipients = await database.select({
  username: telegramRecipients.username,
  firstName: telegramRecipients.firstName
}).from(telegramRecipients).orderBy(asc(telegramRecipients.id))

const [usage, speed, quality, ambient, battery, standstill, operating, forecast, oil, ownership] = await Promise.all([
  usageProfile(database, vehicle.id, start, end, now),
  speedBreakdown(database, vehicle.id, start, end),
  consumptionQuality(database, vehicle.id, start, end),
  ambientTemperature(database, vehicle.id, start, end),
  batteryHealth(database, vehicle.id, new Date(end.getTime() - 120 * DAY_MS), end),
  standstillFuel(database, vehicle.id, start, end),
  operatingSummary(database, vehicle.id, baseline.start, end),
  fuelForecast(database, vehicle.id, now),
  oilStatus(database, vehicle.id, now),
  ownershipSummary(database, vehicle.id, start, end, { fuelPerKm: week.costPerKm, distance: week.distance || 0 })
])

const restingVolts = battery.readings.map(item => item.volts)

console.log(JSON.stringify({
  generatedAt: iso(now),
  vehicle: { alias: vehicle.alias },
  recipients,
  window: {
    from: iso(start),
    to: iso(end),
    label: wantLastWeek ? 'прошлая полная неделя' : 'текущая неделя с понедельника'
  },
  week,
  previousWeek: priorWeek,
  baseline: { ...base, weeks: baselineWeeks },
  records: {
    weeksOnRecord: weekDistances.length,
    weeksBeaten: beaten,
    isDistanceRecord: weekDistances.length > 2 && beaten === weekDistances.length - 1,
    longest: best(described, trip => trip.distance),
    longestByTime: best(described, trip => trip.minutes),
    fastest: best(described, trip => trip.speed),
    earliest: described.slice().sort((left, right) => left.hour - right.hour)[0] || null,
    latest: described.slice().sort((left, right) => right.hour - left.hour)[0] || null,
    thriftiest: best(spending, trip => -(trip.fuelUsed! / trip.distance!)),
    greediest: best(spending, trip => trip.fuelUsed! / trip.distance!)
  },
  trips: described,
  drivers: summariseByDriver(driverRows.map(row => ({
    driver: row.driver,
    trips: Number(row.trips || 0),
    distance: Number(row.distance || 0),
    fuelUsed: Number(row.fuelUsed || 0),
    minutes: Number(row.minutes || 0)
  }))),
  refuels: weekRefuels.map(row => ({
    at: moscow(row.detectedAt),
    litres: round(Number(row.litres)),
    amount: round(row.amount),
    price: round(row.price, 2),
    station: row.station,
    brand: row.brand,
    fuelType: row.fuelType
  })),
  priceHistory: priceHistory.map(row => ({ at: moscow(row.detectedAt), price: round(row.price, 2), station: row.station })),
  usage,
  speed,
  quality: { total: quality.total, measured: quality.measured, outliers: quality.outliers },
  ambient: { average: round(ambient.average), min: round(ambient.min), max: round(ambient.max), days: ambient.days },
  battery: {
    slopePerMonth: round(battery.slopePerMonth, 4),
    daysToWarning: battery.daysToWarning,
    confident: battery.confident,
    latest: round(restingVolts.at(-1) ?? null, 2),
    lowest: restingVolts.length ? round(Math.min(...restingVolts), 2) : null,
    nights: restingVolts.length
  },
  standstill,
  operating: operating.total,
  operatingWeeks: operating.periods.slice(-baselineWeeks),
  forecast,
  oil,
  ownership: {
    totalPerKm: round(ownership.totalPerKm, 2),
    fuelPerKm: round(ownership.fuelPerKm, 2),
    fixedPerKm: round(ownership.fixedPerKm, 2),
    service: round(ownership.service?.costPerKm ?? null, 2),
    fixedAmount: round(ownership.fixedAmount)
  },
  lifetime: {
    trips: Number(lifetime?.trips || 0),
    distance: round(Number(lifetime?.distance || 0)),
    hours: round(Number(lifetime?.hours || 0)),
    since: lifetime?.first ? moscow(new Date(Number(lifetime.first))) : null,
    refuels: Number(lifetimeRefuels?.events || 0),
    litres: round(Number(lifetimeRefuels?.litres || 0)),
    amount: round(Number(lifetimeRefuels?.amount || 0))
  },
  nowState: snapshot ? {
    at: moscow(snapshot.ts),
    online: snapshot.online,
    ignition: snapshot.ignition,
    armed: snapshot.armed,
    mileage: round(snapshot.mileage),
    fuel: round(snapshot.fuel),
    battery: round(snapshot.battery, 2),
    batteryType: snapshot.batteryType,
    cabinTemp: round(snapshot.cabinTemp),
    engineTemp: round(snapshot.engineTemp)
  } : null
}, null, 2))
