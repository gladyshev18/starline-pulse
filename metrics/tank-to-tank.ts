import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { refuelEvents, refuelReceipts, vehicleSnapshots } from '../db/schema'
import {
  summariseTankLegs,
  tankLegs,
  type TankLeg,
  type TankSummary,
  type TankWindow
} from '../shared/tank-to-tank'

// Заправок за всю жизнь машины — десятки, поэтому перегоны всегда строятся по
// всей истории целиком: месяц режется уже из готовой цепочки. Иначе перегон,
// начавшийся в прошлом месяце, пропал бы вместе с его километрами.
export async function loadTankLegs(database: Database, vehicleId: number): Promise<TankLeg[]> {
  const events = await database.select({
    id: refuelEvents.id,
    detectedAt: refuelEvents.detectedAt,
    mileage: refuelEvents.mileage,
    fuelAfter: refuelEvents.fuelAfter,
    percentAfter: refuelEvents.percentAfter,
    litresAdded: refuelEvents.litresAdded
  }).from(refuelEvents)
    .where(eq(refuelEvents.vehicleId, vehicleId))
    .orderBy(asc(refuelEvents.detectedAt))

  if (!events.length) return []

  const confirmations = await database.select({ refuelEventId: refuelReceipts.refuelEventId })
    .from(refuelReceipts)
    .where(and(
      inArray(refuelReceipts.refuelEventId, events.map(event => event.id)),
      inArray(refuelReceipts.matchStatus, ['auto', 'manual'])
    ))
  const confirmed = new Set(confirmations
    .map(row => row.refuelEventId)
    .filter((id): id is number => id != null))

  return tankLegs(events.map(event => ({ ...event, confirmed: confirmed.has(event.id) })))
}

// Показание одометра на краю окна. Строго до края, а не первое после него:
// километры, проеханные до полуночи, принадлежат ушедшему месяцу, даже если
// сигнализация рассказала о них уже в новом.
async function odometerBefore(database: Database, vehicleId: number, at: Date) {
  const row = await database.query.vehicleSnapshots.findFirst({
    columns: { mileage: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicleId),
      isNotNull(vehicleSnapshots.mileage),
      lt(vehicleSnapshots.ts, at)
    ),
    orderBy: desc(vehicleSnapshots.ts)
  })
  return row?.mileage ?? null
}

// У самого первого месяца истории «до начала» ничего нет, и единственное, чем
// можно закрыть его левый край, — первое показание внутри него.
async function odometerFrom(database: Database, vehicleId: number, start: Date, end: Date) {
  const row = await database.query.vehicleSnapshots.findFirst({
    columns: { mileage: true },
    where: and(
      eq(vehicleSnapshots.vehicleId, vehicleId),
      isNotNull(vehicleSnapshots.mileage),
      gte(vehicleSnapshots.ts, start),
      lt(vehicleSnapshots.ts, end)
    ),
    orderBy: asc(vehicleSnapshots.ts)
  })
  return row?.mileage ?? null
}

export async function tankWindowFor(
  database: Database,
  vehicleId: number,
  start: Date,
  end: Date
): Promise<TankWindow> {
  const [beforeStart, beforeEnd] = await Promise.all([
    odometerBefore(database, vehicleId, start),
    odometerBefore(database, vehicleId, end)
  ])
  return {
    startMileage: beforeStart ?? await odometerFrom(database, vehicleId, start, end),
    endMileage: beforeEnd
  }
}

// Расход окна от бака до бака: перегоны всей истории, обрезанные краями окна по
// одометру.
export async function tankConsumption(
  database: Database,
  vehicleId: number,
  start: Date,
  end: Date,
  legs?: TankLeg[]
): Promise<TankSummary> {
  const [window, resolved] = await Promise.all([
    tankWindowFor(database, vehicleId, start, end),
    legs ? Promise.resolve(legs) : loadTankLegs(database, vehicleId)
  ])
  return summariseTankLegs(resolved, window)
}

// Края одометра сразу для всех месяцев окна — одним запросом вместо двух на
// месяц, как это уже сделано для показаний бака в помесячных трендах.
export async function monthlyOdometerEdges(database: Database, vehicleId: number, start: Date, end: Date) {
  const month = sql`strftime('%Y-%m', ${vehicleSnapshots.ts} / 1000, 'unixepoch', '+3 hours')`
  const rows = await database.all<{ month: string, first_mileage: number | null, last_mileage: number | null }>(sql`
    with readings as (
      select
        ${month} as month,
        ${vehicleSnapshots.mileage} as mileage,
        row_number() over (partition by ${month} order by ${vehicleSnapshots.ts} asc) as from_start,
        row_number() over (partition by ${month} order by ${vehicleSnapshots.ts} desc) as from_end
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${vehicleId}
        and ${vehicleSnapshots.mileage} is not null
        and ${vehicleSnapshots.ts} >= ${start.getTime()}
        and ${vehicleSnapshots.ts} < ${end.getTime()}
    )
    select
      month,
      max(case when from_start = 1 then mileage end) as first_mileage,
      max(case when from_end = 1 then mileage end) as last_mileage
    from readings
    group by month
  `)

  return new Map<string, { first: number | null, last: number | null }>(rows.map(row => [String(row.month), {
    first: row.first_mileage == null ? null : Number(row.first_mileage),
    last: row.last_mileage == null ? null : Number(row.last_mileage)
  }]))
}

export { odometerBefore }
