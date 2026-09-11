import { sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { vehicleSnapshots } from '../db/schema'
import { assembleAmbientDays, type AmbientHour } from '../shared/ambient'
import { tyreWatch } from '../shared/tyres'

// Через сколько часов после остановки двигателя его датчик перестаёт мерить
// собственное тепло и начинает мерить воздух. Три часа выверены по архиву
// погоды: на двух часах оценка суток завышена почти на градус, на шести —
// занижена на полтора, потому что до дневных часов доживают только те сутки,
// когда машина вообще никуда не ездила.
const SOAK_MS = 3 * 60 * 60_000

// Окно графика. Два сезона смены шин в году, между ними полгода, и держать на
// экране больше четырёх месяцев незачем: перелом виден за недели, а не за год.
export const AMBIENT_WINDOW_DAYS = 120

const DAY_MS = 24 * 60 * 60_000

// Часовые средние по остывшему двигателю. Дальше из них собираются сутки — в
// JS, а не в SQL: неполные сутки надо восстанавливать по соседним, а это
// запросом не выражается.
//
// Прогретый двигатель из выборки убирают часы простоя, а не признак зажигания:
// короткий автозапуск опрос может проспать целиком, и тогда «зажигание
// выключено» будет стоять над горячим железом. Часы это переживают — один
// подогретый час среди двадцати сдвигает сутки на десятые доли.
export async function dailyAmbient(database: Database, vehicleId: number, start: Date, end: Date) {
  const rows = await database.all<AmbientHour>(sql`
    with soaked as (
      select
        ${vehicleSnapshots.ts} as ts,
        ${vehicleSnapshots.ignition} as ignition,
        ${vehicleSnapshots.engineTemp} as engine_temp,
        max(case when ${vehicleSnapshots.ignition} = 1 then ${vehicleSnapshots.ts} end)
          over (order by ${vehicleSnapshots.ts}) as last_on
      from ${vehicleSnapshots}
      where ${vehicleSnapshots.vehicleId} = ${vehicleId}
        and ${vehicleSnapshots.engineTemp} is not null
        and ${vehicleSnapshots.ts} >= ${start.getTime() - DAY_MS}
        and ${vehicleSnapshots.ts} < ${end.getTime()}
    )
    select
      strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+3 hours') as day,
      cast(strftime('%H', ts / 1000, 'unixepoch', '+3 hours') as integer) as hour,
      avg(engine_temp) as engine
    from soaked
    where ignition = 0
      and (last_on is null or ts - last_on >= ${SOAK_MS})
      and ts >= ${start.getTime()}
    group by day, hour
    order by day, hour
  `)

  return assembleAmbientDays(rows.map(row => ({
    day: String(row.day),
    hour: Number(row.hour),
    engine: Number(row.engine)
  })))
}

export type TyreOutlook = Awaited<ReturnType<typeof tyreOutlook>>

export async function tyreOutlook(database: Database, vehicleId: number, now = new Date()) {
  const daily = await dailyAmbient(database, vehicleId, new Date(now.getTime() - AMBIENT_WINDOW_DAYS * DAY_MS), now)
  return { daily, watch: tyreWatch(daily, now) }
}

export function emptyTyreOutlook(now = new Date()): TyreOutlook {
  return { daily: [], watch: tyreWatch([], now) }
}
