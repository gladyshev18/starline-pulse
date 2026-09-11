import { sql } from 'drizzle-orm'
import type { Database } from '../db/client'
import { vehicleSnapshots } from '../db/schema'
import { ambientFromEngine, nightAmbientFromEngine, tyreWatch, type AmbientDay } from '../shared/tyres'

// Через сколько часов после остановки двигателя его датчик перестаёт мерить
// собственное тепло и начинает мерить воздух. Три часа выверены по архиву
// погоды: на двух часах оценка суток завышена почти на градус, на шести —
// занижена на полтора, потому что до дневных часов доживают только те сутки,
// когда машина вообще никуда не ездила.
const SOAK_MS = 3 * 60 * 60_000

// Сколько разных часов суток должно попасть в среднюю и сколько из них — в
// каждую половину суток. Без второго условия сутки, когда машина весь день была
// в разъездах и остыла только к ночи, дали бы «среднесуточную» по одной ночи.
const MIN_HOURS = 8
const MIN_HOURS_PER_HALF = 3

// Окно графика. Два сезона смены шин в году, между ними полгода, и держать на
// экране больше четырёх месяцев незачем: перелом виден за недели, а не за год.
export const AMBIENT_WINDOW_DAYS = 120

const DAY_MS = 24 * 60 * 60_000

interface AmbientRow {
  day: string
  engine: number
  night: number
  hours: number
  firstHalf: number
  secondHalf: number
}

// Среднесуточная температура воздуха по датчику двигателя. Средняя считается по
// часам, а не по замерам: стоящую машину опрашивают чаще, чем едущую, и ночь
// иначе перетянула бы сутки на себя градуса на три.
//
// Прогретый двигатель из выборки убирают часы простоя, а не признак зажигания:
// короткий автозапуск опрос может проспать целиком, и тогда «зажигание
// выключено» будет стоять над горячим железом. Часы это переживают — один
// подогретый час среди двадцати сдвигает сутки на десятые доли.
export async function dailyAmbient(database: Database, vehicleId: number, start: Date, end: Date) {
  const rows = await database.all<AmbientRow>(sql`
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
    ),
    hourly as (
      select
        strftime('%Y-%m-%d', ts / 1000, 'unixepoch', '+3 hours') as day,
        cast(strftime('%H', ts / 1000, 'unixepoch', '+3 hours') as integer) as hour,
        avg(engine_temp) as engine
      from soaked
      where ignition = 0
        and (last_on is null or ts - last_on >= ${SOAK_MS})
        and ts >= ${start.getTime()}
      group by day, hour
    )
    select
      day,
      avg(engine) as engine,
      count(*) as hours,
      sum(case when hour < 12 then 1 else 0 end) as "firstHalf",
      sum(case when hour >= 12 then 1 else 0 end) as "secondHalf",
      -- Ночь с двух до семи: раньше двигатель ещё отдаёт вечернее тепло, позже
      -- уже встаёт солнце. Если в эти часы машина ездила, за минимум суток
      -- сходит самый холодный из оставшихся — он не ниже настоящего.
      coalesce(min(case when hour between 2 and 7 then engine end), min(engine)) as night
    from hourly
    group by day
    order by day
  `)

  return rows
    .filter(row => Number(row.hours) >= MIN_HOURS
      && Number(row.firstHalf) >= MIN_HOURS_PER_HALF
      && Number(row.secondHalf) >= MIN_HOURS_PER_HALF)
    .map<AmbientDay>(row => ({
      day: String(row.day),
      mean: ambientFromEngine(Number(row.engine)),
      night: nightAmbientFromEngine(Number(row.night)),
      hours: Number(row.hours)
    }))
}

export type TyreOutlook = Awaited<ReturnType<typeof tyreOutlook>>

export async function tyreOutlook(database: Database, vehicleId: number, now = new Date()) {
  const daily = await dailyAmbient(database, vehicleId, new Date(now.getTime() - AMBIENT_WINDOW_DAYS * DAY_MS), now)
  return { daily, watch: tyreWatch(daily, now) }
}

export function emptyTyreOutlook(now = new Date()): TyreOutlook {
  return { daily: [], watch: tyreWatch([], now) }
}
