import { sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { engineSessions, refuelEvents } from '../db/schema'
import { measureStandstillFuel, MIN_STANDSTILL_HOURS } from '../shared/standstill-fuel'

const HOUR_MS = 60 * 60_000

// Уровень до и после каждой стоянки. Берётся из самих сессий: `fuel_end` —
// показание в момент выключения зажигания, `fuel_start` следующей — в момент
// включения. Ходить за ними в снапшоты незачем, там будут те же числа.
//
// Стоянка с заправкой посередине выбрасывается целиком: там уровень вырос по
// понятной причине, и мерить на ней убыль бессмысленно.
export async function standstillFuel(database: Database, vehicleId: number, start: Date, end: Date) {
  const gaps = await database.all<{ hours: number, delta: number }>(sql`
    with ordered as (
      select
        ${engineSessions.endedAt} as stopped_at,
        ${engineSessions.fuelEnd} as fuel_end,
        lead(${engineSessions.startedAt}) over (order by ${engineSessions.startedAt}) as started_at,
        lead(${engineSessions.fuelStart}) over (order by ${engineSessions.startedAt}) as fuel_start
      from ${engineSessions}
      where ${engineSessions.vehicleId} = ${vehicleId} and ${engineSessions.isOpen} = 0
    )
    select
      (started_at - stopped_at) * 1.0 / ${HOUR_MS} as hours,
      fuel_end - fuel_start as delta
    from ordered
    where started_at is not null and fuel_end is not null and fuel_start is not null
      and started_at - stopped_at >= ${MIN_STANDSTILL_HOURS * HOUR_MS}
      and stopped_at >= ${start.getTime()} and stopped_at < ${end.getTime()}
      and not exists (
        select 1 from ${refuelEvents}
        where ${refuelEvents.vehicleId} = ${vehicleId}
          and ${refuelEvents.detectedAt} between ordered.stopped_at and ordered.started_at
      )
  `)

  return measureStandstillFuel(gaps.map(row => ({ hours: Number(row.hours), delta: Number(row.delta) })))
}
